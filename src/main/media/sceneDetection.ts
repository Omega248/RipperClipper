import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import type { StreamInfo } from '../../shared/types.js'
import type { FfmpegService } from './ffmpeg.js'
import type { RangeFetcher } from './rangeFetcher.js'
import { windowExtension } from './exporter.js'
import type { Logger } from '../services/logger.js'

/**
 * Scene-change timestamps for the waveform/marking UI — where the picture
 * actually cuts, not just where the audio does.
 *
 * Same shape as the waveform's own AudioPeaksService: only the requested
 * window is ever fetched, decoded once, and thrown away. Nothing about the
 * source is modified, and the whole VOD is never downloaded to suggest a
 * couple of clip boundaries.
 */

export interface SceneChangesRequest {
  stream: StreamInfo
  startSeconds: number
  endSeconds: number
  /** 0..1 — how different a frame must look from the last one to count. Higher = fewer, more obvious cuts. */
  threshold?: number
  workDir: string
  signal?: AbortSignal
}

export interface SceneChangesResult {
  startSeconds: number
  endSeconds: number
  /** Absolute seconds (source-local), sorted, within the requested window. */
  times: number[]
}

let sequence = 0

export class SceneDetectionService {
  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher
  ) {}

  async detect(req: SceneChangesRequest): Promise<SceneChangesResult> {
    const duration = req.endSeconds - req.startSeconds
    if (!(duration > 0)) {
      throw Errors.invalidRange('The scene-detection window must be longer than zero.')
    }

    sequence += 1
    const work = join(req.workDir, `scenes-${Date.now().toString(36)}-${sequence}`)
    await mkdir(work, { recursive: true })

    try {
      const window = await this.fetcher.fetchWindow({
        stream: req.stream,
        startSeconds: req.startSeconds,
        endSeconds: req.endSeconds,
        destination: join(work, `window.${windowExtension(req.stream.container)}`),
        signal: req.signal,
        onProgress: () => undefined
      })

      const offset = Math.max(0, req.startSeconds - window.windowStartSeconds)
      const result = await this.ffmpeg.sceneChanges(
        window.file,
        offset,
        duration,
        req.threshold ?? 0.35
      )
      // The probe was against the fetched window's own clock (starting at
      // `offset`, not the source's); shift back to source-local seconds.
      const shift = req.startSeconds - offset
      const times = result.times.map((t) => t + shift).filter((t) => t >= req.startSeconds && t <= req.endSeconds)

      this.log.debug('scenes', 'Scene changes computed', { seconds: duration, found: times.length })
      return { startSeconds: req.startSeconds, endSeconds: req.endSeconds, times }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
