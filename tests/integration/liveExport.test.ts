import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { Exporter } from '../../src/main/media/exporter.js'
import { LiveService } from '../../src/main/services/live.js'
import { runChecked } from '../../src/main/services/process.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { StreamInfo, VodSource } from '../../src/shared/types.js'
import { sampleColor, sampleFrequency } from '../helpers/mediaFixture.js'

/**
 * Clipping a broadcast that is still happening.
 *
 * The other live test proves the buffer holds the right *bytes*. This one
 * proves the whole path: real decodable segments arrive over a real socket
 * into the rolling buffer, and a clip cut from held media comes out as the
 * frames that were actually on screen at that moment on the wall clock.
 *
 * That last part is the point. A live clip's in and out are instants in the
 * real world, not offsets into a recording — nothing has an offset yet — so
 * the test asks for a range by epoch and checks the picture and the sound
 * against what the fixture was broadcasting then.
 */

const SEGMENT_SECONDS = 2
const FPS = 30
/** A fixed instant, so a failure reads the same on every machine. */
const EPOCH = Date.parse('2026-08-29T14:00:00.000Z') / 1000

/** One colour and one tone per segment, so every instant is identifiable. */
const SEGMENTS = [
  { hex: '0xE00000', rgb: [224, 0, 0], freq: 220 },
  { hex: '0x00C000', rgb: [0, 192, 0], freq: 262 },
  { hex: '0x0000E0', rgb: [0, 0, 224], freq: 294 },
  { hex: '0xE0E000', rgb: [224, 224, 0], freq: 330 },
  { hex: '0xE000E0', rgb: [224, 0, 224], freq: 349 },
  { hex: '0x00E0E0', rgb: [0, 224, 224], freq: 392 },
  { hex: '0xFFFFFF', rgb: [255, 255, 255], freq: 440 },
  { hex: '0x202020', rgb: [32, 32, 32], freq: 494 }
] as const

/** Which segment was on air at an instant on the event clock. */
function segmentAt(epoch: number): (typeof SEGMENTS)[number] {
  const index = Math.floor((epoch - EPOCH) / SEGMENT_SECONDS)
  return SEGMENTS[Math.min(SEGMENTS.length - 1, Math.max(0, index))]
}

let root: string
let log: Logger
let ffmpeg: FfmpegService
let exporter: Exporter
let live: LiveService
let server: Server
let originUrl = ''
let outDir: string
let workDir: string
const media: Buffer[] = []

const SOURCE: VodSource = {
  id: 'live:fixture',
  platform: 'twitch',
  vodId: 'fixturechannel',
  url: 'https://www.twitch.tv/fixturechannel',
  title: 'Fixture is live',
  creator: 'Fixture',
  // A broadcast has no length. This is what the app carries for one.
  durationSeconds: 0,
  isLive: true,
  playbackKind: 'hls',
  capabilities: { notes: [] },
  formatsInspected: true
}

function liveStream(): StreamInfo {
  return {
    id: 'live',
    protocol: 'hls',
    label: 'source',
    container: 'ts',
    codec: 'avc1.42c01e',
    url: `${originUrl}/live.m3u8`,
    hasVideo: true,
    hasAudio: true
  }
}

function streams(): SelectedStreams {
  return { video: liveStream(), audio: null, muxed: true, notes: [] }
}

