import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { ThumbnailService } from '../../src/main/media/thumbnails.js'
import type { StreamInfo } from '../../src/shared/types.js'
import { CHUNK_SECONDS, CHUNKS, buildFixture, sampleColor } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * The Editor's filmstrip, rendered against real video. Proves the frames
 * that come back actually show the requested window's own content — not
 * just that ffmpeg exited zero.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let cache: CacheManager
let fetcher: RangeFetcher
let thumbs: ThumbnailService
let server: MediaServer
let workDir: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-thumbnails-'))
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
  thumbs = new ThumbnailService(log, ffmpeg, fetcher)
}, 300_000)

afterAll(async () => {
  await server?.close()
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

function stream(): StreamInfo {
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

describe('the Editor filmstrip', () => {
  it('pulls evenly spaced frames that actually show the window asked for', async () => {
    // Chunk 3 alone: a single solid colour for its whole ten seconds, so any
    // frame pulled from this window should read back as that colour.
    const start = CHUNK_SECONDS * 3
    const end = start + CHUNK_SECONDS

    const result = await thumbs.thumbnails({
      stream: stream(),
      startSeconds: start,
      endSeconds: end,
      frameCount: 4,
      width: 96,
      workDir
    })

    expect(result.frames.length).toBeGreaterThanOrEqual(3)
    expect(result.frames.length).toBeLessThanOrEqual(4)

    const expected = CHUNKS[3].rgb
    for (let i = 0; i < result.frames.length; i++) {
      const dataUri = result.frames[i]
      expect(dataUri.startsWith('data:image/jpeg;base64,')).toBe(true)
      const bytes = Buffer.from(dataUri.slice('data:image/jpeg;base64,'.length), 'base64')
      expect(bytes.length).toBeGreaterThan(200)

      const framePath = join(workDir, `check-${i}.jpg`)
      await writeFile(framePath, bytes)
      const rgb = await sampleColor(framePath, 0)
      for (let ch = 0; ch < 3; ch++) {
        expect(Math.abs(rgb[ch] - expected[ch])).toBeLessThan(30)
      }
    }
  }, 120_000)
})
