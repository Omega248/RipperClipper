import { EventEmitter } from 'node:events'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError, Errors, serializeError } from '../../shared/errors.js'
import { createId } from '../../shared/clips.js'
import {
  applyTemplate,
  buildFolderSegments,
  sanitizeFilename,
  uniqueFilename
} from '../../shared/filenames.js'
import { formatDuration, formatTimecode } from '../../shared/time.js'
import type { ResolvedWatermark } from '../../shared/watermark.js'
import type { AudioEdit } from '../../shared/audioEdits.js'
import type {
  ExportJob,
  ExportSettings,
  JobProgress,
  StreamInfo,
  TimelineTransform,
  VodSource
} from '../../shared/types.js'
import type { Logger } from './logger.js'
import type { Exporter } from '../media/exporter.js'
import type { SelectedStreams } from '../media/formats.js'
import { assertEnoughSpace, ensureWritableDirectory, estimateExportBytes } from './disk.js'

export interface QueueClipInput {
  id: string
  name: string
  startSeconds: number
  endSeconds: number
  /** Sound taken from another POV, in that POV's own local time. */
  audioOverride?: {
    stream: StreamInfo
    startSeconds: number
    endSeconds: number
  }
  /** Hand-drawn mute/bleep/duck ranges, in the clip's own timeline. */
  audioEdits?: AudioEdit[]
  /**
   * Overrides the combined job's own POV for this one part — a Timeline
   * export's segments each come from whichever POV was on top at that
   * point, which routinely differs from one segment to the next, unlike a
   * plain "combine these clips" job where every part shares one POV.
   */
  source?: VodSource
  streams?: SelectedStreams
  watermark?: ResolvedWatermark
  /** Position/scale/rotation for this one part's picture. */
  transform?: TimelineTransform
  /** 0..1. */
  opacity?: number
  /** Flat volume multiplier from the audio item supplying the sound. 1 = unchanged. */
  audioGain?: number
  /** A second POV composited as an inset over this part's picture. */
  pip?: {
    stream: StreamInfo
    startSeconds: number
    endSeconds: number
    transform?: TimelineTransform
  }
}

export interface QueueTask {
  job: ExportJob
  clip: QueueClipInput
  watermark?: ResolvedWatermark
  source: VodSource
  streams: SelectedStreams
  settings: ExportSettings
  outputDirectory: string
  /** Bleep tone, so what was previewed is what gets written. */
  bleep?: { hz: number; amplitude: number }
  controller: AbortController | null
  /** For combined exports: the clips to join once the parts are ready. */
  combineOf?: string[]
  combineName?: string
}

const STAGE_WEIGHTS: Record<string, [number, number]> = {
  // stage -> [startFraction, endFraction] of the overall job
  resolving: [0, 0.02],
  'downloading-video': [0.02, 0.62],
  'downloading-audio': [0.62, 0.78],
  cutting: [0.78, 0.96],
  muxing: [0.78, 0.96],
  verifying: [0.96, 1]
}

export class ExportQueue extends EventEmitter {
  private tasks = new Map<string, QueueTask>()
  private order: string[] = []
  private running = new Set<string>()
  private paused = false
  private concurrency = 2
  private pumping = false

  constructor(
    private readonly log: Logger,
    private readonly exporter: Exporter,
    private workRoot: string
  ) {
    super()
  }

  setWorkRoot(dir: string): void {
    this.workRoot = dir
  }

  setConcurrency(value: number): void {
    this.concurrency = Math.max(1, Math.min(4, Math.round(value)))
    void this.pump()
  }

  list(): ExportJob[] {
    return this.order
      .map((id) => this.tasks.get(id)?.job)
      .filter((j): j is ExportJob => Boolean(j))
  }

