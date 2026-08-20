import type { AdapterCapabilities, PlaybackKind, VodSource } from '../../shared/types.js'
import type { RawInfo } from '../media/resolver.js'
import { parseMaster, sortVariants } from '../media/hls.js'
import { isoDateFrom, parseOffset, safeUrl } from './types.js'
import type { PlatformAdapter, UrlMatch } from './types.js'

/** The parts of Kick's video document the app actually reads. */
export interface KickVideoApi {
  id?: string
  uuid?: string
  /** Master HLS playlist for the finished VOD. */
  source?: string
  created_at?: string
  livestream?: {
    session_title?: string
    slug?: string
    duration?: number
    thumbnail?: string | { url?: string }
    channel?: { slug?: string; user?: { username?: string } }
  }
}

/** One entry of GET /api/v2/channels/<slug>/videos. */
export interface KickChannelVideo {
  id?: number
  start_time?: string
  created_at?: string
  session_title?: string
  video?: { uuid?: string }
}

/**
 * Kick's new VOD links carry a UUIDv7 whose first 48 bits are the unix
 * millisecond timestamp the broadcast started — that is what makes the new
 * links resolvable at all, because Kick's video API still keys off the old
 * random UUIDs. Returns null for the old v4 ids.
 *
 * Verified against a live VOD: 019f8589-dea8-7855-9a53-38df793bd1fb decodes to
 * 2026-07-21T16:37:13Z, and that channel's video list has exactly one entry
 * starting at 2026-07-21 16:37:13.
 */
export function vodTimestampFromId(id: string): number | null {
  const hex = id.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null
  if (hex[12] !== '7') return null // version nibble
  const ms = Number.parseInt(hex.slice(0, 12), 16)
  // Sanity: between 2020 and 2100, otherwise it is not a real timestamp.
  if (!Number.isFinite(ms) || ms < 1_577_836_800_000 || ms > 4_102_444_800_000) return null
  return ms
}

/**
 * Find the channel's VOD whose broadcast start matches a new-style link.
 * Kick's list times and the id's timestamp agree to the second, so the window
 * is deliberately tight — a loose match would silently open the wrong stream.
 */
export function matchVodByStartTime(
  videos: KickChannelVideo[],
  targetMs: number,
  toleranceMs = 120_000
): KickChannelVideo | null {
  let best: { video: KickChannelVideo; delta: number } | null = null
  for (const video of videos) {
    if (!video.video?.uuid) continue
    const started = Date.parse(
      // Kick sends "2026-07-21 16:37:13" (UTC, no zone marker) here.
      (video.start_time ?? video.created_at ?? '').replace(' ', 'T').replace(/Z?$/, 'Z')
    )
    if (!Number.isFinite(started)) continue
    const delta = Math.abs(started - targetMs)
    if (delta <= toleranceMs && (!best || delta < best.delta)) best = { video, delta }
  }
  return best?.video ?? null
}

/** CODECS="avc1.64002a,mp4a.40.2" → the video or the audio entry. */
function firstCodec(codecs: string | undefined, kind: 'video' | 'audio'): string | undefined {
  if (!codecs) return undefined
  const parts = codecs.split(',').map((c) => c.trim()).filter(Boolean)
  const isAudio = (c: string): boolean => /^(mp4a|opus|ac-3|ec-3|vorbis)/i.test(c)
  return parts.find((c) => (kind === 'audio' ? isAudio(c) : !isAudio(c)))
}

/**
 * Kick VODs are HLS-backed, so ranges map to segment runs in the same way as
 * Twitch. Kick uses UUID video ids in /video/<uuid> URLs and channel-scoped
 * /<channel>/videos/<uuid> URLs.
 */
export class KickAdapter implements PlatformAdapter {
  readonly id = 'kick' as const
  readonly displayName = 'Kick'

  readonly capabilities: AdapterCapabilities = {
    metadata: true,
    playback: true,
    rangeDownload: true,
    requiresAuth: false,
    notes: [
      'Kick occasionally rate-limits manifest requests; Ripper Clipper retries with backoff rather than hammering the endpoint.'
    ]
  }

