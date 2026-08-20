/**
 * Who else was live at this moment.
 *
 * The event's real-world range is the only thing compared. A broadcast belongs
 * to an event when the two overlap on the wall clock:
 *
 *     broadcast start <= event end   AND   broadcast end >= event start
 *
 * VOD-relative timestamps are never compared against each other, because two
 * streams that both say "01:12:30" were not in the same place at the same time.
 * That is the same rule the rest of the application syncs by, applied to
 * discovery instead of playback.
 */

import type { SearchableVod } from './vodSearch.js'

export type StreamAvailability =
  /** Already a POV in this project. */
  | 'loaded'
  /** A saved streamer's broadcast that covers the moment but is not loaded. */
  | 'available'

export interface OverlapCoverage {
  /** Real-world seconds this broadcast actually covers of the event. */
  coveredStart: number
  coveredEnd: number
  /** Fraction of the event this broadcast can show, 0..1. */
  fraction: number
  complete: boolean
  /** Seconds into the broadcast where the event begins. Clamped at zero. */
  offsetSeconds: number
  /**
   * False when the broadcast's length is unknown, so "it was still running"
   * cannot be proven. Worth showing, clearly marked, rather than hiding: a
   * platform that omits the duration of a recent stream is exactly the case an
   * editor is hunting for.
   */
  certain: boolean
}

export interface OverlappingStream<V extends SearchableVod = SearchableVod> {
  streamerId: string
  streamerName: string
  platform: string
  vod: V
  availability: StreamAvailability
  /** Set when this broadcast is already loaded as a POV. */
  sourceId?: string
  coverage: OverlapCoverage
}

/**
 * How much of an event a single broadcast covers.
 *
 * Returns null when they do not overlap at all — the caller then has nothing to
 * offer, which is the point of §20: a VOD that does not cover the moment is not
 * shown as an available POV.
 */
export function coverageOf(
  vod: SearchableVod,
  eventStartSeconds: number,
  eventEndSeconds: number,
  opts: { assumedDurationSeconds?: number } = {}
): OverlapCoverage | null {
  if (!vod.publishedAt) return null
  const startedMs = Date.parse(vod.publishedAt)
  if (!Number.isFinite(startedMs)) return null

  const started = startedMs / 1000
  const known = vod.durationSeconds !== null && vod.durationSeconds > 0
  // An unknown length is not treated as infinite: a stream is assumed to have
  // run for a long-but-finite session, and the result is marked uncertain.
  const assumed = opts.assumedDurationSeconds ?? 12 * 3600
  const ended = started + (known ? (vod.durationSeconds as number) : assumed)

  if (started > eventEndSeconds || ended < eventStartSeconds) return null

  const coveredStart = Math.max(started, eventStartSeconds)
  const coveredEnd = Math.min(ended, eventEndSeconds)
  const span = Math.max(0, eventEndSeconds - eventStartSeconds)
  const covered = Math.max(0, coveredEnd - coveredStart)

  return {
    coveredStart,
    coveredEnd,
    fraction: span > 0 ? Math.min(1, covered / span) : covered > 0 ? 1 : 0,
    // "Complete" only when the broadcast provably spans the whole event.
    complete: known && started <= eventStartSeconds + 0.5 && ended >= eventEndSeconds - 0.5,
    offsetSeconds: Math.max(0, eventStartSeconds - started),
    certain: known
  }
}

/**
 * Every saved streamer's broadcast that overlaps the event, sorted by how much
 * of it they can show.
 *
 * Already-loaded POVs are included and marked, so the panel reads as one list
 * of "who was there" rather than two disconnected ones.
 */
export function streamsCoveringEvent<V extends SearchableVod>(
  input: {
    eventStartSeconds: number
    eventEndSeconds: number
    library: Array<{
      streamerId: string
      streamerName: string
      platform: string
      vods: V[]
    }>
    /** URLs already loaded as POVs, mapped to their source id. */
    loaded: Map<string, string>
  }
): Array<OverlappingStream<V>> {
  const out: Array<OverlappingStream<V>> = []

  for (const entry of input.library) {
    // A streamer can have several broadcasts touching one event (a stream that
    // dropped and came back). Each is offered separately, best coverage first.
    for (const vod of entry.vods) {
      const coverage = coverageOf(vod, input.eventStartSeconds, input.eventEndSeconds)
      if (!coverage) continue
      const sourceId = input.loaded.get(vod.url)
      out.push({
        streamerId: entry.streamerId,
        streamerName: entry.streamerName,
        platform: entry.platform,
        vod,
        availability: sourceId ? 'loaded' : 'available',
        sourceId,
        coverage
      })
    }
  }

  return out.sort((a, b) => {
    // Loaded angles first — they are one click from being watched — then by how
    // much of the moment each can actually show.
    if (a.availability !== b.availability) return a.availability === 'loaded' ? -1 : 1
    return b.coverage.fraction - a.coverage.fraction || a.streamerName.localeCompare(b.streamerName)
  })
}

/** A short description of what a broadcast can show of the event. */
export function coverageLabel(
  coverage: Pick<OverlapCoverage, 'certain' | 'complete' | 'fraction'>
): string {
  if (!coverage.certain) return 'Length unknown'
  if (coverage.complete) return 'Covers the whole clip'
  const pct = Math.round(coverage.fraction * 100)
  return pct >= 99 ? 'Covers the whole clip' : `Covers ${pct}% of the clip`
}