  /** Names already claimed by queued/finished jobs, so two jobs never collide. */
  private claimedNames(directory: string): Set<string> {
    const claimed = new Set<string>()
    for (const task of this.tasks.values()) {
      if (task.outputDirectory !== directory) continue
      // A job that failed or was cancelled left no file behind, so holding its
      // name would push every retry to "(2)", "(3)" for no reason.
      if (task.job.progress.stage === 'failed' || task.job.progress.stage === 'cancelled') continue
      if (task.job.outputPath) claimed.add(basenameOf(task.job.outputPath).toLowerCase())
    }
    return claimed
  }

  async enqueue(input: {
    source: VodSource
    clips: QueueClipInput[]
    streams: SelectedStreams
    settings: ExportSettings
    /** The video POV's watermark, already resolved. */
    watermark?: ResolvedWatermark
    outputDirectory: string
    projectName?: string
  }): Promise<ExportJob[]> {
    await ensureWritableDirectory(input.outputDirectory)

    // Names only have to be unique inside the folder they land in, and each
    // folder is read once however many clips go into it.
    const seen = new Map<string, Set<string>>()
    const namesIn = async (dir: string): Promise<Set<string>> => {
      const existing = seen.get(dir)
      if (existing) return existing
      const names = new Set(
        (await readdir(dir).catch(() => [] as string[])).map((n) => n.toLowerCase())
      )
      for (const claimed of this.claimedNames(dir)) names.add(claimed)
      seen.set(dir, names)
      return names
    }

    const created: ExportJob[] = []
    for (const clip of input.clips) {
      const directory = join(
        input.outputDirectory,
        ...exportFolder(clip, input.source, input.settings, input.projectName)
      )
      await mkdir(directory, { recursive: true })
      const onDisk = await namesIn(directory)

      const stem = buildStem(clip, input.source, input.settings, created.length + 1)
      const filename = uniqueFilename(stem, input.settings.container, [...onDisk])
      onDisk.add(filename.toLowerCase())

      const job: ExportJob = {
        id: createId('job'),
        clipId: clip.id,
        clipName: clip.name,
        sourceId: input.source.id,
        outputPath: join(directory, filename),
        progress: initialProgress(),
        error: null,
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        verification: null
      }
      this.tasks.set(job.id, {
        job,
        clip,
        source: input.source,
        streams: input.streams,
        settings: input.settings,
        watermark: input.watermark,
        outputDirectory: directory,
        controller: null
      })
      this.order.push(job.id)
      created.push(job)
    }

    // Warn early rather than filling the disk mid-export.
    const totalSeconds = input.clips.reduce((s, c) => s + (c.endSeconds - c.startSeconds), 0)
    await assertEnoughSpace(
      input.outputDirectory,
      estimateExportBytes(totalSeconds, input.streams.video?.bitrate, input.streams.audio?.bitrate)
    )

    this.emitJobs()
    void this.pump()
    return created
  }

  async enqueueCombined(input: {
    source: VodSource
    clips: QueueClipInput[]
    streams: SelectedStreams
    settings: ExportSettings
    /** The POV's watermark, so a combined file is marked like a single clip. */
    watermark?: ResolvedWatermark
    /** Bleep tone, so what was previewed is what gets written. */
    bleep?: { hz: number; amplitude: number }
    outputDirectory: string
    outputName: string
    projectName?: string
  }): Promise<ExportJob> {
    await ensureWritableDirectory(input.outputDirectory)
    // A combined file belongs to the project, not to any one clip or POV, so
    // only the project part of the folder template applies to it.
    const directory = join(
      input.outputDirectory,
      ...buildFolderSegments(projectOnly(input.settings.folderTemplate), {
        name: input.outputName,
        project: input.projectName,
        creator: input.source.creator,
        platform: input.source.platform,
        date: (input.source.createdAt ?? new Date().toISOString()).slice(0, 10)
      })
    )
    await mkdir(directory, { recursive: true })
    const onDisk = new Set(
      (await readdir(directory).catch(() => [] as string[])).map((n) => n.toLowerCase())
    )
    const stem = sanitizeFilename(input.outputName, 'Highlights')
    const filename = uniqueFilename(stem, input.settings.container, [
      ...onDisk,
      ...this.claimedNames(directory)
    ])

    const job: ExportJob = {
      id: createId('job'),
      clipId: `combined:${input.clips.map((c) => c.id).join(',')}`,
      clipName: input.outputName,
      sourceId: input.source.id,
      outputPath: join(directory, filename),
      progress: initialProgress(),
      error: null,
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      verification: null
    }

    this.tasks.set(job.id, {
      job,
      clip: {
        id: job.clipId,
        name: input.outputName,
        startSeconds: 0,
        endSeconds: input.clips.reduce((s, c) => s + (c.endSeconds - c.startSeconds), 0)
      },
      source: input.source,
      streams: input.streams,
      settings: input.settings,
      watermark: input.watermark,
      bleep: input.bleep,
      outputDirectory: directory,
      controller: null,
      combineOf: input.clips.map((c) => c.id),
      combineName: input.outputName
    })
    // Keep the individual clip definitions for the combine run.
    this.combineInputs.set(job.id, input.clips)
    this.order.push(job.id)
    this.emitJobs()
    void this.pump()
    return job
  }

