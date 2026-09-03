import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import type { FfmpegService } from '../../src/main/media/ffmpeg.js'
import type { StreamInfo } from '../../src/shared/types.js'

/**
 * Measures the sliding-window segment fetch against a server that answers
 * slowly, which is the only condition under which the change matters.
 *
 * A local server with no latency cannot show anything: the whole point of
 * fetching segments in parallel is to stop the connection idling during the
 * round trip, and a loopback round trip is ~0. So this one deliberately
 * delays every segment response, which is what a CDN on the other side of the
 * country does for free.
 */

const SEGMENT_COUNT = 40
const SEGMENT_BYTES = 16 * 1024
const RESPONSE_DELAY_MS = 40

let server: Server
let origin: string
let root: string
let log: Logger
let cache: CacheManager
let requestCount = 0
let peakConcurrent = 0

const payload = Buffer.alloc(SEGMENT_BYTES, 0x42)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rc-bench-'))
  log = new Logger(join(root, 'logs'))
  cache = new CacheManager(log, join(root, 'cache'), 64 * 1024 * 1024)
  await cache.ensure()

  let inFlight = 0
  server = createServer((req, res) => {
    if (req.url === '/media.m3u8') {
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-VERSION:3']
      for (let i = 0; i < SEGMENT_COUNT; i++) {
        lines.push('#EXTINF:4.000,', `seg-${i}.ts`)
      }
      lines.push('#EXT-X-ENDLIST')
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(lines.join('\n'))
      return
    }
    requestCount++
    inFlight++
    peakConcurrent = Math.max(peakConcurrent, inFlight)
    setTimeout(() => {
      inFlight--
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': String(payload.length)
      })
      res.end(payload)
    }, RESPONSE_DELAY_MS)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  origin = `http://127.0.0.1:${address.port}`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

function streamInfo(): StreamInfo {
  return {
    id: 'bench',
    protocol: 'hls',
    url: `${origin}/media.m3u8`,
    container: 'ts',
    codec: 'h264',
    hasVideo: true,
    hasAudio: true
  } as StreamInfo
}

async function timeFetch(parallelism: number, name: string): Promise<number> {
  // A fresh cache directory per run: a second run served from the cache would
  // measure disk, not the network behaviour under test.
  const runCache = new CacheManager(log, join(root, `cache-${name}`), 64 * 1024 * 1024)
  await runCache.ensure()
  const fetcher = new RangeFetcher(log, {} as FfmpegService, runCache, root)
  fetcher.setSegmentParallelism(parallelism)

  const destination = join(root, `${name}.ts`)
  const started = Date.now()
  const result = await fetcher.fetchWindow({
    stream: streamInfo(),
    startSeconds: 0,
    endSeconds: SEGMENT_COUNT * 4,
    destination
  })
  const elapsed = Date.now() - started

  expect(result.totalSegments).toBe(SEGMENT_COUNT)
  const written = await readFile(destination)
  expect(written.length).toBe(SEGMENT_COUNT * SEGMENT_BYTES)
  // Order is the whole correctness question for a parallel fetch: every byte
  // must be the payload, in playlist order, with nothing dropped or doubled.
  expect(written.every((b) => b === 0x42)).toBe(true)

  return elapsed
}

describe('HLS segment parallelism', () => {
  it('fetches segments concurrently and still writes them in order', async () => {
    requestCount = 0
    peakConcurrent = 0
    const serialMs = await timeFetch(1, 'serial')
    const serialPeak = peakConcurrent
    expect(requestCount).toBe(SEGMENT_COUNT)

    requestCount = 0
    peakConcurrent = 0
    const parallelMs = await timeFetch(8, 'parallel')
    const parallelPeak = peakConcurrent
    expect(requestCount).toBe(SEGMENT_COUNT)

    // eslint-disable-next-line no-console
    console.log(
      `\n  ${SEGMENT_COUNT} segments @ ${RESPONSE_DELAY_MS}ms latency\n` +
        `    parallelism 1: ${serialMs}ms  (peak ${serialPeak} concurrent)\n` +
        `    parallelism 8: ${parallelMs}ms  (peak ${parallelPeak} concurrent)\n` +
        `    speedup: ${(serialMs / parallelMs).toFixed(1)}x\n`
    )

    // One at a time means exactly that.
    expect(serialPeak).toBe(1)
    // The window really does keep several requests open at once.
    expect(parallelPeak).toBeGreaterThan(1)
    // Latency-bound work should scale close to the window size; 3x is a
    // deliberately loose floor so this cannot fail for timing noise.
    expect(parallelMs * 3).toBeLessThan(serialMs)
  }, 120_000)
})
