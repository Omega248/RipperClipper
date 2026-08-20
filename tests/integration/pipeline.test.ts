import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { Exporter } from '../../src/main/media/exporter.js'
import { ExportQueue } from '../../src/main/services/queue.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { ExportJob, StreamInfo, VodSource } from '../../src/shared/types.js'
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
 * End-to-end exercise of the real media pipeline: HLS playlist parsing,
 * segment-range downloading, keyframe-aware cutting, muxing and ffprobe
 * verification — against a locally served VOD whose content is identifiable at
 * every timestamp.
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
let sourceSizeBytes = 0

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

function hlsStreams(): SelectedStreams {
  const video: StreamInfo = {
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
  return { video, audio: null, muxed: true, notes: [] }
}

function httpStreams(): SelectedStreams {
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-e2e-'))
  outDir = join(root, 'out')
  workDir = join(root, 'work')
  await mkdir(outDir, { recursive: true })
  await mkdir(workDir, { recursive: true })

  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  const info = await ffmpeg.detect({})
  if (!info.available) throw new Error('FFmpeg is required to run the integration tests')

  const fixture = await buildFixture(root)
  sourceSizeBytes = (await stat(fixture.sourceMp4)).size

  // Serve the whole fixture root so both the HLS directory and source.mp4 are
  // reachable; the HLS playlists live under /hls.
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

describe('fixture sanity', () => {
  it('produced a 120 second VOD whose content is identifiable at every second', async () => {
    const probe = await ffmpeg.probe(join(root, 'source.mp4'))
    expect(Number(probe.format.duration)).toBeCloseTo(TOTAL_SECONDS, 0)
    expect(probe.streams.some((s) => s.codec_type === 'video')).toBe(true)
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true)

    for (const at of [5, 25, 95]) {
      const rgb = await sampleColor(join(root, 'source.mp4'), at)
      const expected = CHUNKS[chunkIndexAt(at)].rgb
      expectColorNear(rgb, expected)
    }
  })
})

describe('HLS range export — the core requirement', () => {
  it('downloads only the covering segments, not the whole VOD', async () => {
    const before = server.bytesServed()
    const requestsBefore = server.requests.length

    const result = await exporter.exportClip({
      clipId: 'clip-a',
      clipName: 'Insane Fight',
      startSeconds: 23.5,
      endSeconds: 37.25,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
      outputPath: join(outDir, 'Insane Fight.mp4'),
      workDir,
      onProgress: () => undefined
    })

    const served = server.bytesServed() - before
    const segmentRequests = server.requests
      .slice(requestsBefore)
      .filter((r) => r.path.endsWith('.ts'))

    // A 13.75s window out of 120s must not pull the whole VOD.
    expect(segmentRequests.length).toBeGreaterThan(0)
    expect(segmentRequests.length).toBeLessThanOrEqual(6)
    expect(served).toBeLessThan(sourceSizeBytes * 0.45)

    const size = await stat(result.outputPath)
    expect(size.size).toBeGreaterThan(0)
    expect(result.verification.ok).toBe(true)
  })

  it('cuts the requested range accurately and keeps audio in sync', async () => {
    const start = 23.5
    const end = 37.25
    const result = await exporter.exportClip({
      clipId: 'clip-b',
      clipName: 'Accurate Cut',
      startSeconds: start,
      endSeconds: end,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
      outputPath: join(outDir, 'Accurate Cut.mp4'),
      workDir,
      onProgress: () => undefined
    })

    const v = result.verification
    expect(v.video.present).toBe(true)
    expect(v.audio.present).toBe(true)
    expect(v.durationSeconds).toBeCloseTo(end - start, 0)
    expect(v.durationDeltaSeconds).toBeLessThan(0.4)
    expect(v.avSkewSeconds ?? 0).toBeLessThan(0.35)
    expect(v.video.width).toBe(640)
    expect(v.video.height).toBe(360)
    expect(Math.round(v.video.fps ?? 0)).toBe(30)

    // The exported frames must come from the requested part of the VOD.
    expectColorNear(await sampleColor(result.outputPath, 0.2), CHUNKS[chunkIndexAt(start)].rgb)
    expectColorNear(
      await sampleColor(result.outputPath, end - start - 0.3),
      CHUNKS[chunkIndexAt(end - 0.3)].rgb
    )
    // …and so must the audio.
    expect(await sampleFrequency(result.outputPath, 0.1)).toBe(CHUNKS[chunkIndexAt(start)].freq)

    // Both streams must begin together, within one frame / audio packet. Input
    // seeking alone would start the copied audio at the preceding video
    // keyframe instead, leaving a silent-video head of up to a full GOP.
    const probe = await ffmpeg.probe(result.outputPath)
    for (const stream of probe.streams) {
      expect(Math.abs(Number(stream.start_time ?? 0)), stream.codec_type).toBeLessThan(0.1)
    }
  })

  it('crosses chunk boundaries without losing content', async () => {
    const start = 18
    const end = 42
    const result = await exporter.exportClip({
      clipId: 'clip-c',
      clipName: 'Crosses Boundaries',
      startSeconds: start,
      endSeconds: end,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
      outputPath: join(outDir, 'Crosses Boundaries.mp4'),
      workDir,
      onProgress: () => undefined
    })

    expect(result.verification.durationSeconds).toBeCloseTo(24, 0)
    // 18s → chunk 1, 25s in → 43s absolute is beyond; sample inside each chunk.
    expectColorNear(await sampleColor(result.outputPath, 0.3), CHUNKS[1].rgb)
    expectColorNear(await sampleColor(result.outputPath, 5), CHUNKS[2].rgb)
    expectColorNear(await sampleColor(result.outputPath, 15), CHUNKS[3].rgb)
  })

  it('reports keyframe drift honestly in stream-copy mode', async () => {
    const start = 25.4
    const end = 33.4
    const result = await exporter.exportClip({
      clipId: 'clip-d',
      clipName: 'Copy Mode',
      startSeconds: start,
      endSeconds: end,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath: join(outDir, 'Copy Mode.mp4'),
      workDir,
      onProgress: () => undefined
    })

    expect(result.reEncoded).toBe(false)
    expect(result.startDriftSeconds).toBeGreaterThanOrEqual(0)
    expect(result.startDriftSeconds).toBeLessThanOrEqual(2.1)
    if (result.startDriftSeconds > 0.001) {
      expect(result.notes.join(' ')).toMatch(/nearest keyframe/)
    }
    // The verifier compares against the honest expected duration, not the
    // requested one, so a copy-mode clip still verifies clean.
    expect(result.verification.ok).toBe(true)
    expect(result.verification.durationSeconds).toBeCloseTo(
      end - start + result.startDriftSeconds,
      0
    )
    // Copy mode must not have transcoded: the codec is unchanged.
    expect(result.verification.video.codec).toBe('h264')
  })

  it('smart mode re-encodes only when the drift exceeds the tolerance', async () => {
    // A start that sits on a keyframe (multiple of the 2s GOP) should copy.
    const onKeyframe = await exporter.exportClip({
      clipId: 'clip-e1',
      clipName: 'Smart On Keyframe',
      startSeconds: 24,
      endSeconds: 30,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart', keyframeToleranceSeconds: 0.5 },
      outputPath: join(outDir, 'Smart On Keyframe.mp4'),
      workDir,
      onProgress: () => undefined
    })
    expect(onKeyframe.reEncoded).toBe(false)

    // A start in the middle of a GOP exceeds the tolerance and is re-encoded.
    const midGop = await exporter.exportClip({
      clipId: 'clip-e2',
      clipName: 'Smart Mid GOP',
      startSeconds: 25,
      endSeconds: 31,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart', keyframeToleranceSeconds: 0.2 },
      outputPath: join(outDir, 'Smart Mid GOP.mp4'),
      workDir,
      onProgress: () => undefined
    })
    expect(midGop.reEncoded).toBe(true)
    expect(midGop.notes.join(' ')).toMatch(/frame-accurate start/)
    expect(midGop.verification.durationSeconds).toBeCloseTo(6, 0)
    expectColorNear(await sampleColor(midGop.outputPath, 0.2), CHUNKS[2].rgb)
  })

  it('reuses cached segments for an overlapping clip instead of re-downloading', async () => {
    const first = await exporter.exportClip({
      clipId: 'clip-f1',
      clipName: 'Overlap A',
      startSeconds: 60,
      endSeconds: 72,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath: join(outDir, 'Overlap A.mp4'),
      workDir,
      onProgress: () => undefined
    })
    expect(first.cachedSegments).toBe(0)

    const bytesBefore = server.bytesServed()
    const second = await exporter.exportClip({
      clipId: 'clip-f2',
      clipName: 'Overlap B',
      startSeconds: 66,
      endSeconds: 78,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputPath: join(outDir, 'Overlap B.mp4'),
      workDir,
      onProgress: () => undefined
    })

    expect(second.cachedSegments).toBeGreaterThan(0)
    // Only the non-overlapping tail had to come off the network.
    expect(server.bytesServed() - bytesBefore).toBeLessThan(first.bytesDownloaded)
  })

  it('writes MKV when asked, without re-encoding', async () => {
    const result = await exporter.exportClip({
      clipId: 'clip-g',
      clipName: 'As MKV',
      startSeconds: 40,
      endSeconds: 46,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, container: 'mkv', cutMode: 'copy' },
      outputPath: join(outDir, 'As MKV.mp4'),
      workDir,
      onProgress: () => undefined
    })
    expect(result.outputPath.endsWith('.mkv')).toBe(true)
    expect(result.verification.container).toContain('matroska')
    expect(result.reEncoded).toBe(false)
  })

  it('reports progress through every stage', async () => {
    const stages: string[] = []
    await exporter.exportClip({
      clipId: 'clip-h',
      clipName: 'Progress',
      startSeconds: 80,
      endSeconds: 86,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
      outputPath: join(outDir, 'Progress.mp4'),
      workDir,
      onProgress: (e) => {
        if (stages[stages.length - 1] !== e.stage) stages.push(e.stage)
      }
    })
    expect(stages).toContain('downloading-video')
    expect(stages).toContain('cutting')
    expect(stages).toContain('verifying')
  })

  it('cancels cleanly without leaving a partial file', async () => {
    const controller = new AbortController()
    const outputPath = join(outDir, 'Cancelled.mp4')
    const promise = exporter.exportClip({
      clipId: 'clip-i',
      clipName: 'Cancelled',
      startSeconds: 0,
      endSeconds: 60,
      source: SOURCE,
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
      outputPath,
      workDir,
      signal: controller.signal,
      onProgress: () => undefined
    })
    setTimeout(() => controller.abort(), 60)
    await expect(promise).rejects.toThrow()
    await expect(stat(outputPath)).rejects.toThrow()
  })

  it('rejects a range that falls outside the VOD with a specific message', async () => {
    await expect(
      exporter.exportClip({
        clipId: 'clip-j',
        clipName: 'Out Of Range',
        startSeconds: 500,
        endSeconds: 400,
        source: SOURCE,
        streams: hlsStreams(),
        settings: DEFAULT_EXPORT_SETTINGS,
        outputPath: join(outDir, 'Out Of Range.mp4'),
        workDir,
        onProgress: () => undefined
      })
    ).rejects.toThrowError(/End must be later than Start/)
  })
})

