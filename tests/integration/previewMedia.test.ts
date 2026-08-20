import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { PreviewMediaService } from '../../src/main/media/previewMedia.js'
import { runChecked } from '../../src/main/services/process.js'
import type { StreamInfo, VodSource } from '../../src/shared/types.js'
import { buildFixture, TOTAL_SECONDS } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * When the player cannot decode a source, the app makes the range playable
 * instead of showing an apology. These prove it produces real, seekable media
 * for the range asked for — and only that range.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let service: PreviewMediaService
let server: MediaServer

const SOURCE: VodSource = {
  id: 'test:local',
  platform: 'youtube',
  vodId: 'local',
  url: 'https://example.invalid/watch?v=local',
  title: 'Local Test VOD',
  creator: 'Fixture',
  durationSeconds: TOTAL_SECONDS,
  playbackKind: 'none',
  capabilities: { metadata: true, playback: false, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}

function stream(): StreamInfo {
  return {
    id: 'progressive',
    container: 'mp4',
    codec: 'avc1.42c01e',
    protocol: 'http-range',
    label: '360p',
    url: `${server.url}/source.mp4`,
    hasVideo: true,
    hasAudio: true
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-preview-media-'))
  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  if (!(await ffmpeg.detect({})).available) throw new Error('FFmpeg is required for these tests')
  const fixture = await buildFixture(root)
  server = await startMediaServer(fixture.root)
  const cache = new CacheManager(log, join(root, 'cache'), 256 * 1024 * 1024)
  await cache.ensure()
  const fetcher = new RangeFetcher(log, ffmpeg, cache, join(root, 'temp'))
  service = new PreviewMediaService(log, ffmpeg, fetcher, join(root, 'previewcache'))
}, 300_000)

afterAll(async () => {
  await server?.close()
  log?.close()
  await rm(root, { recursive: true, force: true })
})

describe('making an undecodable range playable', () => {
  it('produces a real file covering exactly the requested range', async () => {
    const asset = await service.ensure({
      source: SOURCE,
      stream: stream(),
      startSeconds: 40,
      endSeconds: 52,
      workDir: join(root, 'work')
    })

    expect(['native', 'remux', 'transcode']).toContain(asset.plan)
    expect((await stat(asset.path)).size).toBeGreaterThan(1000)

    const probe = await runChecked('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_name,codec_type',
      '-of',
      'json',
      asset.path
    ])
    const parsed = JSON.parse(probe.stdout)
    // The range, not the VOD: twelve seconds out of a two-minute fixture.
    expect(Number(parsed.format.duration)).toBeGreaterThan(11)
    expect(Number(parsed.format.duration)).toBeLessThan(13.5)
    const codecs = parsed.streams.map((s: { codec_name: string }) => s.codec_name)
    expect(codecs).toContain('h264')
    expect(parsed.streams.some((s: { codec_type: string }) => s.codec_type === 'audio')).toBe(true)
  }, 300_000)

  it('reuses the asset instead of rebuilding it', async () => {
    const first = await service.ensure({
      source: SOURCE,
      stream: stream(),
      startSeconds: 20,
      endSeconds: 26,
      workDir: join(root, 'work2')
    })
    const second = await service.ensure({
      source: SOURCE,
      stream: stream(),
      startSeconds: 20,
      endSeconds: 26,
      workDir: join(root, 'work2')
    })
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(service.resolve(second.id)).toBe(first.path)
  }, 300_000)

  it('hands out ids, not paths, and only for assets it made', () => {
    expect(service.resolve('not-a-real-id')).toBeNull()
  })

  it('refuses an empty range rather than making a zero-length file', async () => {
    await expect(
      service.ensure({
        source: SOURCE,
        stream: stream(),
        startSeconds: 30,
        endSeconds: 30,
        workDir: join(root, 'work3')
      })
    ).rejects.toThrow(/range/i)
  })
})