/** The whole broadcast, as a live playlist that never ends. */
function playlist(): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-PROGRAM-DATE-TIME:${new Date(EPOCH * 1000).toISOString()}`
  ]
  for (let i = 0; i < media.length; i++) {
    lines.push(`#EXTINF:${SEGMENT_SECONDS}.000,`, `${i}.ts`)
  }
  // No ENDLIST: this broadcast is still going.
  return lines.join('\n') + '\n'
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'live-export-'))
  outDir = join(root, 'out')
  workDir = join(root, 'work')
  await mkdir(outDir, { recursive: true })
  await mkdir(workDir, { recursive: true })

  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  if (!(await ffmpeg.detect({})).available) throw new Error('FFmpeg is required to run the integration tests')

  /*
   * Real segments, cut the way a live encoder cuts them.
   *
   * One continuous recording, then split — not encoded a segment at a time. A
   * run of independently encoded files each starts its timestamps at zero, and
   * concatenating those gives a stream whose clock resets every two seconds.
   * No encoder emits that, and a fixture that did would be testing a situation
   * the app will never meet.
   *
   * Built with the `concat` *filter* in a single process rather than one
   * process per block plus a demuxer pass. Ten spawns took three minutes on
   * Windows under a parallel test run and blew the hook timeout; two spawns do
   * not. Process creation is cheap on Linux and is not cheap everywhere.
   */
  const colourInputs = SEGMENTS.flatMap((segment) => [
    '-f', 'lavfi', '-i', `color=c=${segment.hex}:s=320x180:r=${FPS}:d=${SEGMENT_SECONDS}`
  ])
  const toneInputs = SEGMENTS.flatMap((segment) => [
    '-f', 'lavfi', '-i', `sine=frequency=${segment.freq}:sample_rate=48000:duration=${SEGMENT_SECONDS}`
  ])
  // Inputs interleave as v0 a0 v1 a1 …, so the concat filter is given them in
  // that order and produces one video and one audio stream.
  const videoRefs = SEGMENTS.map((_, i) => `[${i}:v]`).join('')
  const toneRefs = SEGMENTS.map((_, i) => `[${SEGMENTS.length + i}:a]`).join('')
  const broadcast = join(root, 'broadcast.mp4')
  await runChecked('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...colourInputs, ...toneInputs,
    '-filter_complex',
    `${videoRefs}concat=n=${SEGMENTS.length}:v=1:a=0[v];${toneRefs}concat=n=${SEGMENTS.length}:v=0:a=1[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    // One keyframe per segment, as a live encoder produces.
    '-g', String(FPS * SEGMENT_SECONDS), '-keyint_min', String(FPS * SEGMENT_SECONDS),
    '-sc_threshold', '0', '-bf', '0',
    '-c:a', 'aac', '-b:a', '128k',
    broadcast
  ])
  await runChecked('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', broadcast, '-c', 'copy',
    '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-segment_format', 'mpegts',
    join(root, '%d.ts')
  ])

  /*
   * Read whatever ffmpeg actually produced, rather than however many were
   * asked for.
   *
   * A sixteen-second source cut every two seconds is eight segments on Linux
   * and was seven on Windows — the encoders round the last block differently,
   * and the fixture has no business having an opinion about that. Everything
   * below derives from the files that exist.
   */
  for (let i = 0; ; i++) {
    const bytes = await readFile(join(root, `${i}.ts`)).catch(() => null)
    if (!bytes) break
    media.push(bytes)
  }
  if (media.length < 4) {
    throw new Error(`the fixture produced only ${media.length} segments; the test needs at least 4`)
  }

  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path.endsWith('.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(playlist())
      return
    }
    const index = Number(/(\d+)\.ts$/.exec(path)?.[1])
    if (!Number.isFinite(index) || !media[index]) {
      res.writeHead(404).end('no such segment')
      return
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' }).end(media[index])
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no address')
  originUrl = `http://127.0.0.1:${address.port}`

  const cache = new CacheManager(log, join(root, 'cache'), 64 * 1024 * 1024)
  await cache.ensure()
  const fetcher = new RangeFetcher(log, ffmpeg, cache, workDir)
  exporter = new Exporter(log, ffmpeg, fetcher)
  live = new LiveService(log, () => undefined)
  exporter.setLiveMedia(live)

  // Hold the broadcast, and wait for the whole fixture to be in the buffer.
  await live.watch(SOURCE, liveStream())
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    // Whatever was actually segmented, less a moment at the end: the last
    // segment may be short.
    if (live.covers(SOURCE.id, EPOCH, EPOCH + media.length * SEGMENT_SECONDS - 0.5)) break
    await new Promise((r) => setTimeout(r, 100))
  }
}, 300_000)