describe('HTTP range export', () => {
  it('fetches only the needed bytes from a progressive source', async () => {
    const before = server.requests.length
    const start = 52.5
    const end = 62.5

    const result = await exporter.exportClip({
      clipId: 'clip-k',
      clipName: 'Progressive Range',
      startSeconds: start,
      endSeconds: end,
      source: SOURCE,
      streams: httpStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
      outputPath: join(outDir, 'Progressive Range.mp4'),
      workDir,
      onProgress: () => undefined
    })

    const ranged = server.requests.slice(before).filter((r) => r.path.includes('source.mp4'))
    expect(ranged.length).toBeGreaterThan(0)

    // FFmpeg must seek into the file with a Range request rather than reading
    // it front to back. The first request is the bounded container analysis
    // (capped by -probesize); the seek request is what carries the clip.
    const seeking = ranged.filter((r) => /^bytes=[1-9]/.test(r.range ?? ''))
    expect(seeking.length).toBeGreaterThan(0)

    // The seek lands near the clip's position in the file rather than at the
    // beginning: 52.5s of 120s is ~44% in, and the request offset matches.
    const offsets = seeking.map((r) => Number(/^bytes=(\d+)/.exec(r.range ?? '')![1]))
    const firstSeek = Math.min(...offsets)
    expect(firstSeek / sourceSizeBytes).toBeGreaterThan(0.3)
    expect(firstSeek / sourceSizeBytes).toBeLessThan(0.6)

    // The container-analysis read is bounded by -probesize, so opening a long
    // VOD costs a few megabytes rather than a full sequential download.
    const analysisBytes = ranged
      .filter((r) => !/^bytes=[1-9]/.test(r.range ?? ''))
      .reduce((sum, r) => sum + r.bytesSent, 0)
    expect(analysisBytes).toBeLessThanOrEqual(5 * 1024 * 1024)

    expect(result.verification.video.present).toBe(true)
    expect(result.verification.audio.present).toBe(true)
    expect(result.verification.durationSeconds).toBeCloseTo(end - start, 0)
    expectColorNear(await sampleColor(result.outputPath, 0.3), CHUNKS[chunkIndexAt(start)].rgb)
  })
})

