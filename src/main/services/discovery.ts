import { net } from 'electron'
import { rankDiscoveries } from '../../shared/discovery.js'
import type { DiscoveryCandidate, DiscoveredStream, EventQuery } from '../../shared/discovery.js'
import { kickVodsFromChannel, publishedAtFromRawInfo } from './streamers.js'
import type { StreamerService } from './streamers.js'
import type { ResolverService } from '../media/resolver.js'
import type { Logger } from './logger.js'
import { ConcurrencyLimiter } from './limiter.js'

/**
 * Searching every platform at once for the POVs of one real-world event.
 *
 * What this can and cannot do is worth stating plainly, because the difference
 * drives the whole design:
 *
 *   - The **streamer library** is exact. Every saved channel is asked for its
 *     recent broadcasts and each is overlap-tested. This is the only source
 *     that reliably answers "was this specific person live at 18:30".
 *   - **YouTube** genuinely supports keyword search (yt-dlp's `ytsearch`), so
 *     an event's name and the RP terminology can find channels nobody saved.
 *   - **Kick** exposes a per-channel VOD listing but no usable public search,
 *     so it is swept through the library and through channels named in the
 *     query rather than browsed.
 *   - **Twitch** has no unauthenticated way to ask "who streamed this
 *     category at this time" — its API requires OAuth credentials the user
 *     owns. Twitch is therefore covered through the library, and a search
 *     sweep is reported as unavailable rather than silently returning
 *     nothing, so "no Twitch results" is never mistaken for "nobody was
 *     live".
 *
 * Every gap is reported in `notes` on the reply. A partial sweep presented as
 * a complete one would be worse than no sweep at all: the editor would stop
 * looking for a POV that is genuinely out there.
 */

/** Searches yt-dlp runs per query term. Kept small — each is a real request. */
const YOUTUBE_RESULTS_PER_TERM = 20

/** Bounds concurrent platform requests so a big library doesn't spawn dozens at once. */
const SWEEP_CONCURRENCY = 4

export interface DiscoveryRequest extends EventQuery {
  /** VOD URLs already loaded as POVs, so they are marked rather than re-offered. */
  loadedUrls: string[]
  /** Include a keyword sweep of the platforms that support one. */
  includeSearch: boolean
}

export interface DiscoveryReply {
  streams: DiscoveredStream[]
  /** Channels that could not be reached — a partial answer is never silent. */
  unreachable: string[]
  /** Plain-language notes about what was and was not swept. */
  notes: string[]
}

export class DiscoveryService {
  private readonly limiter = new ConcurrencyLimiter(SWEEP_CONCURRENCY)

  constructor(
    private readonly log: Logger,
    private readonly streamers: StreamerService,
    private readonly resolver: ResolverService
  ) {}

  async discover(req: DiscoveryRequest, signal?: AbortSignal): Promise<DiscoveryReply> {
    const unreachable: string[] = []
    const notes: string[] = []
    const candidates: DiscoveryCandidate[] = []

    const loaded = new Set(req.loadedUrls)

    // ---- the library sweep: the one exact source ----------------------------
    const fromLibrary = await this.sweepLibrary(unreachable, signal)
    for (const c of fromLibrary) {
      candidates.push(loaded.has(c.url) ? { ...c, source: 'loaded' } : c)
    }

    // ---- the keyword sweep: only where a platform really supports one -------
    if (req.includeSearch) {
      const terms = searchTermsFor(req)
      try {
        const found = await this.searchYouTube(terms, signal)
        for (const c of found) candidates.push(loaded.has(c.url) ? { ...c, source: 'loaded' } : c)
        notes.push(`Searched YouTube for ${terms.map((t) => `"${t}"`).join(', ')}.`)
      } catch (err) {
        this.log.warn('discovery', 'YouTube search failed', { error: err })
        notes.push('YouTube search could not be completed this time.')
      }

      // Stated rather than silently skipped — see the class comment.
      notes.push(
        'Twitch and Kick have no public search for past broadcasts, so they were swept through your streamer library only. Add a channel to the library to include it.'
      )
    }

    const streams = rankDiscoveries(candidates, {
      startSeconds: req.startSeconds,
      endSeconds: req.endSeconds,
      name: req.name,
      platform: req.platform
    })

    this.log.info('discovery', 'Event sweep finished', {
      candidates: candidates.length,
      matched: streams.length,
      unreachable: unreachable.length
    })

    return { streams, unreachable, notes }
  }

