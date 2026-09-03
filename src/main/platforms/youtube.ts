import type { AdapterCapabilities, PlaybackKind, VodSource } from '../../shared/types.js'
import type { RawInfo } from '../media/resolver.js'
import { bestPreviewFormat, isoDateFrom, parseOffset, previewKindFromFormats, safeUrl } from './types.js'
import type { PlatformAdapter, UrlMatch } from './types.js'

/**
 * YouTube is previewed through the application's own player, like every other
 * platform, using the muxed progressive stream the resolver reports. Range
 * extraction for export uses the adaptive media URLs, which honour HTTP Range,
 * so only the bytes covering the selected window are transferred.
 */
export class YouTubeAdapter implements PlatformAdapter {
  readonly id = 'youtube' as const
  readonly displayName = 'YouTube'

  readonly capabilities: AdapterCapabilities = {
    notes: [
      'Preview plays through the application player using the muxed progressive stream; export still uses the best adaptive video and audio available.',
      'Age-restricted, private and members-only videos need an authenticated session; choose your browser under Settings → Setup → Restricted VODs.',
      'Videos that YouTube serves only under DRM cannot be exported — Ripper Clipper reports this instead of failing silently.'
    ]
  }

  match(url: string): UrlMatch | null {
    const parsed = safeUrl(url)
    if (!parsed) return null
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')

    let videoId: string | null = null

    // A channel's live URL — youtube.com/@handle/live — names a person, not a
    // recording. YouTube gives the broadcast an ordinary video id, but only
    // once it starts, so until then the handle is the only identity there is.
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const parts = parsed.pathname.split('/').filter(Boolean)
      const handle =
        parts[0]?.startsWith('@') && parts[1] === 'live'
          ? parts[0].slice(1)
          : (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') &&
              parts[1] &&
              parts[2] === 'live'
            ? parts[1]
            : null
      if (handle) {
        return {
          platform: this.id,
          vodId: handle.toLowerCase(),
          kind: 'channel',
          canonicalUrl: parts[0].startsWith('@')
            ? `https://www.youtube.com/@${handle}/live`
            : `https://www.youtube.com/${parts[0]}/${handle}/live`
        }
      }
    }

    if (host === 'youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] ?? null
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts[0] === 'watch') videoId = parsed.searchParams.get('v')
      else if (parts[0] === 'live' && parts[1]) videoId = parts[1]
      else if (parts[0] === 'shorts' && parts[1]) videoId = parts[1]
      else if (parts[0] === 'embed' && parts[1]) videoId = parts[1]
      else if (parts[0] === 'v' && parts[1]) videoId = parts[1]
    } else {
      return null
    }

    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null

    return {
      platform: this.id,
      vodId: videoId,
      kind: 'vod',
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      startSeconds: parseOffset(parsed.searchParams.get('t') ?? parsed.searchParams.get('start'))
    }
  }

  playbackKind(raw: RawInfo): PlaybackKind {
    return previewKindFromFormats(raw)
  }

  buildSource(match: UrlMatch, raw: RawInfo): VodSource {
    const preview = bestPreviewFormat(raw)
    return {
      id: `youtube:${match.vodId}`,
      platform: 'youtube',
      vodId: match.vodId,
      url: match.canonicalUrl,
      title: raw.title ?? `YouTube video ${match.vodId}`,
      creator: raw.channel ?? raw.uploader ?? 'Unknown channel',
      durationSeconds: Number(raw.duration ?? 0),
      createdAt: isoDateFrom(raw),
      thumbnailUrl: raw.thumbnail,
      playbackUrl: preview?.url,
      playbackKind: this.playbackKind(raw),
      capabilities: this.capabilities,
      formatsInspected: false
    }
  }
}