  private combineInputs = new Map<string, QueueClipInput[]>()

  cancel(jobId: string): void {
    const task = this.tasks.get(jobId)
    if (!task) return
    task.controller?.abort()
    if (!this.running.has(jobId)) {
      task.job.progress = { ...task.job.progress, stage: 'cancelled', message: 'Cancelled' }
      task.job.finishedAt = new Date().toISOString()
      this.emitJobs()
    }
  }

  pause(): void {
    this.paused = true
    for (const task of this.tasks.values()) {
      if (task.job.progress.stage === 'queued') {
        task.job.progress = { ...task.job.progress, stage: 'paused', message: 'Paused' }
      }
    }
    this.emitJobs()
  }

  resume(): void {
    this.paused = false
    for (const task of this.tasks.values()) {
      if (task.job.progress.stage === 'paused') {
        task.job.progress = { ...task.job.progress, stage: 'queued', message: 'Waiting' }
      }
    }
    this.emitJobs()
    void this.pump()
  }

  isPaused(): boolean {
    return this.paused
  }

  retry(jobId: string): void {
    const task = this.tasks.get(jobId)
    if (!task) return
    if (task.job.progress.stage !== 'failed' && task.job.progress.stage !== 'cancelled') return
    task.job.error = null
    task.job.finishedAt = null
    task.job.progress = initialProgress()
    task.controller = null
    this.emitJobs()
    void this.pump()
  }

  retryAllFailed(): void {
    for (const task of this.tasks.values()) {
      if (task.job.progress.stage === 'failed') this.retry(task.job.id)
    }
  }

