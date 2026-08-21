import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExportQueue, buildStem } from '../../src/main/services/queue.js'
import { Logger } from '../../src/main/services/logger.js'
import { Errors } from '../../src/shared/errors.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { Exporter } from '../../src/main/media/exporter.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { ExportJob, VodSource } from '../../src/shared/types.js'

let dir: string
let outDir: string
let log: Logger

const SOURCE: VodSource = {
  id: 'twitch:1',
  platform: 'twitch',
  vodId: '1',
  url: 'https://www.twitch.tv/videos/1',
  title: 'Tarkov Session',
  creator: 'Streamer',
  durationSeconds: 3600,
  createdAt: '2026-08-17T10:00:00.000Z',
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}

const STREAMS: SelectedStreams = {
  video: {
    id: 'chunked',
    protocol: 'hls',
    label: '1080p60',
    url: 'https://cdn.invalid/x.m3u8',
    hasVideo: true,
    hasAudio: true,
    bitrate: 6_000_000
  },
  audio: null,
  muxed: true,
  notes: []
}

/** Deterministic stand-in for the real media pipeline. */
function fakeExporter(behaviour: {
  onExport?: (name: string) => Promise<void>
  fail?: Set<string>
  delayMs?: number
  concurrentPeak?: { value: number; current: number }
  seen?: Array<{ clipName: string }>
}): Exporter {
  return {
    exportClip: async (req: {
      clipName: string
      outputPath: string
      onProgress: (e: { stage: string; fraction: number; message: string }) => void
      signal?: AbortSignal
      startSeconds: number
      endSeconds: number
    }) => {
      behaviour.seen?.push({ clipName: req.clipName })
      if (behaviour.concurrentPeak) {
        behaviour.concurrentPeak.current++
        behaviour.concurrentPeak.value = Math.max(
          behaviour.concurrentPeak.value,
          behaviour.concurrentPeak.current
        )
      }
      try {
        req.onProgress({ stage: 'downloading-video', fraction: 0.5, message: 'Downloading video…' })
        await behaviour.onExport?.(req.clipName)
        if (behaviour.delayMs) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, behaviour.delayMs)
            req.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(Errors.cancelled())
            })
          })
        }
        if (behaviour.fail?.has(req.clipName)) throw Errors.downloadFailed('simulated failure')
        await writeFile(req.outputPath, 'x')
        return {
          outputPath: req.outputPath,
          verification: {
            ok: true,
            path: req.outputPath,
            sizeBytes: 1,
            container: 'mov,mp4',
            durationSeconds: req.endSeconds - req.startSeconds,
            expectedDurationSeconds: req.endSeconds - req.startSeconds,
            durationDeltaSeconds: 0,
            video: { present: true },
            audio: { present: true },
            avSkewSeconds: 0,
            problems: []
          },
          startDriftSeconds: 0,
          reEncoded: false,
          notes: [],
          bytesDownloaded: 1024,
          cachedSegments: 0,
          totalSegments: 1
        }
      } finally {
        if (behaviour.concurrentPeak) behaviour.concurrentPeak.current--
      }
    },
    combine: vi.fn(),
    verify: vi.fn()
  } as unknown as Exporter
}

function clip(name: string, start: number, end: number): {
  id: string
  name: string
  startSeconds: number
  endSeconds: number
} {
  return { id: `clip_${name}`, name, startSeconds: start, endSeconds: end }
}

async function settle(queue: ExportQueue, predicate: (jobs: ExportJob[]) => boolean): Promise<ExportJob[]> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const jobs = queue.list()
    if (predicate(jobs)) return jobs
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`queue never reached the expected state: ${JSON.stringify(queue.list().map((j) => j.progress.stage))}`)
}

const allFinished = (jobs: ExportJob[]): boolean =>
  jobs.length > 0 &&
  jobs.every((j) => ['complete', 'failed', 'cancelled'].includes(j.progress.stage))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vodclip-queue-'))
  outDir = join(dir, 'out')
  log = new Logger(join(dir, 'logs'))
})

afterEach(async () => {
  log.close()
  await rm(dir, { recursive: true, force: true })
})

