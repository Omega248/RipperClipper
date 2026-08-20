import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isMasterPlaylist, parseAttributes, resolveUrl } from './media/hls.js'
import { isValidHttpUrl } from './media/http.js'

/**
 * Same-origin media proxy for the preview player.
 *
 * Platform CDNs are not obliged to send CORS headers, and the renderer runs on
 * its own local origin, so fetching an HLS manifest directly from the page can
 * fail with an opaque network error even though the media is perfectly
 * reachable. Routing preview traffic through this local endpoint makes every
 * request same-origin: the fetch happens in the main process, where CORS does
 * not apply, and playlists are rewritten so their segments come back through
 * here too.
 *
 * This does not bypass any access control — it issues exactly the request the
 * user's browser would make, and it refuses anything that is not a plain
 * http(s) URL.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export const MEDIA_MANIFEST_PATH = '/media/manifest'
export const MEDIA_SEGMENT_PATH = '/media/segment'

/** Referer/Origin some CDNs expect, derived from the target host. */
function platformHeaders(target: URL): Record<string, string> {
  const host = target.hostname.toLowerCase()
  if (host.endsWith('ttvnw.net') || host.endsWith('twitch.tv') || host.endsWith('jtvnw.net')) {
    return { origin: 'https://www.twitch.tv', referer: 'https://www.twitch.tv/' }
  }
  if (host.includes('kick')) {
    return { origin: 'https://kick.com', referer: 'https://kick.com/' }
  }
  if (host.endsWith('googlevideo.com') || host.endsWith('youtube.com')) {
    // Referer only: googlevideo applies a CORS check when an Origin header is
    // present, and a signed media URL fetched with an unexpected Origin comes
    // back 403 — which reaches the player as an unplayable source. A browser
    // playing <video src> does not send Origin either.
    return { referer: 'https://www.youtube.com/' }
  }
  return {}
}

export function proxyUrl(base: string, kind: 'manifest' | 'segment', target: string): string {
  const path = kind === 'manifest' ? MEDIA_MANIFEST_PATH : MEDIA_SEGMENT_PATH
  return `${base.replace(/\/$/, '')}${path}?u=${encodeURIComponent(target)}`
}

function decodeTarget(requestUrl: string, origin: string): URL | null {
  try {
    const parsed = new URL(requestUrl, origin)
    const raw = parsed.searchParams.get('u')
    if (!raw || !isValidHttpUrl(raw)) return null
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * Rewrite a playlist so every URI it references is fetched back through the
 * proxy. Relative URIs are resolved against the playlist's own URL first.
 */
export function rewritePlaylist(text: string, playlistUrl: string, base: string): string {
  const master = isMasterPlaylist(text)
  const rewriteAttrUri = (line: string, prefix: string, kind: 'manifest' | 'segment'): string => {
    const attrs = parseAttributes(line.slice(prefix.length))
    if (!attrs.URI) return line
    const absolute = resolveUrl(attrs.URI, playlistUrl)
    return line.replace(
      `URI="${attrs.URI}"`,
      `URI="${proxyUrl(base, kind, absolute)}"`
    )
  }

  return text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim()
      if (line === '') return raw

      if (line.startsWith('#EXT-X-MEDIA:')) return rewriteAttrUri(line, '#EXT-X-MEDIA:', 'manifest')
      if (line.startsWith('#EXT-X-MAP:')) return rewriteAttrUri(line, '#EXT-X-MAP:', 'segment')
      if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
        const prefix = line.startsWith('#EXT-X-KEY:') ? '#EXT-X-KEY:' : '#EXT-X-SESSION-KEY:'
        return rewriteAttrUri(line, prefix, 'segment')
      }
      if (line.startsWith('#')) return raw

      // A bare line is a variant playlist in a master, a segment otherwise.
      return proxyUrl(base, master ? 'manifest' : 'segment', resolveUrl(line, playlistUrl))
    })
    .join('\n')
}

export interface MediaProxyOptions {
  /** Public base URL of this server, used when rewriting playlists. */
  base: string
}

/** Returns true when the request was a media-proxy request and was handled. */
export async function handleMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaProxyOptions
): Promise<boolean> {
  const url = req.url ?? '/'
  const isManifest = url.startsWith(`${MEDIA_MANIFEST_PATH}?`)
  const isSegment = url.startsWith(`${MEDIA_SEGMENT_PATH}?`)
  if (!isManifest && !isSegment) return false

  // The renderer may live on a different local port in development.
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'content-length,content-range,accept-ranges'
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end()
    return true
  }

  const target = decodeTarget(url, options.base)
  if (!target) {
    res.writeHead(400, { ...cors, 'content-type': 'text/plain' }).end('Invalid media target')
    return true
  }

  const headers: Record<string, string> = {
    'user-agent': DEFAULT_UA,
    ...platformHeaders(target)
  }
  if (req.headers.range) headers.range = String(req.headers.range)

  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream: Response
  try {
    upstream = await fetch(target.toString(), {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    })
  } catch (err) {
    if (!res.headersSent) {
      res
        .writeHead(502, { ...cors, 'content-type': 'text/plain' })
        .end(`Upstream request failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return true
  }

  if (isManifest) {
    const text = await upstream.text()
    const body = rewritePlaylist(text, upstream.url || target.toString(), options.base)
    res
      .writeHead(upstream.status, {
        ...cors,
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-store'
      })
      .end(body)
    return true
  }

  const passthrough: Record<string, string> = { ...cors, 'cache-control': 'no-store' }
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(name)
    if (value) passthrough[name] = value
  }

  res.writeHead(upstream.status, passthrough)
  if (req.method === 'HEAD' || !upstream.body) {
    res.end()
    return true
  }

  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
  stream.on('error', () => res.destroy())
  stream.pipe(res)
  return true
}
