import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import type { StreamInfo } from '../../src/shared/types.js'
import { buildFixture } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * "Two clips with overlapping ranges: one download."
 *
 * The disk cache dedupes across *time* — a segment fetched an hour ago is free
 * now. It does nothing for two consumers that want the same segment at the
 * same moment, because neither has written the entry the other would hit, and
 * that is the ordinary case rather than the exotic one: a player, a queued
 * export and a prefetch all reaching for the media around the playhead.
 *
 * The media server records every request, so this measures the wire rather
 * than an internal counter that could agree with the bug.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let cache: CacheManager
let fetcher: RangeFetcher
let server: MediaServer
let workDir: string

function hlsStream(): StreamInfo {
  return {
    id: 'chunked',
    container: 'ts',
    codec: 'avc1.42c01e',
    width: 640,
    height: 360,
    fps: 30,
    bitrate: 1_200_000,
    protocol: 'hls',
    label: '360p',
    url: `${server.url}/hls/master.m3u8`,
    hasVideo: true,
    hasAudio: true
  }
}

/** Segment requests only — playlists are small, cheap and fetched per call. */
function segmentRequests(): string[] {
  return server.requests.filter((r) => r.path.endsWith('.ts')).map((r) => r.path)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-dedupe-'))
  workDir = join(root, 'work')
  await mkdir(workDir, { recursive: true })

  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  const info = await ffmpeg.detect({})
  if (!info.available) throw new Error('FFmpeg is required to run the integration tests')

  const fixture = await buildFixture(root)
  server = await startMediaServer(fixture.root)

  cache = new CacheManager(log, join(root, 'cache'), 512 * 1024 * 1024)
  await cache.ensure()
  fetcher = new RangeFetcher(log, ffmpeg, cache, workDir)
}, 300_000)

afterAll(async () => {
  await server?.close()
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

describe('overlapping selections share their media', () => {
  it('downloads a shared segment once when two windows are fetched at the same time', async () => {
    server.requests.length = 0

    // Two clips whose ranges overlap by twenty seconds, started together —
    // neither has finished, so neither has warmed the cache for the other.
    const [a, b] = await Promise.all([
      fetcher.fetchWindow({
        stream: hlsStream(),
        startSeconds: 30,
        endSeconds: 60,
        destination: join(workDir, 'a.ts')
      }),
      fetcher.fetchWindow({
        stream: hlsStream(),
        startSeconds: 40,
        endSeconds: 70,
        destination: join(workDir, 'b.ts')
      })
    ])

    expect(a.totalSegments).toBeGreaterThan(0)
    expect(b.totalSegments).toBeGreaterThan(0)

    const paths = segmentRequests()
    const unique = new Set(paths)
    expect(paths.length).toBe(unique.size)

    // And the overlap really was shared rather than the two windows happening
    // to need disjoint media.
    expect(a.cachedSegments + b.cachedSegments).toBeGreaterThan(0)
  }, 180_000)

  it('serves a later, wholly overlapping window without touching the network', async () => {
    server.requests.length = 0

    await fetcher.fetchWindow({
      stream: hlsStream(),
      startSeconds: 40,
      endSeconds: 55,
      destination: join(workDir, 'c.ts')
    })

    expect(segmentRequests()).toHaveLength(0)
  }, 180_000)
})
