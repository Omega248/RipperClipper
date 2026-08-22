import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseVtt } from '../../shared/transcript.js'
import type { Transcript } from '../../shared/transcript.js'
import type { TranscribeProgress, WhisperModelId } from '../../shared/transcription.js'
import type { VodSource } from '../../shared/types.js'
import type { ResolverService } from '../media/resolver.js'
import type { TranscribeService } from '../media/transcribe.js'
import type { WhisperModelService } from './whisperModels.js'
import { selectStreams } from '../media/formats.js'
import { atomicWriteJson } from './projects.js'
import type { Logger } from './logger.js'
import { ConcurrencyLimiter } from './limiter.js'

/**
 * Where a POV's words come from, and where they are kept.
 *
 * Two sources, in order of cost:
 *
 *  1. **Published captions.** YouTube auto-captions everything, and yt-dlp
 *     fetches them without downloading a byte of video — seconds of work.
 *     Twitch and Kick publish none at all.
 *  2. **Local speech-to-text.** whisper.cpp on this machine, which is the only
 *     option for Twitch and Kick and the only one that works offline. It is
 *     fast (25x real time on a GPU) but not free, so it is never started
 *     implicitly — searching dialogue must not silently begin an hour of
 *     computation. The editor asks for it.
 *
 * Results are written to disk, keyed by POV *and by how they were produced*.
 * A six-hour transcription that vanished when the app restarted would be
 * worse than not offering the feature, and re-running it because the editor
 * later chose a better model should not throw away the one already made.
 */

/** Transcripts are cached in memory too, so a search does not re-read the disk. */
const MAX_CACHED = 40

