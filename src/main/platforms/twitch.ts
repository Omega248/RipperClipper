import type { AdapterCapabilities, PlaybackKind, VodSource } from '../../shared/types.js'
import type { RawInfo } from '../media/resolver.js'
import { isoDateFrom, parseOffset, previewKindFromFormats, safeUrl } from './types.js'
import type { PlatformAdapter, UrlMatch } from './types.js'

/**
 * Twitch VODs are delivered as HLS, so an arbitrary time range maps cleanly to
 * a contiguous run of media segments. Twitch's Helix "create clip" endpoint is
 * NOT used for this: it only produces short clips from a live broadcast and
 * cannot express an arbitrary VOD range.
 */
export class TwitchAdapter implements PlatformAdapter {
  readonly id = 'twitch' as const
  readonly displayName = 'Twitch'

  readonly capabilities: AdapterCapabilities = {
    metadata: true,
    playback: true,
    rangeDownload: true,
    requiresAuth: false,
    notes: [
      'Sub-only VODs require an authenticated session; add browser cookies in Settings → Advanced.',
      "Twitch's official clip API cannot produce arbitrary-length VOD segments, so ranges are extracted from the VOD's own HLS segments instead."
    ]
  }

  match(url: string): UrlMatch | null {
    const parsed = safeUrl(url)
    if (!parsed) return null
    if (!/(^|\.)twitch\.tv$/i.test(parsed.hostname)) return null

    const parts = parsed.pathname.split('/').filter(Boolean)
    // https://www.twitch.tv/videos/123456789
    let vodId: string | null = null
    if (parts[0] === 'videos' && parts[1]) vodId = parts[1]
    // https://www.twitch.tv/<channel>/video/123456789 (legacy)
    else if (parts[1] === 'video' && parts[2]) vodId = parts[2]
    // https://www.twitch.tv/videos/123456789?t=1h2m3s

    if (!vodId || !/^\d+$/.test(vodId)) return null

    return {
      platform: this.id,
      vodId,
      canonicalUrl: `https://www.twitch.tv/videos/${vodId}`,
      startSeconds: parseOffset(parsed.searchParams.get('t'))
    }
  }

  playbackKind(raw: RawInfo): PlaybackKind {
    return previewKindFromFormats(raw)
  }

  buildSource(match: UrlMatch, raw: RawInfo): VodSource {
    const hls = (raw.formats ?? [])
      .filter((f) => (f.protocol ?? '').startsWith('m3u8') && f.url)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]

    return {
      id: `twitch:${match.vodId}`,
      platform: 'twitch',
      vodId: match.vodId,
      url: match.canonicalUrl,
      title: raw.title ?? `Twitch VOD ${match.vodId}`,
      creator: raw.uploader ?? raw.channel ?? raw.uploader_id ?? 'Unknown channel',
      durationSeconds: Number(raw.duration ?? 0),
      createdAt: isoDateFrom(raw),
      thumbnailUrl: raw.thumbnail,
      playbackUrl: hls?.url ?? raw.url,
      playbackKind: this.playbackKind(raw),
      capabilities: this.capabilities,
      formatsInspected: false
    }
  }
}
