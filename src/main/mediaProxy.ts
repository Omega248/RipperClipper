import { createReadStream } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isMasterPlaylist, parseAttributes, resolveUrl } from './media/hls.js'
import { isValidHttpUrl } from './media/http.js'
import {
  MEDIA_MANIFEST_PATH,
  MEDIA_SEGMENT_PATH,
  mediaProxyUrl
} from '../shared/mediaProxyUrl.js'

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

/**
 * Proof that a request came from this app, not from a web page.
 *
 * The proxy fetches whatever URL it is handed and returns the body with
 * `access-control-allow-origin: *`. Without this it is an open relay bound to
 * loopback: anything that can reach the port — another program on the machine,
 * or a page that guesses it — could read `http://192.168.1.1/`,
 * `http://169.254.169.254/`, or an intranet app *through* the user's machine,
 * cross-origin, and read the response body.
 *
 * An `Origin` check is not enough on its own: a non-browser client simply
 * omits the header. A secret in the URL is checked the same way whoever is
 * asking. It is per-run and never leaves this process except inside the URLs
 * the renderer is handed.
 */
const SESSION_TOKEN = randomBytes(16).toString('hex')

export function proxyUrl(
  base: string,
  kind: 'manifest' | 'segment',
  target: string,
  growing = false
): string {
  return mediaProxyUrl(base, SESSION_TOKEN, kind, target, growing)
}

/** Handed to the renderer with the proxy's address, so its URLs work too. */
export function mediaProxyToken(): string {
  return SESSION_TOKEN
}

function hasSessionToken(requestUrl: string, origin: string): boolean {
  try {
    const given = new URL(requestUrl, origin).searchParams.get('k') ?? ''
    // Fixed-length hex on both sides, so a length mismatch is not a leak.
    return (
      given.length === SESSION_TOKEN.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(SESSION_TOKEN))
    )
  } catch {
    return false
  }
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
export function rewritePlaylist(
  text: string,
  playlistUrl: string,
  base: string,
  /**
   * The recording is still being written — drop its end marker.
   *
   * A player stops refreshing a media playlist the moment it sees
   * `#EXT-X-ENDLIST`: the list is final, so there is nothing to re-read. Kick's
   * in-progress recordings advertise it anyway (verified against a live
   * channel: `#EXT-X-PLAYLIST-TYPE:EVENT`, `#EXT-X-MEDIA-SEQUENCE:0` **and**
   * `#EXT-X-ENDLIST`, while the broadcast was plainly still running). So
   * playback ran to whatever the recording held when the angle was loaded and
   * then simply stopped — the buffer ended and nothing ever fetched more.
   *
   * Removing the marker while the broadcast is on air is what lets hls.js do
   * its own job: re-read the playlist on its own schedule, append the segments
   * that have appeared since, and keep playing. No seeking, no reloading, no
   * re-creating the player. When the broadcast ends the source stops being
   * marked as growing, the marker comes through, and playback ends properly.
   *
   * Only ever on a media playlist. A master has no `ENDLIST` and nothing here
   * should invent behaviour for one.
   */
  growing = false
): string {
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
      if (growing && !master && line === '#EXT-X-ENDLIST') return null
      if (line.startsWith('#')) return raw

      // A bare line is a variant playlist in a master, a segment otherwise.
      return proxyUrl(base, master ? 'manifest' : 'segment', resolveUrl(line, playlistUrl), growing)
    })
    .filter((line): line is string => line !== null)
    .join('\n')
}

export interface MediaProxyOptions {
  /** Public base URL of this server, used when rewriting playlists. */
  base: string
  /**
   * The same segment store the exporter reads and writes.
   *
   * Watching a moment and exporting it are the same bytes. Without this the
   * player fetched them on its own path and threw them away, so every second
   * the editor actually looked at was downloaded twice — once to watch across
   * nine to twenty angles, once again to cut. Optional so the proxy still
   * works uncached in tests.
   */
  segments?: {
    keyFor(input: string): string
    has(key: string): Promise<number | null>
    pathFor(key: string): string
    put(key: string, data: Buffer): Promise<unknown>
  }
  /** Optional so the proxy still runs uncached and unlogged in tests. */
  log?: { warn(scope: string, message: string, data?: unknown): void }
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

  // Before anything is fetched. See SESSION_TOKEN.
  if (!hasSessionToken(url, options.base)) {
    // Worth a line: if this ever fires for the app's own player, the two URL
    // builders have drifted apart again and every POV is black.
    options.log?.warn('proxy', 'Refused a media request that could not prove it came from the app')
    res.writeHead(403, { ...cors, 'content-type': 'text/plain' }).end('Not this proxy')
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

  /*
   * A plain whole-segment GET is the cacheable case, and the only one.
   *
   * A ranged request is the player seeking inside a progressive file, which
   * is not what the exporter stores, and a manifest changes per session.
   * Anything else falls through to the untouched pass-through below.
   */
  const cacheable = isSegment && req.method === 'GET' && !req.headers.range && options.segments
  const cacheKey = cacheable ? options.segments!.keyFor(target.toString()) : null

  if (cacheKey && options.segments) {
    const size = await options.segments.has(cacheKey).catch(() => null)
    if (size) {
      const cached = createReadStream(options.segments.pathFor(cacheKey))
      res.writeHead(200, {
        ...cors,
        'content-type': 'video/mp2t',
        'content-length': String(size),
        'accept-ranges': 'bytes'
      })
      cached.on('error', () => res.destroy())
      cached.pipe(res)
      return true
    }
  }

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
    // Carried down the chain: a variant playlist reached from a growing
    // master is growing too, and the request that asked for it says so.
    const growing = new URL(url, options.base).searchParams.get('growing') === '1'
    const body = rewritePlaylist(text, upstream.url || target.toString(), options.base, growing)
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

  // Write it through on the way past, so the export that follows finds it
  // already on disk. Collected rather than tee'd because the store wants one
  // buffer, and a segment is a couple of megabytes at most.
  if (cacheKey && options.segments && upstream.status === 200) {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => {
      // Best-effort: a failed write costs a re-download later, never the
      // playback happening now.
      void options.segments!.put(cacheKey, Buffer.concat(chunks)).catch(() => undefined)
    })
  }

  stream.pipe(res)
  return true
}
