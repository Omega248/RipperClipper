import { readFile, mkdir, rm } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { linesFromWhisperJson, parseWhisperProgress } from '../../shared/transcription.js'
import type { AnalysisProgress, TranscriptLine, WhisperJson, WhisperModelId } from '../../shared/transcription.js'
import { toFfmpegTime } from '../../shared/time.js'
import type { StreamInfo } from '../../shared/types.js'
import type { FfmpegService } from './ffmpeg.js'
import type { RangeFetcher } from './rangeFetcher.js'
import { windowExtension } from './exporter.js'
import { run } from '../services/process.js'
import { locateExecutable } from '../services/locate.js'
import type { Logger } from '../services/logger.js'

/**
 * Reading out what was said in one POV's cut of one clip.
 *
 * Everything here is scoped to the clip's own range, which is what makes it
 * cheap enough to run automatically in the background the moment a clip
 * exists. Three things follow from that scope:
 *
 *  1. Only the clip's seconds are fetched, through the same range machinery
 *     the exporter uses — a five-minute window, never the broadcast.
 *  2. The audio is decoded once straight to whisper's own 16 kHz mono, so
 *     whisper never resamples.
 *  3. No GPU. At ~17x real time on CPU a five-minute clip is about twenty
 *     seconds, so a GPU's setup cost would exceed the entire job.
 *
 * Times come back relative to the clip — 0 is the clip's start — because
 * that is the frame an `AudioEdit` lives in, so a hit can become a mute with
 * no further arithmetic.
 */

/** Whisper's native input rate. Anything else makes it resample. */
const WHISPER_SAMPLE_RATE = 16000

export interface ClipAnalysisRequest {
  clipId: string
  sourceId: string
  /** The audio stream to read — audio-only where the POV offers one. */
  stream: StreamInfo
  /** The clip's range in this POV's own VOD time. */
  startSeconds: number
  endSeconds: number
  model: WhisperModelId
  modelPath: string
  workDir: string
  signal?: AbortSignal
  onProgress: (progress: AnalysisProgress) => void
}

export class ClipAnalysisService {
  private binary: string | null | undefined

  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher
  ) {}

  /** Whether local transcription is possible at all. */
  async available(): Promise<boolean> {
    return (await this.resolveBinary()) !== null
  }

  private async resolveBinary(): Promise<string | null> {
    if (this.binary !== undefined) return this.binary
    const found = await locateExecutable(['whisper-cli'])
    this.binary = found.path
    return this.binary
  }

  async analyse(req: ClipAnalysisRequest): Promise<TranscriptLine[]> {
    const bin = await this.resolveBinary()
    if (!bin) throw Errors.resolverFailed('Whisper is not installed.')

    const duration = req.endSeconds - req.startSeconds
    if (!(duration > 0)) throw Errors.invalidRange('That clip has no length to read.')

    const work = join(req.workDir, `stt-${req.clipId}-${req.sourceId}-${Date.now().toString(36)}`)
    await mkdir(work, { recursive: true })

    try {
      req.onProgress({
        clipId: req.clipId,
        sourceId: req.sourceId,
        stage: 'fetching',
        fraction: 0,
        message: 'Fetching audio…'
      })

      const window = await this.fetcher.fetchWindow({
        stream: req.stream,
        startSeconds: req.startSeconds,
        endSeconds: req.endSeconds,
        destination: join(work, `window.${windowExtension(req.stream.container)}`),
        signal: req.signal,
        onProgress: () => undefined
      })

      // The fetched window can start earlier than asked (segment boundaries),
      // so trim from its real start — otherwise every time below would be
      // offset by however much slack the fetch happened to include.
      const offset = Math.max(0, req.startSeconds - window.windowStartSeconds)
      const wav = join(work, 'audio.wav')
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
          String(WHISPER_SAMPLE_RATE),
          '-c:a',
          'pcm_s16le',
          wav
        ],
        { signal: req.signal, label: 'clip transcription decode' }
      )

      const lines = await this.runWhisper(bin, wav, work, req)
      this.log.info('analysis', 'Read a clip', {
        clipId: req.clipId,
        sourceId: req.sourceId,
        seconds: Math.round(duration),
        lines: lines.length
      })
      return lines
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Run whisper over the prepared WAV and parse its JSON.
   *
   * A couple of cores are left free: this runs in the background while the
   * editor is still working, and a transcription that makes scrubbing stutter
   * would be worse than one that takes a few seconds longer.
   */
  private async runWhisper(
    bin: string,
    wav: string,
    work: string,
    req: ClipAnalysisRequest
  ): Promise<TranscriptLine[]> {
    const threads = Math.max(2, Math.min(cpus().length - 2, 8))
    const stem = join(work, 'out')

    const result = await run(
      bin,
      [
        '-m',
        req.modelPath,
        '-f',
        wav,
        '-t',
        String(threads),
        '-oj',
        '-of',
        stem,
        '--print-progress',
        '-l',
        'en'
      ],
      {
        signal: req.signal,
        // A long clip can be quiet for a while mid-run; the idle timeout has
        // to be generous or it kills its own job.
        idleTimeoutMs: 10 * 60_000,
        onStderr: (chunk) => {
          const fraction = parseWhisperProgress(chunk)
          if (fraction === null) return
          req.onProgress({
            clipId: req.clipId,
            sourceId: req.sourceId,
            stage: 'transcribing',
            // Fetch and decode were the first fifth of the work.
            fraction: 0.2 + 0.8 * fraction,
            message: 'Reading what was said…'
          })
        }
      }
    )

    if (result.aborted) throw Errors.cancelled()
    if (result.code !== 0) {
      throw Errors.resolverFailed(
        `Transcription failed: ${result.stderr.slice(-600) || `exit code ${result.code}`}`
      )
    }

    const json = JSON.parse(await readFile(`${stem}.json`, 'utf8')) as WhisperJson
    return linesFromWhisperJson(json)
  }
}