describe('ExportQueue', () => {
  it('runs every queued clip and reports completion', async () => {
    const queue = new ExportQueue(log, fakeExporter({}), join(dir, 'work'))
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10), clip('B', 20, 30), clip('C', 40, 50)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    const jobs = await settle(queue, allFinished)
    expect(jobs.map((j) => j.progress.stage)).toEqual(['complete', 'complete', 'complete'])
  })

  it('respects the concurrency limit', async () => {
    const peak = { value: 0, current: 0 }
    const queue = new ExportQueue(log, fakeExporter({ delayMs: 60, concurrentPeak: peak }), join(dir, 'work'))
    queue.setConcurrency(2)
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10), clip('B', 10, 20), clip('C', 20, 30), clip('D', 30, 40)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    await settle(queue, allFinished)
    expect(peak.value).toBeLessThanOrEqual(2)
    expect(peak.value).toBeGreaterThan(1)
  })

  it('keeps completed jobs when another one fails', async () => {
    const queue = new ExportQueue(
      log,
      fakeExporter({ fail: new Set(['B']) }),
      join(dir, 'work')
    )
    queue.setConcurrency(1)
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10), clip('B', 10, 20), clip('C', 20, 30)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    const jobs = await settle(queue, allFinished)
    expect(jobs.map((j) => j.progress.stage)).toEqual(['complete', 'failed', 'complete'])
    const failed = jobs.find((j) => j.progress.stage === 'failed')!
    // Asserting on the code rather than the sentence: the wording is a
    // presentation decision that the design system owns, the code is the
    // contract the queue actually promises.
    expect(failed.error?.code).toBe('download-failed')
    expect(failed.error?.title).toBe(Errors.downloadFailed().title)
    expect(failed.error?.retryable).toBe(true)
  })

  it('retries a failed job and can succeed on the second attempt', async () => {
    const fail = new Set(['A'])
    const queue = new ExportQueue(log, fakeExporter({ fail }), join(dir, 'work'))
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    let jobs = await settle(queue, allFinished)
    expect(jobs[0].progress.stage).toBe('failed')

    fail.delete('A')
    queue.retry(jobs[0].id)
    jobs = await settle(queue, allFinished)
    expect(jobs[0].progress.stage).toBe('complete')
    expect(jobs[0].attempts).toBe(2)
  })

  it('retries every failed job at once', async () => {
    const fail = new Set(['A', 'B'])
    const queue = new ExportQueue(log, fakeExporter({ fail }), join(dir, 'work'))
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10), clip('B', 10, 20)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    await settle(queue, allFinished)
    fail.clear()
    queue.retryAllFailed()
    const jobs = await settle(queue, allFinished)
    expect(jobs.every((j) => j.progress.stage === 'complete')).toBe(true)
  })

  it('cancels a running job', async () => {
    const queue = new ExportQueue(log, fakeExporter({ delayMs: 5000 }), join(dir, 'work'))
    const [job] = await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    await new Promise((r) => setTimeout(r, 100))
    queue.cancel(job.id)
    const jobs = await settle(queue, allFinished)
    expect(jobs[0].progress.stage).toBe('cancelled')
    expect(jobs[0].error).toBeNull()
  })

  it('pauses and resumes without losing queued work', async () => {
    const queue = new ExportQueue(log, fakeExporter({ delayMs: 40 }), join(dir, 'work'))
    queue.setConcurrency(1)
    queue.pause()
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10), clip('B', 10, 20)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(queue.list().every((j) => j.progress.stage === 'paused' || j.progress.stage === 'queued')).toBe(
      true
    )
    queue.resume()
    const jobs = await settle(queue, allFinished)
    expect(jobs.every((j) => j.progress.stage === 'complete')).toBe(true)
  })

  it('clears finished jobs but keeps failures visible', async () => {
    const queue = new ExportQueue(log, fakeExporter({ fail: new Set(['B']) }), join(dir, 'work'))
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('A', 0, 10), clip('B', 10, 20)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    await settle(queue, allFinished)
    queue.clearFinished()
    expect(queue.list().map((j) => j.progress.stage)).toEqual(['failed'])
  })

  it('never overwrites an existing file', async () => {
    const queue = new ExportQueue(log, fakeExporter({}), join(dir, 'work'))
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('Same', 0, 10)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    await settle(queue, allFinished)

    await queue.enqueue({
      source: SOURCE,
      clips: [clip('Same', 20, 30)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    const jobs = await settle(queue, allFinished)
    const names = jobs.map((j) => j.outputPath!.split(/[\\/]/).pop())
    // The default template appends streamer and date, so both files share a
    // stem and the second must still be given its own name.
    expect(names[0]).toMatch(/^Same - /)
    expect(names[1]).toMatch(/ \(2\)\.mp4$/)
  })

  it('deduplicates names within a single batch too', async () => {
    const queue = new ExportQueue(log, fakeExporter({}), join(dir, 'work'))
    const jobs = await queue.enqueue({
      source: SOURCE,
      clips: [clip('Dup', 0, 10), { ...clip('Dup', 20, 30), id: 'clip_Dup2' }],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    const names = jobs.map((j) => j.outputPath!.split(/[\\/]/).pop())
    expect(new Set(names).size).toBe(2)
    await settle(queue, allFinished)
  })

  it('moves a queued job to a new position, changing run priority too', async () => {
    const queue = new ExportQueue(log, fakeExporter({}), join(dir, 'work'))
    queue.pause()
    const jobs = await queue.enqueue({
      source: SOURCE,
      clips: [clip('First', 0, 10), clip('Second', 20, 30), clip('Third', 40, 50)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    const [first, second, third] = jobs

    queue.reorder(third.id, 0)

    expect(queue.list().map((j) => j.id)).toEqual([third.id, first.id, second.id])

    queue.resume()
    await settle(queue, allFinished)
  })

  it('does nothing for a job id that is not in the queue', async () => {
    const queue = new ExportQueue(log, fakeExporter({}), join(dir, 'work'))
    await queue.enqueue({
      source: SOURCE,
      clips: [clip('Only', 0, 10)],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    const before = queue.list().map((j) => j.id)

    queue.reorder('not_a_real_job', 0)

    expect(queue.list().map((j) => j.id)).toEqual(before)
    await settle(queue, allFinished)
  })

  it('reports insufficient disk space instead of filling the drive', async () => {
    const queue = new ExportQueue(log, fakeExporter({}), join(dir, 'work'))
    await expect(
      queue.enqueue({
        source: SOURCE,
        // 40 days of 8 Mbps video will not fit anywhere.
        clips: [clip('Huge', 0, 3_456_000)],
        streams: STREAMS,
        settings: DEFAULT_EXPORT_SETTINGS,
        outputDirectory: outDir
      })
    ).rejects.toThrowError(/Free some space or choose a different output folder/)
  })
})

describe('buildStem', () => {
  it('renders filename templates from real clip and VOD data', () => {
    expect(
      buildStem(clip('Insane Fight', 6440, 6665), SOURCE, DEFAULT_EXPORT_SETTINGS, 2)
    ).toBe('Insane Fight - Streamer - 2026-08-17')

    expect(
      buildStem(
        clip('Insane Fight', 6440, 6665),
        SOURCE,
        { ...DEFAULT_EXPORT_SETTINGS, filenameTemplate: '{Date} - {VODTitle} - {Name}' },
        2
      )
    ).toBe('2026-08-17 - Tarkov Session - Insane Fight')
  })

  it('sanitises hostile clip names', () => {
    const stem = buildStem(clip('a/b:c*?"<>|', 0, 10), SOURCE, DEFAULT_EXPORT_SETTINGS, 1)
    expect(stem).toBe('a_b_c______ - Streamer - 2026-08-17')
    expect(stem).not.toMatch(/[\\/:*?"<>|]/)
  })
})

describe('names held by finished jobs', () => {
  it('frees the name of a job that failed, so a retry is not pushed to (2)', async () => {
    const queue = new ExportQueue(log, fakeExporter({ fail: new Set(['Same']) }), join(dir, 'work-free'))
    await queue.enqueue({
      source: SOURCE,
      clips: [{ id: 'f1', name: 'Same', startSeconds: 0, endSeconds: 5 }],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    await settle(queue, allFinished)

    const working = new ExportQueue(log, fakeExporter({}), join(dir, 'work-free-2'))
    const jobs = await working.enqueue({
      source: SOURCE,
      clips: [{ id: 'f2', name: 'Same', startSeconds: 0, endSeconds: 5 }],
      streams: STREAMS,
      settings: DEFAULT_EXPORT_SETTINGS,
      outputDirectory: outDir
    })
    expect(jobs[0].outputPath).not.toMatch(/\(2\)/)
    // Let the job actually finish before the test tears down its temp dir —
    // otherwise its work-directory cleanup races the afterEach `rm`, which on
    // Windows can hit a transient EPERM on a directory the job is still using.
    await settle(working, allFinished)
  })
})
