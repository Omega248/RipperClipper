import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
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
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * Which encoder actually ran, proved on the export result rather than
 * assumed from config — the whole point of the "Video: ..." note this adds.
 *
 * AV1 hardware availability varies by machine, so these tests check the
 * *policy* (never fall back to slow software AV1; always say plainly what
 * ran) rather than asserting a specific encoder name.
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
let av1SourcePath: string

const SOURCE: VodSource = {
  id: 'test:av1',
  platform: 'twitch',
  vodId: 'av1local',
  url: 'https://example.invalid/videos/av1local',
  title: 'AV1 Test VOD',
  creator: 'Fixture',
  durationSeconds: 4,
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}

function streams(): SelectedStreams {
  const video: StreamInfo = {
    id: 'progressive',
    container: 'mp4',
    codec: 'av01.0.04M.08',
    width: 320,
    height: 180,
    fps: 24,
    bitrate: 400_000,
    protocol: 'http-range',
    label: '180p',
    url: `${server.url}/av1-source.mp4`,
    hasVideo: true,
    hasAudio: true
  }
  return { video, audio: null, muxed: true, notes: [] }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-hwenc-'))
  outDir = join(root, 'out')
  workDir = join(root, 'work')
  await mkdir(outDir, { recursive: true })
  await mkdir(workDir, { recursive: true })

  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  const info = await ffmpeg.detect({})
  if (!info.available) throw new Error('FFmpeg is required to run the integration tests')

  // A real, small AV1-encoded source — libsvtav1 is only used to *build* the
  // fixture; the export path under test never touches it.
  av1SourcePath = join(root, 'av1-source.mp4')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libsvtav1', '-preset', '10', '-crf', '40',
    '-c:a', 'aac',
    av1SourcePath
  ])

  server = await startMediaServer(root)

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

describe('AV1 export policy', () => {
  it('names exactly which encoder ran, and never falls back to slow software AV1', async () => {
    const result = await exporter.exportClip({
      clipId: 'av1-clip',
      clipName: 'av1-clip',
      startSeconds: 0.5,
      endSeconds: 3,
      source: SOURCE,
      streams: streams(),
      // Forces a real re-encode rather than a stream copy, so
      // videoEncoderArgs is actually exercised.
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise', container: 'mp4' },
      outputPath: join(outDir, 'av1-clip.mp4'),
      workDir,
      onProgress: () => undefined
    })

    expect(result.verification.ok).toBe(true)

    const videoNote = result.notes.find((n) => n.startsWith('Video: '))
    expect(videoNote).toBeDefined()
    // The one thing this must never say: software AV1 is real but far too
    // slow to be the everyday path for a source that merely happens to be
    // AV1 on a machine without hardware for it.
    expect(videoNote).not.toContain('libsvtav1')
    // Whatever it says, it's specific — not a vague "it worked".
    expect(videoNote).toMatch(/av1_nvenc|libx265|libx264/)

    const probe = JSON.parse(
      execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'stream=codec_name,codec_type',
        '-of', 'json', result.outputPath!
      ]).toString()
    )
    const videoStream = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
    expect(['av1', 'hevc', 'h264']).toContain(videoStream.codec_name)
  }, 120_000)
})