describe('combined export', () => {
  it('joins clips in the chosen order, non-chronologically', async () => {
    const parts: string[] = []
    const ranges: Array<[number, number]> = [
      [90, 96], // chunk 9
      [10, 16], // chunk 1
      [50, 56] // chunk 5
    ]
    for (const [index, [start, end]] of ranges.entries()) {
      const result = await exporter.exportClip({
        clipId: `combine-${index}`,
        clipName: `Part ${index}`,
        startSeconds: start,
        endSeconds: end,
        source: SOURCE,
        streams: hlsStreams(),
        settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
        outputPath: join(workDir, `part-${index}.mp4`),
        workDir,
        onProgress: () => undefined
      })
      parts.push(result.outputPath)
    }

    const combined = await exporter.combine({
      parts,
      outputPath: join(outDir, 'Highlights.mp4'),
      workDir,
      settings: DEFAULT_EXPORT_SETTINGS,
      onProgress: () => undefined
    })

    const verification = await exporter.verify(combined.outputPath, 18, true)
    expect(verification.video.present).toBe(true)
    expect(verification.audio.present).toBe(true)
    expect(verification.durationSeconds).toBeCloseTo(18, 0)

    // The order requested is the order produced.
    expectColorNear(await sampleColor(combined.outputPath, 2), CHUNKS[9].rgb)
    expectColorNear(await sampleColor(combined.outputPath, 8), CHUNKS[1].rgb)
    expectColorNear(await sampleColor(combined.outputPath, 14), CHUNKS[5].rgb)
  })
})

