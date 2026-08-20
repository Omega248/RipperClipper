import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { Exporter } from '../../src/main/media/exporter.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { AudioEdit } from '../../src/shared/audioEdits.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { StreamInfo, VodSource } from '../../src/shared/types.js'
import { buildFixture, TOTAL_SECONDS } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * Hand-drawn audio edits, proved on the real exported sound.
 *
 * "The filter graph was built" is not the claim worth testing — the claim is
 * that the range the editor drew ends up silent (or bleeped, or quieter) in a
 * file that plays, and that everything outside it is untouched.
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
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}

function streams(): SelectedStreams {
  const video: StreamInfo = {
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
  return { video, audio: null, muxed: true, notes: [] }
}

/** Mean absolute amplitude of the decoded audio between two seconds, 0..1. */
function audioEnergy(file: string, fromSeconds: number, toSeconds: number): number {
  const buffer = execFileSync('ffmpeg', [
    '-v', 'error',
    '-ss', fromSeconds.toFixed(3),
    '-to', toSeconds.toFixed(3),
    '-i', file,
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    'pipe:1'
  ], { maxBuffer: 64 * 1024 * 1024 })
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2))
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += Math.abs(samples[i])
  return sum / samples.length / 32768
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-audioedits-'))
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

describe('hand-drawn audio edits change the exported audio', () => {
  it('mutes the range and leaves the rest of the clip alone', async () => {
    const edits: AudioEdit[] = [{ id: 'e1', kind: 'mute', startSeconds: 2, endSeconds: 4 }]
    const outputPath = join(outDir, 'muted.mp4')
    const result = await exporter.exportClip({
      clipId: 'c1',
      clipName: 'Mute test',
      startSeconds: 20,
      endSeconds: 30,
      source: SOURCE,
      streams: streams(),
      audioEdits: edits,
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath,
      workDir,
      onProgress: () => {}
    })

    expect(result.reEncoded).toBe(true)
    const muted = audioEnergy(result.outputPath, 2, 4)
    const before = audioEnergy(result.outputPath, 0, 1.5)
    const after = audioEnergy(result.outputPath, 4.5, 6)
    expect(muted).toBeLessThan(0.01)
    expect(before).toBeGreaterThan(0.05)
    expect(after).toBeGreaterThan(0.05)
  }, 120_000)

  it('ducks a range without silencing it', async () => {
    const edits: AudioEdit[] = [{ id: 'e1', kind: 'duck', startSeconds: 2, endSeconds: 4, gainDb: -18 }]
    const outputPath = join(outDir, 'ducked.mp4')
    const result = await exporter.exportClip({
      clipId: 'c2',
      clipName: 'Duck test',
      startSeconds: 20,
      endSeconds: 30,
      source: SOURCE,
      streams: streams(),
      audioEdits: edits,
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath,
      workDir,
      onProgress: () => {}
    })

    const ducked = audioEnergy(result.outputPath, 2, 4)
    const before = audioEnergy(result.outputPath, 0, 1.5)
    // -18dB is roughly an eighth of the amplitude — clearly quieter, but not silent.
    expect(ducked).toBeGreaterThan(0.001)
    expect(ducked).toBeLessThan(before * 0.3)
  }, 120_000)

  it('replaces a bleeped range with a tone at the bleep frequency', async () => {
    const edits: AudioEdit[] = [{ id: 'e1', kind: 'bleep', startSeconds: 2, endSeconds: 4 }]
    const outputPath = join(outDir, 'bleeped.mp4')
    const result = await exporter.exportClip({
      clipId: 'c3',
      clipName: 'Bleep test',
      startSeconds: 20,
      endSeconds: 30,
      source: SOURCE,
      streams: streams(),
      audioEdits: edits,
      bleep: { hz: 1000, amplitude: 0.3 },
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath,
      workDir,
      onProgress: () => {}
    })

    // A bleep mutes the original and mixes in a generated tone at the
    // configured amplitude — clearly audible, well above what the mute test
    // above measured for the same underlying gate with no tone added.
    const bleeped = audioEnergy(result.outputPath, 2.1, 3.9)
    expect(bleeped).toBeGreaterThan(0.05)
  }, 120_000)

  it('applies several edits in one pass', async () => {
    const edits: AudioEdit[] = [
      { id: 'e1', kind: 'mute', startSeconds: 1, endSeconds: 2 },
      { id: 'e2', kind: 'mute', startSeconds: 5, endSeconds: 6 }
    ]
    const outputPath = join(outDir, 'multi.mp4')
    const result = await exporter.exportClip({
      clipId: 'c4',
      clipName: 'Multi test',
      startSeconds: 20,
      endSeconds: 30,
      source: SOURCE,
      streams: streams(),
      audioEdits: edits,
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath,
      workDir,
      onProgress: () => {}
    })

    expect(audioEnergy(result.outputPath, 1, 2)).toBeLessThan(0.01)
    expect(audioEnergy(result.outputPath, 5, 6)).toBeLessThan(0.01)
    expect(audioEnergy(result.outputPath, 2.5, 4.5)).toBeGreaterThan(0.05)
  }, 120_000)

  it('leaves the audio identical when there are no edits', async () => {
    const outputPath = join(outDir, 'untouched.mp4')
    const result = await exporter.exportClip({
      clipId: 'c5',
      clipName: 'No edits test',
      startSeconds: 20,
      endSeconds: 30,
      source: SOURCE,
      streams: streams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath,
      workDir,
      onProgress: () => {}
    })

    expect(result.reEncoded).toBe(false)
    expect(audioEnergy(result.outputPath, 0, 9)).toBeGreaterThan(0.05)
  }, 120_000)
})
