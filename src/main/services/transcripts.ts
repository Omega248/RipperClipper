import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVtt } from '../../shared/transcript.js'
import type { Transcript } from '../../shared/transcript.js'
import type { VodSource } from '../../shared/types.js'
import type { ResolverService } from '../media/resolver.js'
import type { Logger } from './logger.js'
import { ConcurrencyLimiter } from './limiter.js'

/**
 * Getting the words out of a POV (§11).
 *
 * Where they come from depends entirely on the platform, and the honest
 * position is worth stating rather than hiding behind a spinner:
 *
 *   - **YouTube** publishes auto-captions for essentially everything, which
 *     yt-dlp can fetch without downloading a byte of video. For a VOD of a
 *     live broadcast an automatic transcript is the only transcript there is,
 *     and an approximate record of what was said is exactly what searching
 *     dialogue needs.
 *   - **Twitch and Kick** publish no caption track at all. Producing one
 *     would mean running speech-to-text over hours of audio locally — a large
 *     model download and a long CPU-bound pass. That is a real feature but a
 *     separate one, so those POVs report "no transcript available" instead of
 *     appearing to have been searched.
 *
 * Everything downstream — the event-time projection, the cross-POV search —
 * is indifferent to which of those produced the words, so adding local
 * speech-to-text later changes only this file.
 */

/** Transcripts are fetched once per POV and kept for the session. */
const MAX_CACHED = 40

export class TranscriptService {
  private readonly cache = new Map<string, Transcript | null>()
  private readonly limiter = new ConcurrencyLimiter(2)

  constructor(
    private readonly log: Logger,
    private readonly resolver: ResolverService
  ) {}

  /**
   * This POV's transcript, fetching it the first time it is asked for.
   *
   * A POV with no captions is cached as a definite `null` rather than left
   * absent, so sweeping ten POVs does not re-attempt the seven that will
   * never have any every time the search box is used.
   */
  async forSource(source: VodSource, signal?: AbortSignal): Promise<Transcript | null> {
    const cached = this.cache.get(source.id)
    if (cached !== undefined) return cached

    const transcript = await this.limiter.run(() => this.fetch(source, signal))
    if (this.cache.size >= MAX_CACHED) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(source.id, transcript)
    return transcript
  }

  /** Every available transcript for a set of POVs. Missing ones are simply absent. */
  async forSources(sources: VodSource[], signal?: AbortSignal): Promise<Transcript[]> {
    const all = await Promise.all(sources.map((s) => this.forSource(s, signal).catch(() => null)))
    return all.filter((t): t is Transcript => t !== null)
  }

  /** Drops a POV's cached transcript so the next request refetches it. */
  forget(sourceId: string): void {
    this.cache.delete(sourceId)
  }

  private async fetch(source: VodSource, signal?: AbortSignal): Promise<Transcript | null> {
    // Stated as a fact about the platform rather than discovered by a failed
    // fetch, so no time is spent proving what is already known.
    if (source.platform !== 'youtube') {
      this.log.info('transcripts', 'Platform publishes no captions', { platform: source.platform })
      return null
    }

    const dir = await mkdtemp(join(tmpdir(), 'ripper-subs-'))
    try {
      const vtt = await this.resolver.captions(source.url, { signal, outputDir: dir })
      if (!vtt) return null
      const lines = parseVtt(vtt)
      if (lines.length === 0) return null
      this.log.info('transcripts', 'Fetched a transcript', { sourceId: source.id, lines: lines.length })
      return {
        sourceId: source.id,
        language: 'en',
        origin: 'auto-captions',
        lines,
        fetchedAt: new Date().toISOString()
      }
    } catch (err) {
      // One POV having no transcript must never sink a sweep of ten.
      this.log.warn('transcripts', 'Could not fetch captions', { sourceId: source.id, error: err })
      return null
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
