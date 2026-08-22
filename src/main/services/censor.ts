import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { findProfanity, mergeHits } from '../../shared/profanity.js'
import type { ProfanityHit } from '../../shared/profanity.js'
import { effectiveWordList } from '../../shared/profanity.js'
import type { AnalysisProgress, ClipTranscript, WhisperModelId } from '../../shared/transcription.js'
import type { ClipAnalysisService } from '../media/clipAnalysis.js'
import type { WhisperModelService } from './whisperModels.js'
import { selectStreams } from '../media/formats.js'
import { atomicWriteJson } from './projects.js'
import type { VodSource } from '../../shared/types.js'
import type { Logger } from './logger.js'
import { ConcurrencyLimiter } from './limiter.js'

/**
 * Reading every POV of a clip, quietly, and suggesting what to censor.
 *
 * This is meant to happen *without being asked*: the moment a clip exists,
 * each POV that covers it is fetched and read in the background, so by the
 * time the editor opens the censor list the answers are already there. That
 * only works because the unit of work is a clip range rather than a
 * broadcast — seconds per POV, not hours.
 *
 * Results are written to disk keyed by clip, POV and model. Re-opening a
 * project must not re-run the work, and changing the word list must not
 * either: the transcript is the expensive part and it is independent of
 * which words are being looked for, so the list is applied fresh on every
 * read and can be edited freely at no cost.
 *
 * Failure is quiet by design. A POV whose audio cannot be fetched simply has
 * no suggestions; it must never interrupt the editor, because this runs
 * uninvited and an uninvited error dialog is worse than a missing hint.
 */

/** How many POVs are read at once. Background work must leave the app usable. */
const CONCURRENCY = 2

export interface ClipAnalysisState {
  clipId: string
  sourceId: string
  stage: AnalysisProgress['stage']
  fraction: number
  message: string
}

export class CensorService {
  private readonly limiter = new ConcurrencyLimiter(CONCURRENCY)
  /** Everything running or finished this session, keyed clip:pov. */
  private readonly state = new Map<string, ClipAnalysisState>()
  private readonly running = new Map<string, AbortController>()
  /** In-memory transcripts, so building the hit list never re-reads the disk. */
  private readonly cache = new Map<string, ClipTranscript>()

  constructor(
    private readonly log: Logger,
    private readonly analysis: ClipAnalysisService,
    private readonly models: WhisperModelService,
    private readonly dir: string,
    private readonly workDir: string,
    private readonly onProgress: (progress: AnalysisProgress) => void
  ) {}

  private key(clipId: string, sourceId: string): string {
    return `${clipId}:${sourceId}`
  }

  /** Whether local reading is possible: the binary and at least one model. */
  async ready(): Promise<{ available: boolean; reason: string | null }> {
    if (!(await this.analysis.available())) {
      return { available: false, reason: 'The speech engine is not installed yet.' }
    }
    if (!(await this.models.bestInstalled())) {
      return { available: false, reason: 'No speech model has been downloaded yet.' }
    }
    return { available: true, reason: null }
  }

  /**
   * Read one POV's cut of a clip, unless it has already been read.
   *
   * Idempotent and safe to call repeatedly — the automatic sweep leans on
   * that, since it fires whenever a clip or POV changes.
   */
  async analyseOne(
    clipId: string,
    source: VodSource,
    startSeconds: number,
    endSeconds: number,
    model: WhisperModelId
  ): Promise<ClipTranscript | null> {
    const key = this.key(clipId, source.id)
    if (this.running.has(key)) return null

    const existing = await this.read(clipId, source.id)
    if (existing && existing.model === model) {
      this.cache.set(key, existing)
      this.report(clipId, source.id, 'complete', 1, 'Already read.')
      return existing
    }

    const modelPath = await this.models.pathFor(model)
    if (!modelPath) return null

    const stream = pickAudio(source)
    if (!stream) {
      // A POV with no reachable audio is a fact, not a failure — say so once
      // and never retry it.
      this.report(clipId, source.id, 'skipped', 1, 'This POV has no audio to read.')
      return null
    }

    const controller = new AbortController()
    this.running.set(key, controller)
    this.report(clipId, source.id, 'queued', 0, 'Waiting…')

    try {
      const lines = await this.limiter.run(() =>
        this.analysis.analyse({
          clipId,
          sourceId: source.id,
          stream,
          startSeconds,
          endSeconds,
          model,
          modelPath,
          workDir: this.workDir,
          signal: controller.signal,
          onProgress: (p) => this.report(clipId, source.id, p.stage, p.fraction, p.message)
        })
      )

      const transcript: ClipTranscript = {
        clipId,
        sourceId: source.id,
        model,
        lines,
        createdAt: new Date().toISOString()
      }
      this.cache.set(key, transcript)
      await this.write(transcript)
      this.report(clipId, source.id, 'complete', 1, `${lines.length} lines read.`)
      return transcript
    } catch (err) {
      // Quiet: this was never asked for, so it must not interrupt anyone.
      this.log.warn('censor', 'Could not read a POV', {
        clipId,
        sourceId: source.id,
        error: err
      })
      this.report(clipId, source.id, 'failed', 1, 'Could not read this POV.')
      return null
    } finally {
      this.running.delete(key)
    }
  }

