import { readFile, mkdir, rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import {
  linesFromWhisperJson,
  modelSpec,
  parseWhisperProgress
} from '../../shared/transcription.js'
import type {
  TranscribeProgress,
  WhisperJson,
  WhisperModelId
} from '../../shared/transcription.js'
import type { TranscriptLine } from '../../shared/transcript.js'
import type { StreamInfo } from '../../shared/types.js'
import type { FfmpegService } from './ffmpeg.js'
import type { RangeFetcher } from './rangeFetcher.js'
import { run } from '../services/process.js'
import { locateExecutable } from '../services/locate.js'
import type { Logger } from '../services/logger.js'

/**
 * Turning a whole VOD into text, on this machine.
 *
 * Three things make this fast enough to be worth doing on a six-hour
 * broadcast, all of them measured rather than assumed (see
 * shared/transcription.ts for the figures):
 *
 *  1. **Only the audio is fetched.** A VOD's audio track is a small fraction
 *     of its video, and transcription needs nothing else. This alone is the
 *     difference between a multi-gigabyte download and a few hundred
 *     megabytes.
 *  2. **The audio is decoded once, to exactly what whisper wants** — 16 kHz
 *     mono PCM. Whisper resamples internally otherwise, on every window it
 *     processes; handing it its native format skips that entirely.
 *  3. **The GPU build is used when the hardware can actually exploit it.**
 *     Measured at 5.5x the CPU speed on the large model — and, notably,
 *     *slower* than CPU on a small one, which is why the choice is made from
 *     hardware and model together rather than "GPU if present".
 *
 * The whole file is handed to whisper in one pass rather than chopped into
 * chunks. Chunking would make progress easier to report, but every boundary
 * costs the decoder its context and produces exactly the kind of clipped or
 * repeated phrase that makes a transcript untrustworthy to search. Progress
 * comes from whisper's own `--print-progress` instead, which costs nothing.
 */

/** Whisper's native input rate. Anything else makes it resample. */
const WHISPER_SAMPLE_RATE = 16000

export interface TranscribeJobRequest {
  sourceId: string
  /** The audio stream to transcribe — audio-only where the source offers one. */
  stream: StreamInfo
  durationSeconds: number
  model: WhisperModelId
  modelPath: string
  language: string
  useVad: boolean
  vadModelPath?: string | null
  workDir: string
  signal?: AbortSignal
  onProgress: (progress: TranscribeProgress) => void
}

export interface TranscribeResult {
  lines: TranscriptLine[]
  /** Measured speed, as a multiple of real time — reported so the estimate improves. */
  realtimeFactor: number
  usedGpu: boolean
}

export class TranscribeService {
  private binary: string | null = null

  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher
  ) {}

  /** Whether local transcription is available at all. */
  async available(): Promise<boolean> {
    return (await this.resolveBinary()) !== null
  }

  private async resolveBinary(): Promise<string | null> {
    if (this.binary) return this.binary
    const found = await locateExecutable(['whisper-cli'])
    this.binary = found.path
    return this.binary
  }

  async transcribe(req: TranscribeJobRequest): Promise<TranscribeResult> {
    const bin = await this.resolveBinary()
    if (!bin) {
      throw Errors.resolverFailed(
        'Whisper is not installed. Settings → Setup can download it.'
      )
    }

    const work = join(req.workDir, `stt-${req.sourceId}-${Date.now().toString(36)}`)
    await mkdir(work, { recursive: true })
    const started = Date.now()

    try {
      // ---- 1. the audio, and only the audio -------------------------------
      req.onProgress({
        sourceId: req.sourceId,
        stage: 'fetching-audio',
        fraction: 0,
        processedSeconds: 0,
        totalSeconds: req.durationSeconds,
        realtimeFactor: null,
        etaSeconds: null,
        message: 'Fetching the audio track…'
      })

      const container = req.stream.container && req.stream.container !== '' ? req.stream.container : 'mp4'
      const fetched = await this.fetcher.fetchWindow({
        stream: req.stream,
        startSeconds: 0,
        endSeconds: req.durationSeconds,
        destination: join(work, `audio.${container}`),
        signal: req.signal,
        onProgress: (p) =>
          req.onProgress({
            sourceId: req.sourceId,
            stage: 'fetching-audio',
            // The fetch is roughly the first fifth of the wall-clock work on a
            // GPU machine; weighting it so keeps the bar from stalling at 0.
            fraction: 0.2 * (p.fraction ?? 0),
            processedSeconds: 0,
            totalSeconds: req.durationSeconds,
            realtimeFactor: null,
            etaSeconds: null,
            message: 'Fetching the audio track…'
          })
      })

      // ---- 2. decode once, into whisper's own format ----------------------
      req.onProgress({
        sourceId: req.sourceId,
        stage: 'decoding',
        fraction: 0.2,
        processedSeconds: 0,
        totalSeconds: req.durationSeconds,
        realtimeFactor: null,
        etaSeconds: null,
        message: 'Preparing the audio…'
      })

      const wav = join(work, 'audio.wav')
      await this.ffmpeg.exec(
        [
          '-y',
          '-i',
          fetched.file,
          '-vn',
          '-ac',
          '1',
          '-ar',
          String(WHISPER_SAMPLE_RATE),
          '-c:a',
          'pcm_s16le',
          wav
        ],
        { signal: req.signal, label: 'transcription decode' }
      )

      // ---- 3. transcribe --------------------------------------------------
      const lines = await this.runWhisper(bin, wav, req)
      const elapsed = (Date.now() - started) / 1000
      const realtimeFactor = elapsed > 0 ? req.durationSeconds / elapsed : 0

      this.log.info('whisper', 'Transcribed a VOD', {
        sourceId: req.sourceId,
        model: req.model,
        audioSeconds: Math.round(req.durationSeconds),
        elapsedSeconds: Math.round(elapsed),
        realtimeFactor: Number(realtimeFactor.toFixed(1)),
        lines: lines.length
      })

      req.onProgress({
        sourceId: req.sourceId,
        stage: 'complete',
        fraction: 1,
        processedSeconds: req.durationSeconds,
        totalSeconds: req.durationSeconds,
        realtimeFactor,
        etaSeconds: 0,
        message: `Transcribed at ${realtimeFactor.toFixed(1)}x real time.`
      })

      return { lines, realtimeFactor, usedGpu: await this.hasCudaBuild() }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Run whisper over the prepared WAV and parse its JSON.
   *
   * Thread count is one per physical-ish core, capped: whisper scales well up
   * to about eight and then contends with itself, and leaving a couple of
   * cores free keeps the rest of the application responsive while a six-hour
   * job runs in the background.
   */
  private async runWhisper(
    bin: string,
    wav: string,
    req: TranscribeJobRequest
  ): Promise<TranscriptLine[]> {
    const threads = Math.max(2, Math.min(cpus().length - 2, 12))
    const outStem = join(req.workDir, `whisper-${Date.now().toString(36)}`)
    const spec = modelSpec(req.model)

    const args = [
      '-m',
      req.modelPath,
      '-f',
      wav,
      '-t',
      String(threads),
      '-oj',
      '-of',
      outStem,
      '--print-progress',
      // Timestamps are the whole point — they are what ties a line to the
      // event clock — so they are never suppressed.
      '-l',
      spec.englishOnly ? 'en' : req.language
    ]

    // Voice-activity detection skips silence outright. On a game VOD, where
    // long stretches have no speech at all, this is the single largest saving
    // available after the GPU itself.
    if (req.useVad && req.vadModelPath) {
      args.push('--vad', '--vad-model', req.vadModelPath)
    }

    const startedAt = Date.now()
    const result = await run(bin, args, {
      signal: req.signal,
      // A long VOD legitimately produces no output for minutes at a time while
      // it works, so the idle timeout has to be generous or it kills its own job.
      idleTimeoutMs: 30 * 60_000,
      onStderr: (chunk) => {
        const fraction = parseWhisperProgress(chunk)
        if (fraction === null) return
        const elapsed = (Date.now() - startedAt) / 1000
        const processed = fraction * req.durationSeconds
        const rate = elapsed > 0 && processed > 0 ? processed / elapsed : null
        req.onProgress({
          sourceId: req.sourceId,
          stage: 'transcribing',
          // The remaining 80% of the bar; the fetch and decode took the first fifth.
          fraction: 0.2 + 0.8 * fraction,
          processedSeconds: processed,
          totalSeconds: req.durationSeconds,
          realtimeFactor: rate,
          etaSeconds: rate && rate > 0 ? Math.round((req.durationSeconds - processed) / rate) : null,
          message: rate ? `Transcribing at ${rate.toFixed(1)}x real time…` : 'Transcribing…'
        })
      }
    })

    if (result.aborted) throw Errors.cancelled()
    if (result.code !== 0) {
      throw Errors.resolverFailed(
        `Transcription failed: ${result.stderr.slice(-800) || `exit code ${result.code}`}`
      )
    }

    const json = JSON.parse(await readFile(`${outStem}.json`, 'utf8')) as WhisperJson
    await rm(`${outStem}.json`, { force: true }).catch(() => undefined)
    return linesFromWhisperJson(json)
  }

  /** True when the installed whisper is the CUDA build — reported, not assumed. */
  private async hasCudaBuild(): Promise<boolean> {
    const bin = await this.resolveBinary()
    if (!bin) return false
    const dir = bin.slice(0, Math.max(bin.lastIndexOf('/'), bin.lastIndexOf('\\')))
    try {
      const { readdir } = await import('node:fs/promises')
      const names = await readdir(dir)
      return names.some((n) => /^ggml-cuda\.(dll|so)$/i.test(n))
    } catch {
      return false
    }
  }
}
