import { anchorsFromPairing } from './sync.js'
import type { SyncAnchor } from './sync.js'

/**
 * Aligning two POVs by their sound.
 *
 * The same gunshot, door slam or line of dialogue reaches every stream in the
 * room at the same instant, so the loudness envelopes of two POVs of one event
 * are the same shape at different offsets. Sliding one against the other and
 * taking the best correlation recovers that offset — no model, no network, just
 * the peaks the waveform view already fetched.
 *
 * Pure and deterministic: the caller supplies the samples.
 */

export interface AlignmentResult {
  /**
   * Seconds to shift the target so it lines up with the reference. Positive
   * means the target's audio happens later than the current mapping claims.
   */
  offsetSeconds: number
  /** Peak correlation, 0..1. */
  score: number
  /** How far clear of the runner-up the winner is, 0..1. */
  margin: number
  /** True when the match is strong and unambiguous enough to act on. */
  confident: boolean
}

/** Below these the answer is a coin flip and padding is the honest response. */
export const MIN_SCORE = 0.55
export const MIN_MARGIN = 0.12

/** Subtract the mean and divide by the norm, so correlation is scale-free. */
function normalise(values: number[]): { data: Float64Array; norm: number } {
  const data = new Float64Array(values.length)
  let mean = 0
  for (const v of values) mean += v
  mean /= Math.max(1, values.length)
  let sumSquares = 0
  for (let i = 0; i < values.length; i++) {
    data[i] = values[i] - mean
    sumSquares += data[i] * data[i]
  }
  return { data, norm: Math.sqrt(sumSquares) }
}

/**
 * Best alignment of `target` against `reference`.
 *
 * Both arrays must cover the same span of time at the same resolution — which
 * is exactly what two equal-length peak windows are. `secondsPerBucket` turns
 * the winning shift back into seconds.
 */
export function alignByAudio(
  reference: number[],
  target: number[],
  secondsPerBucket: number,
  maxShiftBuckets = Math.floor(Math.min(reference.length, target.length) / 2)
): AlignmentResult {
  const none: AlignmentResult = { offsetSeconds: 0, score: 0, margin: 0, confident: false }
  const n = Math.min(reference.length, target.length)
  if (n < 8 || secondsPerBucket <= 0) return none

  const a = normalise(reference.slice(0, n))
  const b = normalise(target.slice(0, n))
  // A flat line correlates with everything and means nothing: silence, or a
  // constant tone, must not be reported as a match.
  if (a.norm < 1e-6 || b.norm < 1e-6) return none

  const limit = Math.max(1, Math.min(maxShiftBuckets, n - 4))
  const scores: Array<{ shift: number; score: number }> = []

  for (let shift = -limit; shift <= limit; shift++) {
    let dot = 0
    let count = 0
    for (let i = 0; i < n; i++) {
      const j = i + shift
      if (j < 0 || j >= n) continue
      dot += a.data[i] * b.data[j]
      count++
    }
    // Overlaps shrink towards the extremes; normalising by the overlap alone
    // would make a two-sample tail look like a perfect match.
    if (count < n / 2) continue
    scores.push({ shift, score: dot / (a.norm * b.norm) })
  }
  if (scores.length === 0) return none

  scores.sort((x, y) => y.score - x.score)
  const best = scores[0]
  if (best.score <= 0) return none

  // The runner-up must be a genuinely different alignment, not the bucket next
  // to the winner — neighbouring shifts always score alike.
  const rival = scores.find((s) => Math.abs(s.shift - best.shift) > 2)
  const margin = rival ? Math.max(0, best.score - rival.score) : best.score

  return {
    offsetSeconds: Math.round(best.shift * secondsPerBucket * 1000) / 1000,
    score: Math.round(best.score * 1000) / 1000,
    margin: Math.round(margin * 1000) / 1000,
    confident: best.score >= MIN_SCORE && margin >= MIN_MARGIN
  }
}

/**
 * Turn a confident audio match into sync evidence for both POVs, the same
 * shape a manual "this moment in A is this moment in B" pairing produces —
 * so it flows through the existing anchor pool and weighted solver exactly
 * like any other evidence, and a `manual` mapping still cannot be overridden
 * by it. Returns null for a weak match: an unconvincing alignment must never
 * become evidence, since a bad anchor is worse than no anchor.
 */
export function buildAudioAnchors(
  reference: { vodId: string; localTime: number },
  target: { vodId: string; localTime: number },
  eventTime: number,
  alignment: AlignmentResult,
  makeId: (prefix: string) => string
): SyncAnchor[] | null {
  if (!alignment.confident) return null
  // A clean, decisive match earns close to full trust; a merely-confident one
  // (right at the MIN_SCORE/MIN_MARGIN thresholds) earns less, so it still
  // corroborates without dominating a stronger existing anchor.
  const weight = Math.max(0.3, Math.min(0.95, alignment.score * (0.5 + alignment.margin)))
  return anchorsFromPairing(
    [
      { vodId: reference.vodId, localTime: reference.localTime },
      { vodId: target.vodId, localTime: target.localTime + alignment.offsetSeconds }
    ],
    eventTime,
    'audio_anchor',
    makeId,
    weight
  )
}
