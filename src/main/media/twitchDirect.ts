import { net } from 'electron'
import { Errors } from '../../shared/errors.js'
import { TwitchAdapter } from '../platforms/twitch.js'
import type { RawInfo } from './resolver.js'
import type { UrlMatch } from '../platforms/types.js'
import type { Logger } from '../services/logger.js'
import { durationFromPlaylist, parseMaster } from './hls.js'
import { fetchText } from './http.js'

/**
 * Read a Twitch VOD straight from Twitch's own web API, no yt-dlp process.
 *
 * Twitch is the one platform where owning this is both worthwhile and small.
 * Playback needs a signed access token from `gql.twitch.tv`, which is then
 * appended to the usher master-playlist URL — and this codebase *already*
 * calls that endpoint with that client id for profiles and for bulk video
 * dates (see `streamerProfile.ts`). This is an extension of working code, not
 * a new capability, and it removes a process spawn and a couple of seconds
 * from every Twitch resolve.
 *
 * Contrast YouTube, which is deliberately left to yt-dlp: signature ciphers
 * that change without notice, `n`-parameter throttling and PO tokens are an
 * adversarial moving target with a fifteen-thousand-line extractor and a
 * community maintaining it. Owning that means the app breaks on a Tuesday.
 *
 * Requests here go out through Chromium's network stack — the same requests
 * the site's own player makes, to its own public endpoints, with its own
 * public web client id. Nothing is bypassed: subscriber-only and unavailable
 * VODs are reported, not worked around.
 */

/** Twitch's public web client id — the one their own player page ships with. */
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * The persisted-query hash for PlaybackAccessToken.
 *
 * Twitch's GQL accepts either a full query document or the hash of one it
 * already knows. The hash is what their player sends, and sending the same
 * thing is what keeps this working; if Twitch ever retires it the call fails
 * cleanly and the yt-dlp fallback in `sources.ts` takes over.
 */
const PLAYBACK_ACCESS_TOKEN_HASH =
  '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712'

interface AccessToken {
  value: string
  signature: string
}

async function gql(body: unknown, signal?: AbortSignal): Promise<any> {
  const response = await net.fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': CLIENT_ID,
      'Content-Type': 'application/json',
      'user-agent': UA
    },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok) {
    throw Errors.resolverFailed(`Twitch GQL answered HTTP ${response.status}`)
  }
  return response.json()
}

/** Title, length, channel and publish time — everything the source model needs. */
async function videoMetadata(vodId: string, signal?: AbortSignal): Promise<{
  title?: string
  lengthSeconds?: number
  publishedAt?: string
  previewThumbnailURL?: string
  /** `RECORDING` while the broadcast is still on air; `RECORDED` once it ends. */
  status?: string
  owner?: { login?: string; displayName?: string }
} | null> {
  const data = await gql(
    {
      query: `{ video(id: "${vodId.replace(/[^0-9]/g, '')}") { title lengthSeconds publishedAt status previewThumbnailURL(width: 640, height: 360) owner { login displayName } } }`
    },
    signal
  )
  return data?.data?.video ?? null
}

async function playbackAccessToken(vodId: string, signal?: AbortSignal): Promise<AccessToken> {
  const data = await gql(
    {
      operationName: 'PlaybackAccessToken',
      extensions: { persistedQuery: { version: 1, sha256Hash: PLAYBACK_ACCESS_TOKEN_HASH } },
      variables: {
        isLive: false,
        login: '',
        isVod: true,
        vodID: vodId.replace(/[^0-9]/g, ''),
        playerType: 'embed'
      }
    },
    signal
  )
  const token = data?.data?.videoPlaybackAccessToken
  if (!token?.value || !token?.signature) {
    throw Errors.resolverFailed('Twitch would not issue a playback token for this VOD')
  }
  return { value: token.value, signature: token.signature }
}

