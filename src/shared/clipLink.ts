import type { PlatformId } from './types.js'

/**
 * Starting from a link someone shared, instead of a wall-clock time.
 *
 * You almost never learn a scene happened from a timestamp — you learn from
 * somebody's clip in Discord, a highlight, a YouTube upload. Those links
 * already carry the one fact that is otherwise hardest to produce: exactly
 * when it happened.
 *
 * A Twitch clip names its source VOD and the offset into it; a VOD link can
 * carry `?t=`; a YouTube link carries `&t=`. Combined with the broadcast's
 * own start time, any of them resolves to a real-world instant, which is what
 * every POV is then matched against.
 */

export type ClipLinkKind =
  /** A Twitch/Kick clip, which must be resolved to find its parent broadcast. */
  | 'clip'
  /** A VOD link, optionally with a time offset in it. */
  | 'vod'

export interface ClipLink {
  platform: PlatformId
  kind: ClipLinkKind
  /** The slug or id the platform knows this by. */
  id: string
  /** Canonical URL to hand the resolver. */
  url: string
  /**
   * Offset into the parent VOD, in seconds, when the link itself stated one.
   * A clip link has no offset here — resolving it is what produces one.
   */
  offsetSeconds?: number
  /** The channel, when the URL names it. */
  channel?: string
}

/** Parse `?t=1h2m3s`, `?t=3600`, `?start=90`. */
export function parseTimeParam(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(trimmed)
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

/**
 * Recognise any link that points at a moment.
 *
 * Returns null for anything unrecognised rather than guessing — a link that
 * cannot be placed on the clock is worse than no link, because it would seed
 * a search at the wrong time and quietly return the wrong POVs.
 */
export function parseClipLink(input: string): ClipLink | null {
  const text = input.trim()
  if (text === '') return null

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)
  const t = parseTimeParam(url.searchParams.get('t') ?? url.searchParams.get('start'))

  // ---- Twitch --------------------------------------------------------------
  if (host === 'clips.twitch.tv') {
    // clips.twitch.tv/SlugName
    const slug = parts[0]
    return slug ? { platform: 'twitch', kind: 'clip', id: slug, url: `https://clips.twitch.tv/${slug}` } : null
  }
  if (host === 'twitch.tv' || host === 'm.twitch.tv') {
    // twitch.tv/<channel>/clip/<slug>
    const clipAt = parts.indexOf('clip')
    if (clipAt >= 0 && parts[clipAt + 1]) {
      return {
        platform: 'twitch',
        kind: 'clip',
        id: parts[clipAt + 1],
        url: `https://clips.twitch.tv/${parts[clipAt + 1]}`,
        channel: clipAt > 0 ? parts[0] : undefined
      }
    }
    // twitch.tv/videos/123456789?t=1h2m3s
    if (parts[0] === 'videos' && parts[1]) {
      return {
        platform: 'twitch',
        kind: 'vod',
        id: parts[1],
        url: `https://www.twitch.tv/videos/${parts[1]}`,
        offsetSeconds: t
      }
    }
    return null
  }

  // ---- Kick ----------------------------------------------------------------
  if (host === 'kick.com') {
    // kick.com/<channel>/clips/<id>  (Kick's clip route)
    const clipsAt = parts.indexOf('clips')
    if (clipsAt >= 0 && parts[clipsAt + 1]) {
      return {
        platform: 'kick',
        kind: 'clip',
        id: parts[clipsAt + 1],
        url: `https://kick.com/${parts[0]}/clips/${parts[clipsAt + 1]}`,
        channel: parts[0]
      }
    }
    // kick.com/<channel>/videos/<uuid>
    const videosAt = parts.indexOf('videos')
    if (videosAt >= 0 && parts[videosAt + 1]) {
      return {
        platform: 'kick',
        kind: 'vod',
        id: parts[videosAt + 1],
        url: `https://kick.com/${parts[0]}/videos/${parts[videosAt + 1]}`,
        offsetSeconds: t,
        channel: parts[0]
      }
    }
    return null
  }

  // ---- YouTube -------------------------------------------------------------
  if (host === 'youtu.be') {
    return parts[0]
      ? {
          platform: 'youtube',
          kind: 'vod',
          id: parts[0],
          url: `https://www.youtube.com/watch?v=${parts[0]}`,
          offsetSeconds: t
        }
      : null
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const v = url.searchParams.get('v')
    if (v) {
      return { platform: 'youtube', kind: 'vod', id: v, url: `https://www.youtube.com/watch?v=${v}`, offsetSeconds: t }
    }
    if (parts[0] === 'live' && parts[1]) {
      return {
        platform: 'youtube',
        kind: 'vod',
        id: parts[1],
        url: `https://www.youtube.com/watch?v=${parts[1]}`,
        offsetSeconds: t
      }
    }
    return null
  }

  return null
}

/**
 * The real-world instant a link points at.
 *
 * `broadcastStart` is when the parent VOD began, on the wall clock; `offset`
 * is how far into it the moment sits. Returns null when either is unknown,
 * because a half-known time would place a search wrongly rather than not at
 * all — and the caller can say so.
 */
export function momentOf(
  broadcastStartIso: string | null | undefined,
  offsetSeconds: number | null | undefined
): number | null {
  if (!broadcastStartIso || typeof offsetSeconds !== 'number') return null
  const started = Date.parse(broadcastStartIso)
  if (!Number.isFinite(started)) return null
  return started / 1000 + offsetSeconds
}
