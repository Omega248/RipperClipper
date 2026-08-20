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
import { defaultWatermark } from '../../src/shared/watermark.js'
import type { ResolvedWatermark, WatermarkAnchor } from '../../src/shared/watermark.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { StreamInfo, VodSource } from '../../src/shared/types.js'
import { buildFixture, CHUNK_SECONDS, TOTAL_SECONDS } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'
import { execFileSync } from 'node:child_process'

/**
 * Watermarks, proved on real exported pixels.
 *
 * "The filter was built" is not the claim worth testing — the claim is that the
 * logo ends up in the corner the editor put it in, at the size they chose, in a
 * file that plays. So these export real video and then sample the actual
 * output frames.
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
let logoPath: string
let discPath: string

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

/**
 * Mean colour of a rectangle of one exported frame, as 0..255 per channel.
 * Sampling the picture is the only way to know the overlay really happened.
 */
function patchColour(
  file: string,
  atSeconds: number,
  crop: { w: number; h: number; x: number; y: number }
): { r: number; g: number; b: number } {
  // Crop the region, average it to a single pixel, and read the raw bytes.
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

/** A solid green PNG. Chunk 4 of the fixture is magenta, so green is the
 * colour that cannot be confused with the picture underneath it. */
function writeLogo(path: string, width: number, height: number): void {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x00FF00:s=${width}x${height}`,
    '-frames:v', '1',
    path
  ])
}

/**
 * A logo with a real alpha channel: a solid green disc on a fully transparent
 * background. Almost every logo an editor actually uses is shaped like this,
 * and an opaque test rectangle cannot tell whether the alpha survived the
 * filter graph — a watermark that arrives as a green *box* passes every
 * position test while being visibly wrong.
 */
function writeTransparentLogo(path: string, size: number): void {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x00FF00:s=${size}x${size}`,
    '-vf',
    // alpha = 255 inside the inscribed circle, 0 outside it.
    `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
      `a='if(lte(hypot(X-${size / 2},Y-${size / 2}),${size / 2 - 2}),255,0)'`,
    '-frames:v', '1',
    path
  ])
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-watermark-'))
  outDir = join(root, 'out')
  workDir = join(root, 'work')
  await mkdir(outDir, { recursive: true })
  await mkdir(workDir, { recursive: true })

  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  const info = await ffmpeg.detect({})
  if (!info.available) throw new Error('FFmpeg is required to run the integration tests')

  logoPath = join(root, 'logo.png')
  writeLogo(logoPath, 200, 100)
  discPath = join(root, 'disc.png')
  writeTransparentLogo(discPath, 200)

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

function watermark(over: Partial<ResolvedWatermark['config']> = {}): ResolvedWatermark {
  return {
    config: { ...defaultWatermark('logo'), opacity: 1, ...over },
    imagePath: logoPath,
    imageWidth: 200,
    imageHeight: 100
  }
}

/** The same, but the logo is the transparent-background disc. */
function discWatermark(over: Partial<ResolvedWatermark['config']> = {}): ResolvedWatermark {
  return {
    config: { ...defaultWatermark('disc'), opacity: 1, ...over },
    imagePath: discPath,
    imageWidth: 200,
    imageHeight: 200
  }
}

async function exportWith(name: string, mark: ResolvedWatermark | undefined): Promise<string> {
  const start = 4 * CHUNK_SECONDS
  const result = await exporter.exportClip({
    clipId: name,
    clipName: name,
    startSeconds: start,
    endSeconds: start + 2,
    source: SOURCE,
    streams: streams(),
    watermark: mark,
    settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart', container: 'mp4' },
    outputPath: join(outDir, `${name}.mp4`),
    workDir,
    onProgress: () => undefined
  })
  expect(result.verification.ok).toBe(true)
  return result.outputPath
}

/** The logo's green, which chunk 4's magenta cannot be mistaken for. */
const isLogo = (c: { r: number; g: number; b: number }): boolean =>
  c.g > 150 && c.r < 120 && c.b < 120

describe('watermarks reach the exported picture', () => {
  it('draws the logo in the corner it was given', async () => {
    const file = await exportWith(
      'top-right',
      watermark({ anchor: 'top-right' as WatermarkAnchor, x: 0.975, y: 0.025, width: 0.2 })
    )
    // The fixture is 640×360. A 20 %-wide logo in the top right is roughly
    // x 460–620, y 9–73.
    expect(isLogo(patchColour(file, 1, { w: 60, h: 30, x: 500, y: 20 }))).toBe(true)
    // …and nowhere near the opposite corner.
    expect(isLogo(patchColour(file, 1, { w: 60, h: 30, x: 20, y: 300 }))).toBe(false)
  }, 300_000)

  it('puts it in the other corner when told to', async () => {
    const file = await exportWith(
      'bottom-left',
      watermark({ anchor: 'bottom-left' as WatermarkAnchor, x: 0.025, y: 0.975, width: 0.2 })
    )
    expect(isLogo(patchColour(file, 1, { w: 60, h: 30, x: 30, y: 290 }))).toBe(true)
    expect(isLogo(patchColour(file, 1, { w: 60, h: 30, x: 500, y: 20 }))).toBe(false)
  }, 300_000)

  it('scales with the frame rather than being pinned to pixels', async () => {
    // A 40 %-wide logo covers ground a 20 % one does not, in the same place.
    const wide = await exportWith(
      'wide',
      watermark({ anchor: 'top-right' as WatermarkAnchor, x: 0.975, y: 0.025, width: 0.4 })
    )
    expect(isLogo(patchColour(wide, 1, { w: 40, h: 20, x: 400, y: 40 }))).toBe(true)
  }, 300_000)

  it('keeps a transparent background transparent', async () => {
    // The disc fills a 128px-wide square in the top right of the 640×360
    // fixture: roughly x 496–624, y 9–137. Its centre must be the logo, and
    // its corners — inside the image's box, outside the disc — must still be
    // the picture underneath. That is the whole difference between a logo and
    // a green rectangle.
    const file = await exportWith(
      'alpha',
      discWatermark({ anchor: 'top-right' as WatermarkAnchor, x: 0.975, y: 0.025, width: 0.2 })
    )
    expect(isLogo(patchColour(file, 1, { w: 30, h: 30, x: 545, y: 58 }))).toBe(true)
    // Top-left corner of the image box, well outside the inscribed circle.
    expect(isLogo(patchColour(file, 1, { w: 12, h: 12, x: 499, y: 12 }))).toBe(false)
    // Bottom-right corner of the same box.
    expect(isLogo(patchColour(file, 1, { w: 12, h: 12, x: 609, y: 122 }))).toBe(false)
  }, 300_000)

  it('leaves the picture untouched when there is no watermark', async () => {
    const file = await exportWith('none', undefined)
    expect(isLogo(patchColour(file, 1, { w: 60, h: 30, x: 500, y: 20 }))).toBe(false)
  }, 300_000)

  it('re-encodes rather than silently dropping the logo from a stream copy', async () => {
    // Drawing on the picture and copying the picture are contradictory. The
    // watermark wins, and the note says so in the editor's terms.
    const start = 4 * CHUNK_SECONDS
    const result = await exporter.exportClip({
      clipId: 'copy',
      clipName: 'copy',
      startSeconds: start,
      endSeconds: start + 2,
      source: SOURCE,
      streams: streams(),
      watermark: watermark({ width: 0.2 }),
      // Explicitly asking for a copy — which cannot draw anything.
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy', container: 'mp4' },
      outputPath: join(outDir, 'copy.mp4'),
      workDir,
      onProgress: () => undefined
    })
    expect(result.reEncoded).toBe(true)
    expect(result.notes.join(' ')).toMatch(/watermark could be drawn/i)
    expect(isLogo(patchColour(result.outputPath, 1, { w: 60, h: 30, x: 500, y: 20 }))).toBe(true)
  }, 300_000)
})
