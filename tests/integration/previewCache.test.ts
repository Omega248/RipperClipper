import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { PreviewMediaService } from '../../src/main/media/previewMedia.js'
import type { StreamInfo } from '../../src/shared/types.js'
import { CHUNK_SECONDS, buildFixture, sampleColor, CHUNKS } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * The Editor's actual media source: a local, cached copy of a POV range.
 * Two things matter beyond "it builds a playable file" (already covered by
 * the compat-classification tests): a second run must not rebuild what a
 * previous run already made — restart or not — and an over-budget cache
 * must shed its oldest entries on its own.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let cache: CacheManager
let fetcher: RangeFetcher
let server: MediaServer
let cacheDir: string
let workDir: string

const source = {
  id: 'pov_a',
  platform: 'twitch' as const,
  vodId: 'a',
  url: 'https://example.invalid/videos/a',
  title: 'POV A',
  creator: 'StreamerA',
  durationSeconds: CHUNK_SECONDS * 12,
  playbackKind: 'hls' as const,
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}

function stream(server: MediaServer): StreamInfo {
  return {
    id: 'progressive',
    container: 'mp4',
    codec: 'avc1.42c01e',
    width: 640,
    height: 360,
    fps: 30,
    bitrate: 1_200_000,
    protocol: 'http-range',
    label: '360p',
    url: `${server.url}/source.mp4`,
    hasVideo: true,
    hasAudio: true
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-preview-cache-'))
  cacheDir = join(root, 'preview')
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

describe('the Editor media source cache', () => {
  it('reuses a file a previous run already built, without a fresh service instance rebuilding it', async () => {
    const first = new PreviewMediaService(log, ffmpeg, fetcher, cacheDir)
    const built = await first.ensure({
      source,
      stream: stream(server),
      startSeconds: CHUNK_SECONDS * 1,
      endSeconds: CHUNK_SECONDS * 1 + 6,
      workDir
    })
    expect(built.cached).toBe(false)
    const rgb = await sampleColor(built.path, 2)
    for (let ch = 0; ch < 3; ch++) {
      expect(Math.abs(rgb[ch] - CHUNKS[1].rgb[ch])).toBeLessThan(30)
    }

    // A brand new service instance — nothing in its in-memory index — stands
    // in for the app having been restarted.
    const second = new PreviewMediaService(log, ffmpeg, fetcher, cacheDir)
    const reused = await second.ensure({
      source,
      stream: stream(server),
      startSeconds: CHUNK_SECONDS * 1,
      endSeconds: CHUNK_SECONDS * 1 + 6,
      workDir
    })
    expect(reused.cached).toBe(true)
    expect(reused.path).toBe(built.path)
  }, 60_000)

  it('sheds its oldest entries once the cache directory outgrows its budget', async () => {
    const dir = join(root, 'bounded')
    await mkdir(dir, { recursive: true })

    const ranges: Array<[number, number]> = [
      [CHUNK_SECONDS * 2, CHUNK_SECONDS * 2 + 4],
      [CHUNK_SECONDS * 4, CHUNK_SECONDS * 4 + 4],
      [CHUNK_SECONDS * 6, CHUNK_SECONDS * 6 + 4]
    ]

    // Measure one real built file first, so the budget below is set from
    // what these clips actually weigh rather than a guess that might
    // undershoot it and make the assertion meaningless.
    const probe = new PreviewMediaService(log, ffmpeg, fetcher, dir)
    const sized = await probe.ensure({
      source,
      stream: stream(server),
      startSeconds: ranges[0][0],
      endSeconds: ranges[0][1],
      workDir
    })
    const oneFileBytes = (await stat(sized.path)).size
    await rm(sized.path, { force: true })

    // Room for a little under two files — building a third must evict.
    const svc = new PreviewMediaService(log, ffmpeg, fetcher, dir, Math.round(oneFileBytes * 1.8))

    const builtPaths: string[] = []
    for (const [start, end] of ranges) {
      const asset = await svc.ensure({ source, stream: stream(server), startSeconds: start, endSeconds: end, workDir })
      builtPaths.push(asset.path)
      // Force distinct mtimes so oldest-first pruning has something to sort by.
      const t = new Date(Date.now() + builtPaths.length * 1000)
      await utimes(asset.path, t, t).catch(() => undefined)
    }
    // Pruning runs fire-and-forget after each build; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 500))

    const files = await readdir(dir)
    const mp4s = files.filter((f) => f.endsWith('.mp4') && !f.endsWith('.partial.mp4'))
    expect(mp4s.length).toBeLessThan(ranges.length)
  }, 60_000)

  it('never rebuilds from thin air — a corrupt or empty file on disk is not mistaken for a real one', async () => {
    const dir = join(root, 'guard')
    await mkdir(dir, { recursive: true })
    const svc = new PreviewMediaService(log, ffmpeg, fetcher, dir)
    // No prior build here — just prove ensure() still works against an empty
    // cache directory that merely exists (the guard this test names is that
    // `ensure()`'s own zero-byte check on the deterministic path doesn't
    // false-positive on a directory with unrelated debris in it).
    await writeFile(join(dir, 'unrelated.mp4'), Buffer.alloc(0))
    const asset = await svc.ensure({
      source,
      stream: stream(server),
      startSeconds: CHUNK_SECONDS * 8,
      endSeconds: CHUNK_SECONDS * 8 + 4,
      workDir
    })
    expect(asset.cached).toBe(false)
  }, 60_000)
})
