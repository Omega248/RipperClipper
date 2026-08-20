import { readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { toFfmpegTime } from '../../shared/time.js'
import type { StreamInfo } from '../../shared/types.js'
import type { FfmpegService } from './ffmpeg.js'
import type { RangeFetcher } from './rangeFetcher.js'
import { windowExtension } from './exporter.js'
import type { Logger } from '../services/logger.js'

/**
 * Audio peaks for the waveform view.
 *
 * Only the requested window is fetched — the same range machinery the exporter
 * uses — then decoded to mono PCM and reduced to per-bucket peak/RMS pairs.
 * Nothing about the source is modified and the whole VOD is never downloaded to
 * draw a waveform.
 */

/** Decoding rate: plenty for a waveform, cheap to fetch and decode. */
const SAMPLE_RATE = 8000

export interface PeaksRequest {
  stream: StreamInfo
  startSeconds: number
  endSeconds: number
  /** Horizontal resolution of the waveform. */
  buckets: number
  workDir: string
  signal?: AbortSignal
}

export interface PeaksResult {
  startSeconds: number
  endSeconds: number
  /** 0..1 peak amplitude per bucket. */
  peaks: number[]
  /** 0..1 loudness per bucket — the shape speech and gunfire actually make. */
  rms: number[]
}

let sequence = 0

export class AudioPeaksService {
  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher
  ) {}

  async peaks(req: PeaksRequest): Promise<PeaksResult> {
    const duration = req.endSeconds - req.startSeconds
    if (!(duration > 0)) throw Errors.invalidRange('The waveform window must be longer than zero.')

    // Two POVs are read at once for the comparison view. A timestamp alone
    // collides when both start in the same millisecond — and then the first to
    // finish deletes the directory the second is still decoding into.
    sequence += 1
    const work = join(req.workDir, `peaks-${Date.now().toString(36)}-${sequence}`)
    await mkdir(work, { recursive: true })

    try {
      const window = await this.fetcher.fetchWindow({
        stream: req.stream,
        startSeconds: req.startSeconds,
        endSeconds: req.endSeconds,
        // FFmpeg picks its muxer from the extension: an unknown one makes the
        // fetch fail before a single sample is decoded.
        destination: join(work, `window.${windowExtension(req.stream.container)}`),
        signal: req.signal,
        onProgress: () => undefined
      })

      const raw = join(work, 'audio.raw')
      const offset = Math.max(0, req.startSeconds - window.windowStartSeconds)
      await this.ffmpeg.exec(
        [
          '-y',
          '-ss',
          toFfmpegTime(offset),
          '-i',
          window.file,
          '-t',
          toFfmpegTime(duration),
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(SAMPLE_RATE),
          '-f',
          's16le',
          raw
        ],
        { signal: req.signal, label: 'waveform decode' }
      )

      const pcm = await readFile(raw)
      const result = reduceToBuckets(pcm, req.buckets)
      this.log.debug('waveform', 'Peaks computed', {
        seconds: duration,
        samples: pcm.length / 2,
        buckets: req.buckets
      })
      return { startSeconds: req.startSeconds, endSeconds: req.endSeconds, ...result }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/** Signed 16-bit mono PCM → peak and RMS per bucket, both 0..1. */
export function reduceToBuckets(
  pcm: Buffer,
  buckets: number
): { peaks: number[]; rms: number[] } {
  const total = Math.floor(pcm.length / 2)
  // With no audio at all, hand back a flat line of the width that was asked
  // for: the waveform still draws, and it plainly shows silence.
  if (total === 0) {
    return { peaks: new Array<number>(buckets).fill(0), rms: new Array<number>(buckets).fill(0) }
  }
  const count = Math.max(1, Math.min(buckets, total))
  const peaks = new Array<number>(count).fill(0)
  const rms = new Array<number>(count).fill(0)

  const per = total / count
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * per)
    const to = Math.min(total, Math.floor((b + 1) * per))
    let peak = 0
    let sum = 0
    let n = 0
    for (let i = from; i < to; i++) {
      const sample = pcm.readInt16LE(i * 2) / 32768
      const magnitude = Math.abs(sample)
      if (magnitude > peak) peak = magnitude
      sum += sample * sample
      n++
    }
    peaks[b] = peak
    rms[b] = n > 0 ? Math.sqrt(sum / n) : 0
  }
  return { peaks, rms }
}
