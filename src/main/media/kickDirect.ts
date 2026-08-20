import { net } from 'electron'
import { Errors } from '../../shared/errors.js'
import { KickAdapter, matchVodByStartTime, vodTimestampFromId } from '../platforms/kick.js'
import type { KickChannelVideo, KickVideoApi } from '../platforms/kick.js'
import type { UrlMatch } from '../platforms/types.js'
import type { RawInfo } from './resolver.js'
import type { Logger } from '../services/logger.js'

/**
 * Read a Kick VOD straight from Kick's own public web API.
 *
 * Two things break yt-dlp on Kick links that play perfectly in a browser:
 * its extractor only matches /<channel>/videos/<uuid>, and Kick's video
 * document sits behind a bot check that needs yt-dlp's impersonation extra.
 * On top of that, Kick now generates VOD links with a UUIDv7 that its own
 * /video/<id> endpoint does not know, so even a correct request 404s.
 *
 * Requests here go out through Chromium's network stack (`net.fetch`) — the
 * same request the user's browser makes, to endpoints the site itself calls.
 * Nothing is bypassed: a challenge or an auth requirement is reported, not
 * worked around.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HEADERS = {
  'user-agent': UA,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  referer: 'https://kick.com/'
}

interface Fetched {
  status: number
  json: unknown | null
}

async function getJson(url: string, signal?: AbortSignal): Promise<Fetched> {
  const response = await net.fetch(url, { headers: HEADERS, signal })
  if (!response.ok) return { status: response.status, json: null }
  try {
    return { status: response.status, json: await response.json() }
  } catch {
    // A bot-check interstitial comes back as HTML with a 200.
    throw Errors.kickBlocked(`Kick answered ${url} with a page rather than JSON`)
  }
}

function blockedOr(status: number, url: string): Error {
  if (status === 403 || status === 429 || status === 503) {
    throw Errors.kickBlocked(`Kick answered HTTP ${status} for ${url}`)
  }
  return Errors.resolverFailed(`Kick answered HTTP ${status} for ${url}`)
}

/** Channel slug out of https://kick.com/<slug>/videos/<id>. */
function channelSlug(canonicalUrl: string): string | null {
  const parts = new URL(canonicalUrl).pathname.split('/').filter(Boolean)
  return parts[1] === 'videos' && parts[0] ? parts[0] : null
}

export async function resolveKickDirect(
  match: UrlMatch,
  log: Logger,
  signal?: AbortSignal
): Promise<RawInfo> {
  const videoUuid = await legacyVideoUuid(match, log, signal)
  const videoUrl = `https://kick.com/api/v1/video/${encodeURIComponent(videoUuid)}`
  const video = await getJson(videoUrl, signal)
  if (!video.json) {
    if (video.status === 404) {
      throw Errors.vodUnavailable(
        `Kick does not have a video document for ${videoUuid} — the VOD has expired or been removed.`
      )
    }
    throw blockedOr(video.status, videoUrl)
  }

  const api = video.json as KickVideoApi
  if (!api.source) {
    throw Errors.vodUnavailable(
      'Kick returned this VOD without a playable source — it is usually still processing, or it is subscriber-only.'
    )
  }

  const master = await net.fetch(api.source, { headers: { 'user-agent': UA }, signal })
  if (!master.ok) {
    throw Errors.resolverFailed(`Kick's master playlist answered HTTP ${master.status}`)
  }

  const raw = new KickAdapter().fromApi(
    { ...api, uuid: api.uuid ?? videoUuid },
    { text: await master.text(), url: master.url || api.source }
  )
  log.info('kick', 'Resolved Kick VOD without yt-dlp', {
    vodId: match.vodId,
    videoUuid,
    formats: raw.formats?.length ?? 0
  })
  return raw
}

/**
 * New-style links carry a UUIDv7 that Kick's video endpoint does not accept.
 * Its embedded timestamp is the broadcast start, so the channel's own VOD list
 * turns it back into the id the video endpoint does know.
 */
async function legacyVideoUuid(
  match: UrlMatch,
  log: Logger,
  signal?: AbortSignal
): Promise<string> {
  const startedMs = vodTimestampFromId(match.vodId)
  if (startedMs === null) return match.vodId

  const slug = channelSlug(match.canonicalUrl)
  if (!slug) {
    throw Errors.vodUnavailable(
      `This is one of Kick's new video links, which only identifies the VOD by its start time. Open it on Kick and copy the full address including the channel name (kick.com/<channel>/videos/${match.vodId}).`
    )
  }

  const listUrl = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`
  const list = await getJson(listUrl, signal)
  if (!list.json) throw blockedOr(list.status, listUrl)

  const found = matchVodByStartTime(list.json as KickChannelVideo[], startedMs)
  if (!found?.video?.uuid) {
    throw Errors.vodUnavailable(
      `Kick's video list for ${slug} has no broadcast starting at ${new Date(startedMs).toISOString()}. Kick removes VODs after a while, and subscriber-only VODs are not listed publicly.`
    )
  }

  log.info('kick', 'Mapped a new-style Kick VOD link to its video id', {
    linkId: match.vodId,
    videoUuid: found.video.uuid,
    startedAt: new Date(startedMs).toISOString()
  })
  return found.video.uuid
}