  /**
   * Move a job to a new position in the list. `order` doubles as run
   * priority — see `pump()` — so this also changes which queued job starts
   * next, not just where it's displayed.
   */
  reorder(jobId: string, toIndex: number): void {
    const from = this.order.indexOf(jobId)
    if (from === -1) return
    const [id] = this.order.splice(from, 1)
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id)
    this.emitJobs()
  }

  /** Remove finished jobs. Completed work is never dropped implicitly. */
  clearFinished(): void {
    for (const [id, task] of [...this.tasks.entries()]) {
      const stage = task.job.progress.stage
      if (stage === 'complete' || stage === 'cancelled') {
        this.tasks.delete(id)
        this.combineInputs.delete(id)
        this.order = this.order.filter((o) => o !== id)
      }
    }
    this.emitJobs()
  }

  private emitJobs(): void {
    this.emit('jobs', this.list())
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.paused && this.running.size < this.concurrency) {
        const next = this.order
          .map((id) => this.tasks.get(id))
          .find((t) => t && t.job.progress.stage === 'queued' && !this.running.has(t.job.id))
        if (!next) break
        this.running.add(next.job.id)
        void this.execute(next).finally(() => {
          this.running.delete(next.job.id)
          void this.pump()
        })
      }
    } finally {
      this.pumping = false
    }
  }

  private async execute(task: QueueTask): Promise<void> {
    const controller = new AbortController()
    task.controller = controller
    task.job.attempts += 1
    task.job.startedAt = new Date().toISOString()
    task.job.progress = { ...task.job.progress, stage: 'resolving', message: 'Preparing…' }
    this.emitJobs()

    const workDir = join(this.workRoot, task.job.id)
    let lastBytes = 0
    let lastAt = Date.now()
    let speed = 0

    const report = (e: { stage: string; fraction: number; message: string; bytes?: number }): void => {
      const [from, to] = STAGE_WEIGHTS[e.stage] ?? [0, 1]
      const overall = from + (to - from) * Math.max(0, Math.min(1, e.fraction))
      const now = Date.now()
      if (e.bytes !== undefined) {
        const dt = (now - lastAt) / 1000
        if (dt > 0.4) {
          const delta = e.bytes - lastBytes
          if (delta >= 0) speed = delta / dt
          lastBytes = e.bytes
          lastAt = now
        }
      }
      const progress: JobProgress = {
        stage: e.stage as JobProgress['stage'],
        stageProgress: e.fraction,
        overallProgress: overall,
        downloadedBytes: e.bytes ?? task.job.progress.downloadedBytes,
        totalBytes: null,
        bytesPerSecond: speed,
        etaSeconds:
          overall > 0.02 && overall < 1
            ? ((now - new Date(task.job.startedAt ?? now).getTime()) / 1000) * (1 / overall - 1)
            : null,
        message: e.message
      }
      task.job.progress = progress
      this.emitJobs()
    }

    try {
      await mkdir(workDir, { recursive: true })

      if (task.combineOf) {
        await this.executeCombine(task, workDir, controller, report)
      } else {
        const result = await this.exporter.exportClip({
          clipId: task.clip.id,
          clipName: task.clip.name,
          startSeconds: task.clip.startSeconds,
          endSeconds: task.clip.endSeconds,
          source: task.source,
          streams: task.streams,
          audioOverride: task.clip.audioOverride,
          audioEdits: task.clip.audioEdits,
          bleep: task.bleep,
          watermark: task.watermark,
          settings: task.settings,
          outputPath: task.job.outputPath!,
          workDir,
          signal: controller.signal,
          onProgress: report
        })

        task.job.outputPath = result.outputPath
        task.job.verification = result.verification
        const notes = [...result.notes]
        if (result.cachedSegments > 0) {
          notes.push(
            `${result.cachedSegments} of ${result.totalSegments} media segments were reused from the cache.`
          )
        }
        task.job.progress = {
          ...task.job.progress,
          stage: 'complete',
          stageProgress: 1,
          overallProgress: 1,
          message: notes.length > 0 ? notes.join(' ') : 'Complete'
        }
        this.log.info('queue', 'Export complete', {
          clip: task.clip.name,
          output: result.outputPath,
          reEncoded: result.reEncoded,
          drift: result.startDriftSeconds,
          verification: result.verification.ok,
          bytes: result.bytesDownloaded
        })
      }

      task.job.finishedAt = new Date().toISOString()
      this.emitJobs()
    } catch (err) {
      const cancelled = controller.signal.aborted || (err instanceof AppError && err.code === 'cancelled')
      task.job.error = cancelled ? null : serializeError(err)
      task.job.finishedAt = new Date().toISOString()
      task.job.progress = {
        ...task.job.progress,
        stage: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Cancelled' : (task.job.error?.message ?? 'Failed')
      }
      // A partially written output is never left behind pretending to be valid.
      if (task.job.outputPath) await rm(task.job.outputPath, { force: true }).catch(() => undefined)
      this.log.error('queue', 'Export failed', {
        clip: task.clip.name,
        cancelled,
        error: err
      })
      this.emitJobs()
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      task.controller = null
    }
  }

  private async executeCombine(
    task: QueueTask,
    workDir: string,
    controller: AbortController,
    report: (e: { stage: string; fraction: number; message: string; bytes?: number }) => void
  ): Promise<void> {
    const clips = this.combineInputs.get(task.job.id) ?? []
    if (clips.length === 0) throw Errors.invalidRange('No clips were selected to combine.')

    const parts: string[] = []
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      const partPath = join(workDir, `part-${String(i).padStart(3, '0')}.${task.settings.container}`)
      report({
        stage: 'downloading-video',
        fraction: i / clips.length,
        message: `Preparing clip ${i + 1} of ${clips.length}: ${clip.name}`
      })
      const result = await this.exporter.exportClip({
        clipId: `${task.job.id}-${i}`,
        clipName: clip.name,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        source: clip.source ?? task.source,
        streams: clip.streams ?? task.streams,
        audioOverride: clip.audioOverride,
        audioEdits: clip.audioEdits,
        bleep: task.bleep,
        watermark: clip.watermark ?? task.watermark,
        transform: clip.transform,
        opacity: clip.opacity,
        audioGain: clip.audioGain,
        pip: clip.pip,
        settings: task.settings,
        outputPath: partPath,
        workDir,
        signal: controller.signal,
        onProgress: (e) =>
          report({
            stage: e.stage,
            fraction: (i + Math.max(0, Math.min(1, e.fraction))) / clips.length,
            message: `${clip.name}: ${e.message}`,
            bytes: e.bytes
          })
      })
      parts.push(result.outputPath)
    }

    const combined = await this.exporter.combine({
      parts,
      outputPath: task.job.outputPath!,
      workDir,
      settings: task.settings,
      signal: controller.signal,
      onProgress: (e) => report({ ...e, fraction: 0.9 })
    })

    const total = clips.reduce((s, c) => s + (c.endSeconds - c.startSeconds), 0)
    task.job.verification = await this.exporter.verify(combined.outputPath, total, true)
    task.job.outputPath = combined.outputPath
    task.job.progress = {
      ...task.job.progress,
      stage: 'complete',
      stageProgress: 1,
      overallProgress: 1,
      message: combined.notes.length > 0 ? combined.notes.join(' ') : 'Complete'
    }
  }
}

