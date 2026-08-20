import type {
  AdapterCapabilities,
  PlatformId,
  PlaybackKind,
  VodSource
} from '../../shared/types.js'
import type { RawInfo } from '../media/resolver.js'

export interface UrlMatch {
  platform: PlatformId
  vodId: string
  /** Canonical URL the resolver should be given. */
  canonicalUrl: string
  /** Optional start offset encoded in the URL (e.g. ?t=1h2m3s). */
  startSeconds?: number
}

/**
 * A platform adapter owns everything platform-specific: URL shapes, capability
 * reporting and how resolver output becomes a VodSource. The editor never
 * branches on platform.
 */
export interface PlatformAdapter {
  readonly id: PlatformId
  readonly displayName: string
  readonly capabilities: AdapterCapabilities

  /** Recognise a URL and extract the VOD id, or null if it isn't ours. */
  match(url: string): UrlMatch | null

  /** Which player the renderer should use for this source. */
  playbackKind(raw: RawInfo): PlaybackKind

  /**
   * Build the source model from resolver output.
   * Adapters must not invent data they have not actually observed.
   */
  buildSource(match: UrlMatch, raw: RawInfo): VodSource
}

export function safeUrl(input: string): URL | null {
  try {
    const trimmed = input.trim()
    const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

/** Parse YouTube/Twitch style offsets: "1h2m3s", "3600", "01h30m". */
export function parseOffset(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(trimmed)
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

/**
 * The best format the application's own player can show: an HLS variant, or a
 * muxed progressive file. Adaptive video-only formats are excluded — they carry
 * no audio and are for export, not preview.
 */
export function bestPreviewFormat(raw: RawInfo): { url: string; kind: PlaybackKind } | null {
  const formats = raw.formats ?? []
  const hls = formats
    .filter((f) => (f.protocol ?? '').startsWith('m3u8') && f.url && f.vcodec && f.vcodec !== 'none')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
  if (hls?.url) return { url: hls.url, kind: 'hls' }

  const progressive = formats
    .filter(
      (f) =>
        (f.protocol === 'https' || f.protocol === 'http') &&
        f.url &&
        f.vcodec &&
        f.vcodec !== 'none' &&
        f.acodec &&
        f.acodec !== 'none'
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
  if (progressive?.url) return { url: progressive.url, kind: 'progressive' }

  return null
}

export function previewKindFromFormats(raw: RawInfo): PlaybackKind {
  return bestPreviewFormat(raw)?.kind ?? 'none'
}

export function isoDateFrom(raw: RawInfo): string | undefined {
  if (typeof raw.timestamp === 'number') return new Date(raw.timestamp * 1000).toISOString()
  if (typeof raw.release_timestamp === 'number') {
    return new Date(raw.release_timestamp * 1000).toISOString()
  }
  if (typeof raw.upload_date === 'string' && /^\d{8}$/.test(raw.upload_date)) {
    const y = raw.upload_date.slice(0, 4)
    const mo = raw.upload_date.slice(4, 6)
    const d = raw.upload_date.slice(6, 8)
    return new Date(`${y}-${mo}-${d}T00:00:00Z`).toISOString()
  }
  return undefined
}