afterAll(async () => {
  live?.stopAll()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

describe('clipping a live broadcast', () => {
  it('holds the broadcast as it arrives', () => {
    const state = live.stateOf(SOURCE.id)
    expect(state?.state).toBe('live')
    expect(state?.bufferedSeconds).toBeGreaterThan(0)
  })

  it('cuts a clip from held media, on the wall clock', async () => {
    // Deliberately mid-segment at both ends, and spanning three segments, so
    // the cut has to be exact rather than landing on convenient boundaries.
    const startEpoch = EPOCH + 5
    const endEpoch = EPOCH + 11

    const result = await exporter.exportClip({
      clipId: 'live-1',
      clipName: 'Live Clip',
      startSeconds: startEpoch,
      endSeconds: endEpoch,
      source: SOURCE,
      streams: streams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart', keyframeToleranceSeconds: 0.2 },
      outputPath: join(outDir, 'Live Clip.mp4'),
      workDir,
      onProgress: () => undefined
    })

    expect(result.verification.problems).toEqual([])
    expect(result.verification.durationSeconds).toBeCloseTo(endEpoch - startEpoch, 0)
    expect(result.verification.video.present).toBe(true)
    expect(result.verification.audio.present).toBe(true)
    // Nothing was fetched from the platform: the media was already here.
    expect(result.cachedSegments).toBe(0)
    expect(result.totalSegments).toBe(0)

    // The frames that were actually on air at those instants.
    for (const at of [0.2, 1.5, 3.5, 5.5]) {
      const [r, g, b] = await sampleColor(result.outputPath, at)
      const want = segmentAt(startEpoch + at).rgb
      expect(Math.abs(r - want[0])).toBeLessThanOrEqual(24)
      expect(Math.abs(g - want[1])).toBeLessThanOrEqual(24)
      expect(Math.abs(b - want[2])).toBeLessThanOrEqual(24)
    }
    for (const at of [0.5, 3.5, 5.5]) {
      const freq = await sampleFrequency(result.outputPath, at)
      expect(freq).toBeCloseTo(segmentAt(startEpoch + at).freq, -1)
    }
  }, 120_000)

  it('cuts correctly when the clip starts exactly on a segment boundary', async () => {
    // The buffer hands over whole segments, so this is the case where no
    // trimming is needed at the front at all — and where an off-by-one
    // segment would look identical to a correct cut on the first frame alone.
    const startEpoch = EPOCH + 4
    const result = await exporter.exportClip({
      clipId: 'live-3',
      clipName: 'Boundary',
      startSeconds: startEpoch,
      endSeconds: startEpoch + 6,
      source: SOURCE,
      streams: streams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart', keyframeToleranceSeconds: 0.5 },
      outputPath: join(outDir, 'Boundary.mp4'),
      workDir,
      onProgress: () => undefined
    })
    expect(result.verification.problems).toEqual([])
    for (const at of [0.2, 2.5, 4.5]) {
      const [r, g, b] = await sampleColor(result.outputPath, at)
      const want = segmentAt(startEpoch + at).rgb
      expect(Math.abs(r - want[0])).toBeLessThanOrEqual(24)
      expect(Math.abs(g - want[1])).toBeLessThanOrEqual(24)
      expect(Math.abs(b - want[2])).toBeLessThanOrEqual(24)
    }
  }, 120_000)

  it('says so plainly when the moment has aged out of the buffer', async () => {
    await expect(
      exporter.exportClip({
        clipId: 'live-2',
        clipName: 'Long Gone',
        // An hour before the broadcast the fixture is holding.
        startSeconds: EPOCH - 3600,
        endSeconds: EPOCH - 3590,
        source: SOURCE,
        streams: streams(),
        settings: { ...DEFAULT_EXPORT_SETTINGS },
        outputPath: join(outDir, 'Long Gone.mp4'),
        workDir,
        onProgress: () => undefined
      })
    ).rejects.toMatchObject({ code: 'live-range-gone' })
  })
})