  /**
   * Every saved streamer's recent broadcasts as discovery candidates.
   *
   * Reuses StreamerService.vods, which already handles Kick's own API, yt-dlp
   * channel listings and the per-VOD date enrichment those listings omit —
   * duplicating any of that here is exactly the parallel system to avoid.
   */
  private async sweepLibrary(
    unreachable: string[],
    signal?: AbortSignal
  ): Promise<DiscoveryCandidate[]> {
    const streamers = await this.streamers.list()
    const results = await Promise.all(
      streamers.map((streamer) =>
        this.limiter.run(async (): Promise<DiscoveryCandidate[]> => {
          try {
            const vods = await this.streamers.vods(streamer.id, signal)
            return vods.map((vod) => ({
              url: vod.url,
              title: vod.title,
              publishedAt: vod.publishedAt,
              durationSeconds: vod.durationSeconds,
              platform: streamer.platform,
              channelHandle: streamer.handle,
              channelName: streamer.displayName,
              thumbnailUrl: vod.thumbnailUrl,
              viewCount: vod.viewCount,
              source: 'library' as const,
              streamerId: streamer.id
            }))
          } catch (err) {
            this.log.warn('discovery', 'Could not list a saved channel', {
              handle: streamer.handle,
              error: err
            })
            unreachable.push(streamer.displayName)
            return []
          }
        })
      )
    )
    return results.flat()
  }

  /**
   * YouTube keyword search, the one platform-wide sweep that genuinely works.
   *
   * `ytsearch` returns a flat listing with no dates, and a VOD with no date
   * cannot be overlap-tested at all, so each result is resolved once to
   * recover its timestamp. That is deliberately bounded: the flat listing is
   * cheap, the per-video resolve is not, and an event sweep must not turn
   * into hundreds of yt-dlp processes.
   */
  private async searchYouTube(terms: string[], signal?: AbortSignal): Promise<DiscoveryCandidate[]> {
    const seen = new Set<string>()
    const found: DiscoveryCandidate[] = []

    for (const term of terms) {
      const raw = (await this.resolver.flatPlaylist(
        `ytsearch${YOUTUBE_RESULTS_PER_TERM}:${term}`,
        { signal, limit: YOUTUBE_RESULTS_PER_TERM }
      )) as { entries?: Array<Record<string, any>> } | null

      for (const entry of raw?.entries ?? []) {
        const url = typeof entry.url === 'string' ? entry.url : entry.webpage_url
        if (typeof url !== 'string' || seen.has(url)) continue
        seen.add(url)
        found.push({
          url,
          title: typeof entry.title === 'string' ? entry.title : url,
          publishedAt: publishedAtFromRawInfo(entry),
          durationSeconds: typeof entry.duration === 'number' ? Math.round(entry.duration) : null,
          platform: 'youtube',
          channelHandle: typeof entry.uploader_id === 'string' ? entry.uploader_id.replace(/^@/, '') : '',
          channelName: typeof entry.uploader === 'string' ? entry.uploader : undefined,
          thumbnailUrl: typeof entry.thumbnail === 'string' ? entry.thumbnail : undefined,
          viewCount: typeof entry.view_count === 'number' ? entry.view_count : undefined,
          source: 'search'
        })
      }
    }

    // A search hit with no date cannot be overlap-tested, so recover the date
    // for those — bounded by the same limiter as everything else.
    return Promise.all(
      found.map((c) =>
        c.publishedAt !== null
          ? Promise.resolve(c)
          : this.limiter.run(async () => {
              try {
                const info = await this.resolver.resolve(c.url, { signal })
                return {
                  ...c,
                  publishedAt: publishedAtFromRawInfo(info),
                  durationSeconds:
                    typeof info.duration === 'number' ? Math.round(info.duration) : c.durationSeconds,
                  tags: Array.isArray(info.tags) ? info.tags.filter((t): t is string => typeof t === 'string') : undefined,
                  category: Array.isArray(info.categories) && typeof info.categories[0] === 'string'
                      ? (info.categories[0] as string)
                      : undefined
                }
              } catch {
                return c
              }
            })
      )
    )
  }

  /**
   * A Kick channel's broadcasts, for a handle the editor named directly rather
   * than saved. Kick's own listing is the only route — yt-dlp has no Kick
   * channel extractor, which is the same reason StreamerService talks to this
   * endpoint directly.
   */
  async kickChannel(handle: string, signal?: AbortSignal): Promise<DiscoveryCandidate[]> {
    const url = `https://kick.com/api/v2/channels/${encodeURIComponent(handle)}/videos`
    const response = await net.fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        accept: 'application/json',
        referer: 'https://kick.com/'
      },
      signal
    })
    if (!response.ok) return []
    return kickVodsFromChannel(await response.json(), handle).map((vod) => ({
      url: vod.url,
      title: vod.title,
      publishedAt: vod.publishedAt,
      durationSeconds: vod.durationSeconds,
      platform: 'kick' as const,
      channelHandle: handle,
      thumbnailUrl: vod.thumbnailUrl,
      viewCount: vod.viewCount,
      source: 'search' as const
    }))
  }
}

/**
 * What to actually type into a platform search for this event.
 *
 * The event's own name is the most specific thing available and goes first;
 * the RP terminology is what finds the streams whose titles say nothing about
 * the event but which were unmistakably in the right world (§1.2). Kept to a
 * handful — each term is a real network round trip.
 */
export function searchTermsFor(query: Pick<EventQuery, 'name'>): string[] {
  const terms: string[] = []
  const name = query.name?.trim()
  if (name) {
    terms.push(`${name} nopixel`)
    terms.push(name)
  } else {
    terms.push('nopixel')
  }
  terms.push('nopixel gta rp')
  return [...new Set(terms)].slice(0, 3)
}
