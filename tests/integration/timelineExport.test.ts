import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { Exporter } from '../../src/main/media/exporter.js'
import { ExportQueue } from '../../src/main/services/queue.js'
import type { QueueClipInput } from '../../src/main/services/queue.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import { computeExportSegments, emptyTimeline, addItem } from '../../src/shared/timeline.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { ExportJob, StreamInfo, VodSource } from '../../src/shared/types.js'
import { CHUNKS, CHUNK_SECONDS, TOTAL_SECONDS, buildFixture, sampleColor } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * The Editor's multi-track timeline, rendered end to end.
 *
 * A 2-POV sequence is built as data — the same `computeExportSegments` the
 * renderer calls — then rendered through the real queue and combined into
 * one file, and the *output pixels* are sampled to prove the right POV's
 * content landed in the right place, in order. "The segments were computed
 * correctly" is not the claim worth testing on its own; the claim is that a
 * viewer watching the exported file actually sees clip A cut to clip B.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let cache: CacheManager
let fetcher: RangeFetcher
let exporter: Exporter
let queue: ExportQueue
let server: MediaServer
let outDir: string
let workDir: string

const POV_A: VodSource = {
  id: 'pov_a',
  platform: 'twitch',
  vodId: 'a',
  url: 'https://example.invalid/videos/a',
  title: 'POV A',
  creator: 'StreamerA',
  durationSeconds: TOTAL_SECONDS,
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}
const POV_B: VodSource = { ...POV_A, id: 'pov_b', title: 'POV B', creator: 'StreamerB' }

function streamsFor(): SelectedStreams {
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
  root = await mkdtemp(join(tmpdir(), 'vodclip-timeline-export-'))
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
  queue = new ExportQueue(log, exporter, join(root, 'jobs'))
}, 300_000)

afterAll(async () => {
  await server?.close()
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

function waitForJob(id: string): Promise<ExportJob> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const job = queue.list().find((j) => j.id === id)
      if (!job) return
      if (job.progress.stage === 'complete') {
        clearInterval(timer)
        resolve(job)
      } else if (job.progress.stage === 'failed') {
        clearInterval(timer)
        reject(new Error(job.error?.message ?? 'export failed'))
      }
    }, 100)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error('timed out waiting for job'))
    }, 120_000)
  })
}

describe('a multi-POV timeline sequence exports as one file', () => {
  it('cuts each segment from its own POV, in order, mapped from a real EditorTimeline', async () => {
    // Two video items, back to back: 0-6s from POV A's chunk 1 (10-16s of
    // the source), 6-12s from POV B's chunk 4 (40-46s of the source).
    let timeline = emptyTimeline()
    const v1 = timeline.tracks[0].id
    timeline = addItem(timeline, {
      trackId: v1,
      kind: 'video',
      sourceId: POV_A.id,
      sourceStartSeconds: CHUNK_SECONDS * 1,
      sourceEndSeconds: CHUNK_SECONDS * 1 + 6,
      timelineStartSeconds: 0,
      timelineEndSeconds: 6
    }).timeline
    timeline = addItem(timeline, {
      trackId: v1,
      kind: 'video',
      sourceId: POV_B.id,
      sourceStartSeconds: CHUNK_SECONDS * 4,
      sourceEndSeconds: CHUNK_SECONDS * 4 + 6,
      timelineStartSeconds: 6,
      timelineEndSeconds: 12
    }).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(2)
    expect(segments[0].videoSourceId).toBe('pov_a')
    expect(segments[1].videoSourceId).toBe('pov_b')

    // What the renderer's exportTimelineSequence would build: each segment
    // resolved against its own POV's own streams — exercising the exact
    // per-clip source/streams override executeCombine now supports.
    const streams = streamsFor()
    const clips: QueueClipInput[] = segments.map((seg, i) => ({
      id: `seg-${i}`,
      name: `Segment ${i + 1}`,
      startSeconds: seg.videoStartSeconds,
      endSeconds: seg.videoEndSeconds,
      source: seg.videoSourceId === 'pov_a' ? POV_A : POV_B,
      streams,
      audioEdits: seg.audioEdits
    }))

    const job = await queue.enqueueCombined({
      source: POV_A,
      streams,
      clips,
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart' },
      outputDirectory: outDir,
      outputName: 'sequence-test'
    })

    const finished = await waitForJob(job.id)
    expect(finished.outputPath).toBeTruthy()

    // The output should show POV A's chunk 1 colour for the first ~6s, and
    // POV B's chunk 4 colour from ~6s on — proving the cut landed where the
    // timeline said it would, not just that ffmpeg ran without error.
    const beforeCut = await sampleColor(finished.outputPath!, 2)
    const afterCut = await sampleColor(finished.outputPath!, 9)
    const expectedFirst = CHUNKS[1].rgb
    const expectedSecond = CHUNKS[4].rgb

    for (let ch = 0; ch < 3; ch++) {
      expect(Math.abs(beforeCut[ch] - expectedFirst[ch])).toBeLessThan(30)
      expect(Math.abs(afterCut[ch] - expectedSecond[ch])).toBeLessThan(30)
    }
  }, 180_000)
})