export async function resolveTwitchDirect(
  match: UrlMatch,
  log: Logger,
  signal?: AbortSignal
): Promise<RawInfo> {
  // A channel link is a person, not a recording. See `channelArchiveId`.
  const vodId =
    match.kind === 'channel'
      ? await channelArchiveId(match.vodId, log, signal)
      : match.vodId.replace(/[^0-9]/g, '')
  if (vodId === '') throw Errors.resolverFailed(`Not a Twitch VOD id: ${match.vodId}`)

  const [meta, token] = await Promise.all([
    videoMetadata(vodId, signal).catch(() => null),
    playbackAccessToken(vodId, signal)
  ])

  const usher = new URL(`https://usher.ttvnw.net/vod/${vodId}.m3u8`)
  usher.searchParams.set('allow_source', 'true')
  usher.searchParams.set('allow_audio_only', 'true')
  usher.searchParams.set('player', 'twitchweb')
  usher.searchParams.set('sig', token.signature)
  usher.searchParams.set('token', token.value)

  const master = await net.fetch(usher.toString(), { headers: { 'user-agent': UA }, signal })
  if (!master.ok) {
    // Usher is where an unavailable or restricted VOD actually shows up: the
    // token is issued regardless, and the playlist is what refuses.
    if (master.status === 403) {
      throw Errors.authRequired(
        'Twitch',
        `usher answered HTTP 403 for VOD ${vodId} — subscriber-only, or the VOD is restricted`
      )
    }
    if (master.status === 404) {
      throw Errors.vodUnavailable(`Twitch has no playlist for VOD ${vodId} — it has been removed.`)
    }
    throw Errors.resolverFailed(`Twitch's master playlist answered HTTP ${master.status}`)
  }

  const masterText = await master.text()
  const masterUrl = master.url || usher.toString()
  const raw = new TwitchAdapter().fromApi(
    { ...(meta ?? {}), id: vodId },
    { text: masterText, url: masterUrl },
    match.canonicalUrl
  )
  if ((raw.formats?.length ?? 0) === 0) {
    throw Errors.resolverFailed('Twitch returned a master playlist with no variants')
  }

  // Same fallback as Kick's: a platform that reports no length leaves a POV
  // with no span on the timeline and nothing to sync against. Twitch's
  // `lengthSeconds` is usually right — this is for the case where it is not,
  // and it costs one playlist fetch only when the number is missing.
  if (!raw.duration) {
    raw.duration = await durationFromPlaylist(parseMaster(masterText, masterUrl).variants, (url) =>
      fetchText(url, { signal })
    )
  }

  log.info('twitch', 'Resolved Twitch VOD without yt-dlp', {
    vodId,
    formats: raw.formats?.length ?? 0,
    best: raw.formats?.[0]?.format_id
  })
  /*
   * Ask the recording itself, not the way we were asked for it.
   *
   * This was set only when a *channel* link was pasted, which missed every
   * other way a POV arrives — a VOD link, "Who was live", "Find POVs by time".
   * Those address the video directly, so a live angle added that way looked
   * like a finished recording and the wall showed a picture for the focused
   * angle only. Twitch marks the archive `RECORDING` until the broadcast ends,
   * and this metadata is fetched on every resolve anyway.
   */
  raw.still_recording = meta?.status === 'RECORDING'

  return raw
}

/**
 * The recording a Twitch channel is making *right now*.
 *
 * Twitch creates the archive when the broadcast starts and grows it as the
 * stream runs, so a channel that went live half an hour ago already has half an
 * hour of seekable, clippable, downloadable recording. Opening that is what
 * makes a live broadcast usable in this app at all — the alternative was a
 * rolling buffer of the last few minutes, which cannot be scrubbed back through
 * and cannot be cut from if you missed the moment.
 *
 * Verified against a live channel: `user.stream` is non-null and
 * `videos(first: 1, type: ARCHIVE, sort: TIME)` is the broadcast in progress,
 * its `lengthSeconds` counting up. When nothing is live the same query returns
 * their newest finished recording, which is the better answer to "open this
 * channel" than an error.
 */
async function channelArchiveId(
  login: string,
  log: Logger,
  signal?: AbortSignal
): Promise<string> {
  const safe = login.replace(/[^A-Za-z0-9_]/g, '')
  const data = await gql(
    {
      query: `{ user(login: "${safe}") { stream { id } videos(first: 1, type: ARCHIVE, sort: TIME) { edges { node { id } } } } }`
    },
    signal
  )
  const user = data?.data?.user
  if (!user) throw Errors.vodUnavailable(`Twitch has no channel called ${login}.`)

  const id = user.videos?.edges?.[0]?.node?.id
  if (!id) {
    throw Errors.vodUnavailable(
      `${login} has no recordings to open. They may not have streamed recently, or have archiving turned off.`
    )
  }
  log.info(
    'twitch',
    user.stream
      ? 'Opened a live broadcast as the recording it is already making'
      : 'Channel is offline; opened its newest recording',
    { login: safe, vodId: id }
  )
  return String(id)
}
