import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { Exporter } from '../../src/main/media/exporter.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { StreamInfo, VodSource } from '../../src/shared/types.js'
import {
  CHUNKS,
  CHUNK_SECONDS,
  TOTAL_SECONDS,
  buildFixture,
  chunkIndexAt,
  sampleColor,
  sampleFrequency
} from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * Separate video POV and audio POV, proven with real media.
 *
 * The fixture VOD gives every 10-second chunk its own colour *and* its own
 * audio tone. Cutting the picture from one chunk and the sound from another is
 * exactly what two POVs of the same moment look like to the exporter — and the
 * output can be checked frame by frame and tone by tone, so "the audio came
 * from the other POV" is measured, not assumed.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let cache: CacheManager
let fetcher: RangeFetcher
let exporter: Exporter
let server: MediaServer
let outDir: string
let workDir: string

const SOURCE: VodSource = {
  id: 'test:local',
  platform: 'twitch',
  vodId: 'local',
  url: 'https://example.invalid/videos/local',
  title: 'Local Test VOD',
  creator: 'Fixture',
  durationSeconds: TOTAL_SECONDS,
  createdAt: '2026-08-17T00:00:00.000Z',
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}

function progressive(): StreamInfo {
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

function videoOnlySelection(): SelectedStreams {
  return { video: progressive(), audio: null, muxed: true, notes: [] }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-audiopov-'))
  outDir = join(root, 'out')
  workDir = join(root, 'work')
  await mkdir(outDir, { recursive: true })
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
  exporter = new Exporter(log, ffmpeg, fetcher)
}, 300_000)

afterAll(async () => {
  await server?.close()
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

describe('video from one POV, audio from another', () => {
  it('takes the picture and the sound from different places on the timeline', async () => {
    // Picture: chunk 2 (blue, 294 Hz). Sound: chunk 6 (white, 440 Hz) — i.e.
    // the "other POV" was 40 seconds ahead on its own clock.
    const videoStart = 2 * CHUNK_SECONDS + 2 // 22s
    const audioStart = 6 * CHUNK_SECONDS + 2 // 62s
    const duration = 6

    const result = await exporter.exportClip({
      clipId: 'clip-two-povs',
      clipName: 'Two POVs',
      startSeconds: videoStart,
      endSeconds: videoStart + duration,
      source: SOURCE,
      streams: videoOnlySelection(),
      audioOverride: {
        stream: progressive(),
        startSeconds: audioStart,
        endSeconds: audioStart + duration
      },
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise', container: 'mp4' },
      outputPath: join(outDir, 'two-povs.mp4'),
      workDir,
      onProgress: () => undefined
    })

    expect(result.verification.ok).toBe(true)
    expect(result.verification.video.present).toBe(true)
    expect(result.verification.audio.present).toBe(true)

    // The picture is the video POV's chunk...
    const [r, g, b] = await sampleColor(result.outputPath, 1)
    const expected = CHUNKS[chunkIndexAt(videoStart + 1)].rgb
    expect(Math.abs(r - expected[0])).toBeLessThan(40)
    expect(Math.abs(g - expected[1])).toBeLessThan(40)
    expect(Math.abs(b - expected[2])).toBeLessThan(40)

    // ...and the sound is the audio POV's, not the video POV's.
    const tone = await sampleFrequency(result.outputPath, 1)
    const audioTone = CHUNKS[chunkIndexAt(audioStart + 1)].freq
    const videoTone = CHUNKS[chunkIndexAt(videoStart + 1)].freq
    expect(Math.abs(tone - audioTone)).toBeLessThan(12)
    expect(Math.abs(tone - videoTone)).toBeGreaterThan(30)
  }, 300_000)

  it('keeps the two in sync: both streams start together and run the full length', async () => {
    const result = await exporter.exportClip({
      clipId: 'clip-two-povs-sync',
      clipName: 'Two POVs Sync',
      startSeconds: 33,
      endSeconds: 41,
      source: SOURCE,
      streams: videoOnlySelection(),
      audioOverride: { stream: progressive(), startSeconds: 73, endSeconds: 81 },
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise', container: 'mp4' },
      outputPath: join(outDir, 'two-povs-sync.mp4'),
      workDir,
      onProgress: () => undefined
    })

    const probe = await ffmpeg.probe(result.outputPath)
    for (const stream of probe.streams) {
      expect(Number(stream.start_time ?? 0)).toBeLessThan(0.1)
    }
    expect(result.verification.durationSeconds).toBeGreaterThan(7.5)
    expect(result.verification.durationSeconds).toBeLessThan(8.6)

    // The tone must still be the audio POV's for the whole clip, not just at
    // the start — a drifting offset would show up here.
    for (const at of [1, 4, 6.5]) {
      const tone = await sampleFrequency(result.outputPath, at)
      expect(Math.abs(tone - CHUNKS[chunkIndexAt(73 + at)].freq)).toBeLessThan(14)
    }
  }, 300_000)
})