  match(url: string): UrlMatch | null {
    const parsed = safeUrl(url)
    if (!parsed) return null
    if (!/(^|\.)kick\.com$/i.test(parsed.hostname)) return null

    const parts = parsed.pathname.split('/').filter(Boolean)
    let vodId: string | null = null

    if (parts[0] === 'video' && parts[1]) vodId = parts[1]
    else if (parts[1] === 'videos' && parts[2]) vodId = parts[2]

    if (!vodId) return null
    // Kick ids are UUIDs; accept the general shape without being brittle.
    if (!/^[A-Za-z0-9-]{8,64}$/.test(vodId)) return null

    const canonical =
      parts[0] === 'video'
        ? `https://kick.com/video/${vodId}`
        : `https://kick.com/${parts[0]}/videos/${vodId}`

    return {
      platform: this.id,
      vodId,
      canonicalUrl: canonical,
      startSeconds: parseOffset(parsed.searchParams.get('t'))
    }
  }

  playbackKind(raw: RawInfo): PlaybackKind {
    const hasHls = (raw.formats ?? []).some((f) => (f.protocol ?? '').startsWith('m3u8'))
    if (hasHls) return 'hls'
    const hasProgressive = (raw.formats ?? []).some((f) => (f.protocol ?? '') === 'https')
    return hasProgressive ? 'progressive' : 'none'
  }

  /**
   * yt-dlp's Kick extractor only matches /<channel>/videos/<uuid>, and it needs
   * browser impersonation to get past Kick's bot check. Everything the app
   * needs is in Kick's own video document plus its master playlist, so this
   * converts that pair into the same shape yt-dlp would have produced.
   *
   * Pure: the caller does the fetching. `master` is the text of the master
   * playlist at `api.source`.
   */
  fromApi(api: KickVideoApi, master: { text: string; url: string }): RawInfo {
    const stream = api.livestream ?? {}
    const variants = sortVariants(parseMaster(master.text, master.url).variants)
    const durationMs = Number(stream.duration ?? 0)

    return {
      id: api.id ?? api.uuid,
      title: stream.session_title ?? stream.slug ?? undefined,
      uploader: stream.channel?.user?.username ?? stream.channel?.slug,
      channel: stream.channel?.slug,
      duration: durationMs > 0 ? durationMs / 1000 : undefined,
      timestamp: api.created_at ? Math.floor(Date.parse(api.created_at) / 1000) : undefined,
      thumbnail: typeof stream.thumbnail === 'string' ? stream.thumbnail : stream.thumbnail?.url,
      is_live: false,
      extractor_key: 'KickVod',
      webpage_url: stream.channel?.slug
        ? `https://kick.com/${stream.channel.slug}/videos/${api.uuid}`
        : undefined,
      formats: variants.map((v, index) => ({
        format_id: v.name ?? (v.height ? `${v.height}p` : `variant-${index}`),
        url: v.uri,
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: firstCodec(v.codecs, 'video') ?? 'unknown',
        acodec: firstCodec(v.codecs, 'audio') ?? 'unknown',
        width: v.width,
        height: v.height,
        fps: v.frameRate,
        tbr: v.bandwidth > 0 ? Math.round(v.bandwidth / 1000) : undefined
      }))
    }
  }

  buildSource(match: UrlMatch, raw: RawInfo): VodSource {
    const best = (raw.formats ?? [])
      .filter((f) => f.url)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]

    return {
      id: `kick:${match.vodId}`,
      platform: 'kick',
      vodId: match.vodId,
      url: match.canonicalUrl,
      title: raw.title ?? `Kick VOD ${match.vodId}`,
      creator: raw.uploader ?? raw.channel ?? raw.uploader_id ?? 'Unknown channel',
      durationSeconds: Number(raw.duration ?? 0),
      createdAt: isoDateFrom(raw),
      thumbnailUrl: raw.thumbnail,
      playbackUrl: best?.url ?? raw.url,
      playbackKind: this.playbackKind(raw),
      capabilities: this.capabilities,
      formatsInspected: false
    }
  }
}
