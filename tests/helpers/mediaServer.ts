import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import { extname, join, normalize, resolve, sep } from 'node:path'

/**
 * Static media server with HTTP Range support, used to stand in for a CDN.
 * It records every request so tests can assert that the exporter fetched only
 * the segments (or byte ranges) it actually needed.
 */
export interface MediaServer {
  url: string
  requests: Array<{ path: string; range: string | null; bytesSent: number }>
  bytesServed(): number
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment'
}

export async function startMediaServer(rootDir: string): Promise<MediaServer> {
  const root = resolve(rootDir)
  const requests: MediaServer['requests'] = []

  const server: Server = createServer((req, res) => {
    void (async () => {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      const target = resolve(join(root, normalize(urlPath)))
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end('Forbidden')
        return
      }

      const info = await stat(target).catch(() => null)
      if (!info || !info.isFile()) {
        res.writeHead(404).end('Not found')
        return
      }

      const rangeHeader = req.headers.range ?? null
      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      const record = { path: urlPath, range: rangeHeader, bytesSent: 0 }
      requests.push(record)

      if (req.method === 'HEAD') {
        res
          .writeHead(200, {
            'content-type': type,
            'content-length': String(info.size),
            'accept-ranges': 'bytes'
          })
          .end()
        return
      }

      if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
        if (match) {
          const start = match[1] === '' ? Math.max(0, info.size - Number(match[2])) : Number(match[1])
          const end = match[2] === '' || match[1] === '' ? info.size - 1 : Number(match[2])
          const clampedEnd = Math.min(end, info.size - 1)
          if (start > clampedEnd) {
            res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end()
            return
          }
          res.writeHead(206, {
            'content-type': type,
            'content-length': String(clampedEnd - start + 1),
            'content-range': `bytes ${start}-${clampedEnd}/${info.size}`,
            'accept-ranges': 'bytes'
          })
          // Count what is actually transferred: a client that seeks away mid
          // response should not be charged for the whole range.
          serve(createReadStream(target, { start, end: clampedEnd }), res, record)
          return
        }
      }

      res.writeHead(200, {
        'content-type': type,
        'content-length': String(info.size),
        'accept-ranges': 'bytes'
      })
      serve(createReadStream(target), res, record)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    bytesServed: () => requests.reduce((sum, r) => sum + r.bytesSent, 0),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.()
        server.close(() => done())
      })
  }
}

/**
 * Pipe a file to the client, counting only what it actually takes.
 *
 * The stream is destroyed when the response closes. Without that, a client
 * that seeks away — which is exactly the behaviour these tests are about —
 * leaves the file streaming on regardless, and the request is recorded as
 * having delivered the whole file. On a two-megabyte fixture that reads as a
 * rounding error; on a large one it is the difference between "read a few
 * megabytes and jumped" and "downloaded the lot".
 */
function serve(source: Readable, res: ServerResponse, record: { bytesSent: number }): void {
  source.on('data', (chunk: string | Buffer) => {
    record.bytesSent += Buffer.byteLength(chunk)
  })
  res.on('close', () => source.destroy())
  source.pipe(res)
}
