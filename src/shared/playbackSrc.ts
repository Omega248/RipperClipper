import { mediaProxyUrl } from './mediaProxyUrl.js'
import type { VodSource } from './types.js'

/**
 * Where the application player fetches a POV from.
 *
 * Always through the app's own loopback proxy: platform CDNs do not reliably
 * send CORS headers, and same-origin media is also what lets several POVs play
 * at once without each one re-negotiating.
 */
export function playbackSrc(
  source: VodSource,
  mediaProxyBase: string | undefined,
  mediaProxyToken: string | undefined
): string | null {
  if (!source.playbackUrl) return null
  if (source.playbackKind !== 'hls' && source.playbackKind !== 'progressive') return null
  // No proxy configured yet — the raw URL is better than a URL that 403s.
  if (!mediaProxyBase || !mediaProxyToken) return source.playbackUrl
  const kind = source.playbackKind === 'hls' ? 'manifest' : 'segment'
  // A broadcast still being written needs its playlist re-read as it grows.
  return mediaProxyUrl(
    mediaProxyBase,
    mediaProxyToken,
    kind,
    source.playbackUrl,
    source.stillRecording === true
  )
}
