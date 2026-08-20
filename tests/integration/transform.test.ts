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
import type { StreamInfo, TimelineTransform, VodSource } from '../../src/shared/types.js'
import { buildFixture, CHUNK_SECONDS, CHUNKS, TOTAL_SECONDS } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * A timeline item's position/scale/rotation/opacity, proved on real exported
 * pixels — the same rigor as watermark.test.ts, for the same reason: "the
 * filter graph was built" doesn't tell you the clip actually landed where
 * the Inspector said it would.
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

/** Mean colour of a rectangle of one exported frame. */
function patchColour(
  file: string,
  atSeconds: number,
  crop: { w: number; h: number; x: number; y: number }
): { r: number; g: number; b: number } {
  const buffer = execFileSync(
    'ffmpeg',
    [
      '-v', 'error',
      '-ss', atSeconds.toFixed(2),
      '-i', file,
      '-frames:v', '1',
      '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=1:1`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      'pipe:1'
    ],
    { maxBuffer: 1024 * 1024 }
  )
  return { r: buffer[0], g: buffer[1], b: buffer[2] }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-transform-'))
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

async function exportWith(
  name: string,
  transform: TimelineTransform | undefined,
  opacity?: number
): Promise<string> {
  // Chunk 4 is magenta (224, 0, 224) — distinctive against black.
  const start = 4 * CHUNK_SECONDS
  const result = await exporter.exportClip({
    clipId: name,
    clipName: name,
    startSeconds: start,
    endSeconds: start + 2,
    source: SOURCE,
    streams: streams(),
    transform,
    opacity,
    settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart', container: 'mp4' },
    outputPath: join(outDir, `${name}.mp4`),
    workDir,
    onProgress: () => undefined
  })
  expect(result.verification.ok).toBe(true)
  return result.outputPath
}

const magenta = CHUNKS[4].rgb
const isMagenta = (c: { r: number; g: number; b: number }): boolean =>
  Math.abs(c.r - magenta[0]) < 30 && Math.abs(c.g - magenta[1]) < 30 && Math.abs(c.b - magenta[2]) < 30
const isBlack = (c: { r: number; g: number; b: number }): boolean => c.r < 20 && c.g < 20 && c.b < 20

describe('a timeline item transform reaches the exported picture', () => {
  it('leaves the frame untouched at the identity transform', async () => {
    const file = await exportWith('identity', { x: 0, y: 0, scale: 1, rotation: 0 })
    expect(isMagenta(patchColour(file, 1, { w: 60, h: 30, x: 290, y: 165 }))).toBe(true)
  }, 300_000)

  it('shrinks the picture around its centre, revealing black at the edges', async () => {
    const file = await exportWith('shrink', { x: 0, y: 0, scale: 0.5, rotation: 0 })
    // Centre still shows the clip…
    expect(isMagenta(patchColour(file, 1, { w: 40, h: 20, x: 300, y: 170 }))).toBe(true)
    // …but the corners, which the shrunk 320×180 picture no longer reaches, are black.
    expect(isBlack(patchColour(file, 1, { w: 40, h: 20, x: 10, y: 10 }))).toBe(true)
    expect(isBlack(patchColour(file, 1, { w: 40, h: 20, x: 590, y: 330 }))).toBe(true)
  }, 300_000)

  it('moves the picture off-centre in the direction requested', async () => {
    // Shrunk and pushed fully right (x=1 → moved by half the frame width).
    const file = await exportWith('shift-right', { x: 1, y: 0, scale: 0.5, rotation: 0 })
    // Now under the right half, not the left.
    expect(isMagenta(patchColour(file, 1, { w: 30, h: 20, x: 480, y: 170 }))).toBe(true)
    expect(isBlack(patchColour(file, 1, { w: 30, h: 20, x: 60, y: 170 }))).toBe(true)
  }, 300_000)

  it('fades the picture toward black at low opacity', async () => {
    const full = await exportWith('opacity-full', { x: 0, y: 0, scale: 1, rotation: 0 }, 1)
    const dim = await exportWith('opacity-dim', { x: 0, y: 0, scale: 1, rotation: 0 }, 0.3)
    const fullColour = patchColour(full, 1, { w: 60, h: 30, x: 290, y: 165 })
    const dimColour = patchColour(dim, 1, { w: 60, h: 30, x: 290, y: 165 })
    // Blended toward black: the channels magenta actually has drop; it has
    // no green to begin with, so that channel stays at zero either way.
    expect(dimColour.r).toBeLessThan(fullColour.r)
    expect(dimColour.b).toBeLessThan(fullColour.b)
  }, 300_000)
})