export class TranscriptService {
  private readonly cache = new Map<string, Transcript | null>()
  private readonly limiter = new ConcurrencyLimiter(2)
  /** In-flight transcription jobs, so one POV is never transcribed twice at once. */
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly log: Logger,
    private readonly resolver: ResolverService,
    private readonly dir: string,
    private readonly transcribe: TranscribeService | null = null,
    private readonly models: WhisperModelService | null = null,
    private readonly workDir: string = tmpdir()
  ) {}

  /**
   * This POV's transcript, if one already exists.
   *
   * Checks disk, then published captions — never speech-to-text, which is far
   * too expensive to start from a search box.
   */
  async forSource(source: VodSource, signal?: AbortSignal): Promise<Transcript | null> {
    const cached = this.cache.get(source.id)
    if (cached !== undefined) return cached

    const stored = await this.read(source.id)
    if (stored) {
      this.remember(source.id, stored)
      return stored
    }

    const transcript = await this.limiter.run(() => this.fetchCaptions(source, signal))
    this.remember(source.id, transcript)
    if (transcript) await this.write(transcript)
    return transcript
  }

  /** Every available transcript for a set of POVs. Missing ones are simply absent. */
  async forSources(sources: VodSource[], signal?: AbortSignal): Promise<Transcript[]> {
    const all = await Promise.all(sources.map((s) => this.forSource(s, signal).catch(() => null)))
    return all.filter((t): t is Transcript => t !== null)
  }

  /**
   * Transcribe a POV locally, start to finish.
   *
   * Explicit, cancellable and persisted. A POV already being transcribed is
   * not started again — the existing job's progress is what the caller wants.
   */
  async transcribeSource(
    source: VodSource,
    opts: {
      model: WhisperModelId
      language: string
      useVad: boolean
      onProgress: (progress: TranscribeProgress) => void
    }
  ): Promise<Transcript> {
    if (!this.transcribe || !this.models) {
      throw new Error('Local transcription is not available in this build.')
    }
    if (this.running.has(source.id)) {
      throw new Error('This POV is already being transcribed.')
    }

    const modelPath = await this.models.pathFor(opts.model)
    if (!modelPath) {
      throw new Error('That speech model is not downloaded yet.')
    }

    // Audio only: transcription needs nothing else, and an audio-only stream
    // is a fraction of the bytes of the video it accompanies.
    // 'audio-only' asks the selector for the smallest thing carrying sound;
    // `muxed` is a flag, not a stream, so video is the fallback when a source
    // offers no separate audio track.
    const streams = selectStreams(source.formats ?? [], 'audio-only')
    const stream = streams.audio ?? streams.video
    if (!stream) {
      throw new Error('This POV exposes no audio stream to transcribe.')
    }

    const controller = new AbortController()
    this.running.set(source.id, controller)
    try {
      const result = await this.transcribe.transcribe({
        sourceId: source.id,
        stream,
        durationSeconds: source.durationSeconds,
        model: opts.model,
        modelPath,
        language: opts.language,
        useVad: opts.useVad,
        vadModelPath: null,
        workDir: this.workDir,
        signal: controller.signal,
        onProgress: opts.onProgress
      })

      const transcript: Transcript = {
        sourceId: source.id,
        language: opts.language === 'auto' ? 'auto' : opts.language,
        origin: 'speech-to-text',
        lines: result.lines,
        fetchedAt: new Date().toISOString()
      }
      this.remember(source.id, transcript)
      await this.write(transcript)
      return transcript
    } finally {
      this.running.delete(source.id)
    }
  }

  /** Stops an in-flight transcription. Whatever was done is discarded. */
  cancel(sourceId: string): boolean {
    const controller = this.running.get(sourceId)
    if (!controller) return false
    controller.abort()
    this.running.delete(sourceId)
    return true
  }

  isRunning(sourceId: string): boolean {
    return this.running.has(sourceId)
  }

  /** Drops a POV's transcript from memory and disk, so it can be redone. */
  async forget(sourceId: string): Promise<void> {
    this.cache.delete(sourceId)
    await rm(this.fileFor(sourceId), { force: true }).catch(() => undefined)
  }

  /** Total bytes of stored transcripts, for the storage report. */
  async sizeBytes(): Promise<number> {
    try {
      const names = await readdir(this.dir)
      let total = 0
      for (const name of names) {
        try {
          const { stat } = await import('node:fs/promises')
          total += (await stat(join(this.dir, name))).size
        } catch {
          // vanished between listing and measuring
        }
      }
      return total
    } catch {
      return 0
    }
  }

  private remember(sourceId: string, transcript: Transcript | null): void {
    if (this.cache.size >= MAX_CACHED) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(sourceId, transcript)
  }

  /** Keyed by POV id, hashed so an id can never escape the transcripts folder. */
  private fileFor(sourceId: string): string {
    const safe = createHash('sha256').update(sourceId).digest('hex').slice(0, 32)
    return join(this.dir, `${safe}.json`)
  }

  private async read(sourceId: string): Promise<Transcript | null> {
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(sourceId), 'utf8')) as Transcript
      return Array.isArray(parsed?.lines) ? parsed : null
    } catch {
      return null
    }
  }

  private async write(transcript: Transcript): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await atomicWriteJson(this.fileFor(transcript.sourceId), transcript)
    } catch (err) {
      // Losing the cache copy is survivable; losing the transcription is not
      // worth throwing over, since the caller already has it in hand.
      this.log.warn('transcripts', 'Could not save a transcript', { error: err })
    }
  }

  /**
   * Published captions, where the platform has any.
   *
   * Stated as a fact about the platform rather than discovered by a failed
   * fetch, so no time is spent proving what is already known.
   */
  private async fetchCaptions(source: VodSource, signal?: AbortSignal): Promise<Transcript | null> {
    if (source.platform !== 'youtube') return null

    const dir = await mkdtemp(join(tmpdir(), 'ripper-subs-'))
    try {
      const vtt = await this.resolver.captions(source.url, { signal, outputDir: dir })
      if (!vtt) return null
      const lines = parseVtt(vtt)
      if (lines.length === 0) return null
      this.log.info('transcripts', 'Fetched published captions', {
        sourceId: source.id,
        lines: lines.length
      })
      return {
        sourceId: source.id,
        language: 'en',
        origin: 'auto-captions',
        lines,
        fetchedAt: new Date().toISOString()
      }
    } catch (err) {
      this.log.warn('transcripts', 'Could not fetch captions', { sourceId: source.id, error: err })
      return null
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