describe('queue integration', () => {
  it('exports three named clips end to end through the real queue', async () => {
    const queue = new ExportQueue(log, exporter, join(root, 'queue-work'))
    queue.setConcurrency(2)
    const finalDir = join(root, 'queue-out')

    await queue.enqueue({
      source: SOURCE,
      clips: [
        { id: 'q1', name: 'Funny Death', startSeconds: 12, endSeconds: 18 },
        { id: 'q2', name: 'Insane Fight', startSeconds: 44, endSeconds: 50 },
        { id: 'q3', name: 'Final Reaction', startSeconds: 100, endSeconds: 106 }
      ],
      streams: hlsStreams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'precise' },
      outputDirectory: finalDir
    })

    const jobs = await waitForQueue(queue)
    expect(jobs.map((j) => j.progress.stage)).toEqual(['complete', 'complete', 'complete'])

    for (const job of jobs) {
      expect(job.outputPath).toBeTruthy()
      const size = await stat(job.outputPath!)
      expect(size.size).toBeGreaterThan(1000)
      expect(job.verification?.ok).toBe(true)
      expect(job.verification?.video.present).toBe(true)
      expect(job.verification?.audio.present).toBe(true)
      expect(job.verification?.avSkewSeconds ?? 0).toBeLessThan(0.35)
    }

    // Exports are named "<clip> - <streamer> - <date>.mp4".
    expect(jobs.map((j) => j.outputPath!.split(/[\\/]/).pop())).toEqual([
      'Funny Death - Fixture - 2026-08-17.mp4',
      'Insane Fight - Fixture - 2026-08-17.mp4',
      'Final Reaction - Fixture - 2026-08-17.mp4'
    ])

    // Each file starts where its clip starts.
    expectColorNear(await sampleColor(jobs[0].outputPath!, 0.3), CHUNKS[chunkIndexAt(12)].rgb)
    expectColorNear(await sampleColor(jobs[1].outputPath!, 0.3), CHUNKS[chunkIndexAt(44)].rgb)
    expectColorNear(await sampleColor(jobs[2].outputPath!, 0.3), CHUNKS[chunkIndexAt(100)].rgb)
  })
})

async function waitForQueue(queue: ExportQueue): Promise<ExportJob[]> {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const jobs = queue.list()
    if (
      jobs.length > 0 &&
      jobs.every((j) => ['complete', 'failed', 'cancelled'].includes(j.progress.stage))
    ) {
      return jobs
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('queue did not finish in time')
}

function expectColorNear(actual: [number, number, number], expected: readonly number[]): void {
  const distance = Math.sqrt(
    (actual[0] - expected[0]) ** 2 + (actual[1] - expected[1]) ** 2 + (actual[2] - expected[2]) ** 2
  )
  expect(
    distance,
    `expected rgb(${actual.join(',')}) to be close to rgb(${expected.join(',')})`
  ).toBeLessThan(60)
}

// Keeps CHUNK_SECONDS referenced for readers scanning the fixture contract.
void CHUNK_SECONDS