function initialProgress(): JobProgress {
  return {
    stage: 'queued',
    stageProgress: 0,
    overallProgress: 0,
    downloadedBytes: 0,
    totalBytes: null,
    bytesPerSecond: 0,
    etaSeconds: null,
    message: 'Waiting'
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * The folder one export lands in, relative to the output directory.
 *
 * The same tokens as the filename, so "{Project}" gives every project its own
 * folder, "{Project}/{Creator}" a folder per POV, and "{Project}/{Name}" a
 * folder per clip holding all of its POVs.
 */
export function exportFolder(
  clip: QueueClipInput,
  source: VodSource,
  settings: ExportSettings,
  projectName?: string
): string[] {
  return buildFolderSegments(settings.folderTemplate ?? '', {
    name: clip.name,
    project: projectName,
    vodTitle: source.title,
    creator: source.creator,
    platform: source.platform,
    date: (source.createdAt ?? new Date().toISOString()).slice(0, 10)
  })
}

/** Drop per-clip and per-POV levels: a combined file belongs to neither. */
function projectOnly(template: string): string {
  return (template ?? '')
    .split(/[\\/]+/)
    .filter((part) => !/\{(name|creator|channel|vodtitle|title|index|start|end|duration)\}/i.test(part))
    .join('/')
}

export function buildStem(
  clip: QueueClipInput,
  source: VodSource,
  settings: ExportSettings,
  index: number
): string {
  return applyTemplate(settings.filenameTemplate || '{Name}', {
    name: clip.name,
    vodTitle: source.title,
    creator: source.creator,
    platform: source.platform,
    date: (source.createdAt ?? new Date().toISOString()).slice(0, 10),
    index,
    start: formatTimecode(clip.startSeconds, { millis: false }).replace(/:/g, '-'),
    end: formatTimecode(clip.endSeconds, { millis: false }).replace(/:/g, '-'),
    duration: formatDuration(clip.endSeconds - clip.startSeconds).replace(/:/g, '-')
  })
}
