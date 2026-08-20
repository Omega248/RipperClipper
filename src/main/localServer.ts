import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { handleMediaRequest } from './mediaProxy.js'

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

export async function startLocalServer(rendererDir: string | null): Promise<LocalServer> {
  const root = rendererDir ? resolve(rendererDir) : null
  let base = ''

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (await handleMediaRequest(req, res, { base })) return

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
        createReadStream(file!, { start, end }).pipe(res)
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
        createReadStream(file!).pipe(res)
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
      createReadStream(filePath).pipe(res)
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
