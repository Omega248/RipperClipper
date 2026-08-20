import type { VodSource } from '@shared/types'

/**
 * Where the application player fetches a POV from.
 *
 * Always through the app's own loopback proxy: platform CDNs do not reliably
 * send CORS headers, and same-origin media is also what lets several POVs play
 * at once without each one re-negotiating.
 */
export function playbackSrc(source: VodSource, mediaProxyBase: string | undefined): string | null {
  if (!source.playbackUrl) return null
  if (source.playbackKind !== 'hls' && source.playbackKind !== 'progressive') return null
  if (!mediaProxyBase) return source.playbackUrl
  const kind = source.playbackKind === 'hls' ? 'manifest' : 'segment'
  return `${mediaProxyBase}/media/${kind}?u=${encodeURIComponent(source.playbackUrl)}`
}
