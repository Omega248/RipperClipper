import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pipeline } from 'node:stream'
import type { Server, ServerResponse } from 'node:http'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { handleMediaRequest } from './mediaProxy.js'
import type { MediaProxyOptions } from './mediaProxy.js'

/**
 * One loopback HTTP server with two jobs:
 *
 *  - serve the built renderer (production only), so the UI has a real http
 *    origin rather than file:// — required by the official YouTube IFrame
 *    player and by normal media loading;
 *  - host the same-origin media proxy used by the preview player.
 *
 * It binds to loopback only and refuses any path that escapes the renderer
 * output directory.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4',
  '.map': 'application/json; charset=utf-8'
}

/**
 * Watermark images are served from here rather than read as `file://` URLs.
 * The renderer is loaded over http from this same server, so a file:// image is
 * cross-origin and simply does not appear — which looked exactly like a broken
 * watermark. Serving them through the app's own origin fixes that and keeps
 * the renderer with no filesystem access of its own.
 */
let watermarkDir: string | null = null

export function setWatermarkDir(dir: string): void {
  watermarkDir = resolve(dir)
}

/**
 * Preview media the app generated for a range it could not play directly.
 * Files are handed out by id, never by path, so the renderer cannot ask for
 * anything the main process did not make for it.
 */
let localFiles: ((id: string) => string | null) | null = null

export function setLocalFileResolver(resolver: (id: string) => string | null): void {
  localFiles = resolver
}

export interface LocalServer {
  /** http://localhost:<port> — a hostname platforms accept as an embed parent. */
  url: string
  /** http://127.0.0.1:<port> — used if localhost fails to resolve. */
  loopbackUrl: string
  port: number
  close(): Promise<void>
}

/**
 * The segment store the media proxy should share with the exporter, if any.
 *
 * Set by the app at startup. Kept as a setter rather than a parameter so the
 * server can start before the cache directory has been settled from settings,
 * which is the order the app actually boots in.
 */
let segmentStore: MediaProxyOptions['segments'] = undefined

export function setMediaSegmentStore(store: MediaProxyOptions['segments']): void {
  segmentStore = store
}

/** Just enough of the Logger for this file; the real one satisfies it. */
type ServerLog = { warn(scope: string, message: string, data?: unknown): void }

/**
 * Send a file, and let go of it whatever happens.
 *
 * These three were `createReadStream(...).pipe(res)`. When a client abandons
 * a request — which the player does constantly, because every seek past the
 * buffered region and every change of clip or POV cancels the in-flight
 * ranged request and opens another — `res` closes, and `pipe` responds by
 * calling `unpipe`, which only *pauses* the source. An `fs.ReadStream` closes
 * its descriptor on `end` or on `destroy()`, and neither happens: the stream
 * is left paused, unreferenced and never ended, so its fd stays open for the
 * life of the main process.
 *
 * A scrubbing session leaks hundreds. The preview cache's prune then deletes
 * those files while the handles are still open, so the blocks are not
 * returned to the filesystem — the prune reports the space as freed, readdir
 * stops listing the files, and disk usage does not move, which quietly stops
 * the cache budget bounding anything. Far enough along it ends in EMFILE,
 * which fails every later file read at once: settings, project saves, the log.
 *
 * `pipeline` destroys the source on abort and on error, which is also the
 * read error `pipe` had no handler for at all.
 */
function send(stream: NodeJS.ReadableStream, res: ServerResponse, log?: ServerLog): void {
  pipeline(stream, res, (err: NodeJS.ErrnoException | null) => {
    // An aborted request is the normal case here, not a fault worth logging.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      log?.warn('server', 'Could not finish sending a file', err)
    }
  })
}

export async function startLocalServer(
  rendererDir: string | null,
  log?: ServerLog
): Promise<LocalServer> {
  const root = rendererDir ? resolve(rendererDir) : null
  let base = ''

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (await handleMediaRequest(req, res, { base, segments: segmentStore, log })) return

      const requested = decodeURIComponent((req.url ?? '/').split('?')[0])

      if (requested === '/local') {
        const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
        const file = localFiles?.(id) ?? null
        const info = file ? await stat(file).catch(() => null) : null
        if (!info?.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
          return
        }
        // Range support, so the player can scrub inside the preview.
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
        const start = range && range[1] ? Number(range[1]) : 0
        const end = range && range[2] ? Number(range[2]) : info.size - 1
        const headers = {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          'cache-control': 'no-store'
        }
        if (range) {
          res.writeHead(206, {
            ...headers,
            'content-range': `bytes ${start}-${end}/${info.size}`,
            'content-length': String(end - start + 1)
          })
        } else {
          res.writeHead(200, { ...headers, 'content-length': String(info.size) })
        }
        send(createReadStream(file!, { start, end }), res, log)
        return
      }
      if (requested.startsWith('/watermark/')) {
        // basename() only: a name, never a path, so ../ cannot escape.
        const file = watermarkDir
          ? join(watermarkDir, basename(requested.slice('/watermark/'.length)))
          : null
        const info = file ? await stat(file).catch(() => null) : null
        if (!info?.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
          return
        }
        res.writeHead(200, {
          'content-type': MIME[extname(file!).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(info.size),
          'cache-control': 'no-store'
        })
        send(createReadStream(file!), res, log)
        return
      }
      if (!root) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
        return
      }

      const requestPath = requested
      const candidate = resolve(join(root, normalize(requestPath)))
      const inside = candidate === root || candidate.startsWith(root + sep)
      let filePath = inside ? candidate : root

      try {
        const info = await stat(filePath)
        if (info.isDirectory()) filePath = join(filePath, 'index.html')
      } catch {
        // Unknown paths fall back to the SPA entry point.
        filePath = join(root, 'index.html')
      }

      const info = await stat(filePath).catch(() => null)
      if (!info || !info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
        return
      }

      res.writeHead(200, {
        'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(info.size),
        'cache-control': 'no-cache'
      })
      send(createReadStream(filePath), res, log)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Internal error')
    })
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  base = `http://127.0.0.1:${port}`

  return {
    url: `http://localhost:${port}`,
    loopbackUrl: base,
    port,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.()
        server.close(() => done())
      })
  }
}