  /** Stops everything in flight for one clip. */
  cancel(clipId: string): void {
    for (const [key, controller] of this.running) {
      if (key.startsWith(`${clipId}:`)) controller.abort()
    }
  }

  /** Progress for every POV of a clip, for the review UI's header. */
  statesFor(clipId: string): ClipAnalysisState[] {
    return [...this.state.values()].filter((s) => s.clipId === clipId)
  }

  /**
   * The censor suggestions for a clip, across every POV already read.
   *
   * The word list is applied here rather than at transcription time, so
   * editing it is instant and never costs a re-read.
   */
  async hitsFor(clipId: string, sourceIds: string[], words: string[] | undefined): Promise<ProfanityHit[]> {
    const list = effectiveWordList(words)
    const all: ProfanityHit[] = []
    for (const sourceId of sourceIds) {
      const transcript = await this.transcriptFor(clipId, sourceId)
      if (!transcript) continue
      all.push(...findProfanity(transcript.lines, sourceId, list))
    }
    return mergeHits(all)
  }

  /** One POV's transcript, from memory or disk. */
  async transcriptFor(clipId: string, sourceId: string): Promise<ClipTranscript | null> {
    const key = this.key(clipId, sourceId)
    const cached = this.cache.get(key)
    if (cached) return cached
    const stored = await this.read(clipId, sourceId)
    if (stored) this.cache.set(key, stored)
    return stored
  }

  /** Drops a clip's readings so they are made again. */
  async forget(clipId: string, sourceIds: string[]): Promise<void> {
    for (const sourceId of sourceIds) {
      this.cache.delete(this.key(clipId, sourceId))
      this.state.delete(this.key(clipId, sourceId))
      await rm(this.fileFor(clipId, sourceId), { force: true }).catch(() => undefined)
    }
  }

  private report(
    clipId: string,
    sourceId: string,
    stage: AnalysisProgress['stage'],
    fraction: number,
    message: string
  ): void {
    const next: ClipAnalysisState = { clipId, sourceId, stage, fraction, message }
    this.state.set(this.key(clipId, sourceId), next)
    this.onProgress({ clipId, sourceId, stage, fraction, message })
  }

  /** Hashed, so neither id can ever escape the readings folder. */
  private fileFor(clipId: string, sourceId: string): string {
    const safe = createHash('sha256').update(`${clipId}:${sourceId}`).digest('hex').slice(0, 32)
    return join(this.dir, `${safe}.json`)
  }

  private async read(clipId: string, sourceId: string): Promise<ClipTranscript | null> {
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(clipId, sourceId), 'utf8')) as ClipTranscript
      return Array.isArray(parsed?.lines) ? parsed : null
    } catch {
      return null
    }
  }

  private async write(transcript: ClipTranscript): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await atomicWriteJson(this.fileFor(transcript.clipId, transcript.sourceId), transcript)
    } catch (err) {
      // The caller already holds the result; losing the copy is survivable.
      this.log.warn('censor', 'Could not save a reading', { error: err })
    }
  }
}

/**
 * The cheapest stream carrying this POV's sound.
 *
 * `muxed` is a flag rather than a stream, so video is the fallback when a POV
 * offers no separate audio track — reading it still works, it just costs more
 * to fetch.
 */
function pickAudio(source: VodSource): ReturnType<typeof selectStreams>['audio'] {
  const formats = source.formats ?? []
  if (formats.length === 0) return null
  try {
    const streams = selectStreams(formats, 'audio-only')
    return streams.audio ?? streams.video
  } catch {
    return null
  }
}
