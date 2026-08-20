import { readdir, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { toFfmpegTime } from '../../shared/time.js'
import type { StreamInfo } from '../../shared/types.js'
import type { FfmpegService } from './ffmpeg.js'
import type { RangeFetcher } from './rangeFetcher.js'
import { windowExtension } from './exporter.js'
import type { Logger } from '../services/logger.js'

/**
 * A filmstrip for the timeline: a handful of frames evenly spaced across a
 * clip's own range, so a video-track item shows what's actually in it
 * without opening the player. Same shape as `audioPeaks.ts` — only the
 * requested window is fetched, nothing about the source is touched, and the
 * fetch itself is what leaves the range cached on disk for editing later.
 */

export interface ThumbnailsRequest {
  stream: StreamInfo
  startSeconds: number
  endSeconds: number
  /** How many frames to pull across the range. */
  frameCount: number
  /** Frame width in pixels; height follows the source's own aspect ratio. */
  width: number
  workDir: string
  signal?: AbortSignal
}

export interface ThumbnailsResult {
  startSeconds: number
  endSeconds: number
  /** data: URIs, evenly spaced across the range, earliest first. */
  frames: string[]
}

let sequence = 0

export class ThumbnailService {
  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher
  ) {}

  async thumbnails(req: ThumbnailsRequest): Promise<ThumbnailsResult> {
    const duration = req.endSeconds - req.startSeconds
    if (!(duration > 0)) throw Errors.invalidRange('The filmstrip window must be longer than zero.')

    // Same collision reason as peaks.ts: several items can request a
    // filmstrip in the same tick, so a timestamp alone is not unique enough.
    sequence += 1
    const work = join(req.workDir, `thumbs-${Date.now().toString(36)}-${sequence}`)
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
      const count = Math.max(1, Math.min(60, Math.floor(req.frameCount)))
      const fps = count / duration
      const width = Math.max(16, Math.round(req.width))

      const args = (useHwDecode: boolean): string[] => [
        '-y',
        ...(useHwDecode ? ['-hwaccel', 'auto'] : []),
        '-ss',
        toFfmpegTime(offset),
        '-i',
        window.file,
        '-t',
        toFfmpegTime(duration),
        '-vf',
        `fps=${fps},scale=${width}:-2`,
        '-frames:v',
        String(count),
        join(work, 'frame_%03d.jpg')
      ]

      try {
        // Decoding is what's expensive here, not the tiny JPEG encode — a
        // GPU decoder turns this into a non-event for the CPU. Not every
        // machine or build has one wired up for this codec, so a failure
        // here is expected sometimes, not exceptional.
        await this.ffmpeg.exec(args(true), { signal: req.signal, label: 'filmstrip frames (gpu decode)' })
      } catch {
        await this.ffmpeg.exec(args(false), { signal: req.signal, label: 'filmstrip frames' })
      }

      const files = (await readdir(work)).filter((f) => f.startsWith('frame_')).sort()
      const frames: string[] = []
      for (const file of files) {
        const buf = await readFile(join(work, file))
        frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
      }
      this.log.debug('filmstrip', 'Frames extracted', { seconds: duration, frames: frames.length })
      return { startSeconds: req.startSeconds, endSeconds: req.endSeconds, frames }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
