import type { EventOverlapReply } from './ipc.js'

/**
 * How well one broadcast covers the moment being clipped.
 *
 * The matcher already works this out — `streamsCoveringEvent` returns how much
 * of the range a VOD spans, how far into it the moment falls, and whether the
 * two clocks are actually pinned to each other or merely close. What was
 * missing was a way to say that to a person in three words, so a list of
 * candidates can be scanned rather than studied.
 *
 * Deliberately conservative about the top rung: `certain` means the two
 * recordings are synchronised against a shared real-world clock rather than
 * "their timestamps looked similar", and only that earns "High". A stream that
 * merely happened to be live at the same time is not a POV of the same moment,
 * and saying so confidently is how an editor ends up adding nine strangers.
 */
export type MatchStrength = 'high' | 'good' | 'partial' | 'edge'

export interface MatchVerdict {
  strength: MatchStrength
  /** Shown on the card. Short enough to read at a glance. */
  label: string
}

export type Coverage = EventOverlapReply['streams'][number]['coverage']

export function matchVerdict(coverage: Coverage): MatchVerdict {
  if (coverage.complete && coverage.certain) {
    return { strength: 'high', label: 'High timestamp match' }
  }
  if (coverage.complete) return { strength: 'good', label: 'Covers the whole clip' }
  if (coverage.fraction >= 0.5) {
    return { strength: 'partial', label: `Covers ${Math.round(coverage.fraction * 100)}%` }
  }
  return { strength: 'edge', label: 'Only clips the edge' }
}

/** Best matches first; within a strength, the most complete coverage wins. */
export const MATCH_ORDER: Record<MatchStrength, number> = {
  high: 0,
  good: 1,
  partial: 2,
  edge: 3
}

export function byMatch(a: Coverage, b: Coverage): number {
  const rank = MATCH_ORDER[matchVerdict(a).strength] - MATCH_ORDER[matchVerdict(b).strength]
  return rank !== 0 ? rank : b.fraction - a.fraction
}

/**
 * Where inside that broadcast the clip begins.
 *
 * `offsetSeconds` is the matcher's own answer and is what has to survive into
 * the loaded POV: it is the reason a POV added this way lands on the moment
 * rather than at the start of someone's eight-hour stream.
 */
export function momentInVod(coverage: Coverage): number {
  return Math.max(0, coverage.offsetSeconds)
}
