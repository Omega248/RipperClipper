/**
 * Music detection from an audio envelope, without a model.
 *
 * Speech and music differ in ways that survive a coarse analysis: music holds
 * a steady level and a regular beat, speech is gappy and irregular. Three
 * measurements per window, combined:
 *
 *   - continuity: how little of the window is near-silent (speech has gaps
 *     between phrases; music fills them)
 *   - steadiness: how little the loudness wanders (music is compressed and
 *     even; speech swings between syllables and pauses)
 *   - pulse: how strongly the loudness envelope repeats at a musical tempo
 *     (60–180 bpm), found by autocorrelating the envelope
 *
 * This is a heuristic and is reported as one: every range carries a confidence,
 * and the UI says "detected", never "this is music". It does not identify songs
 * and makes no claim about what the music is.
 */

export interface MusicRange {
  startSeconds: number
  endSeconds: number
  /** 0..1 — how strongly the window looked like music. */
  confidence: number
  /** What drove the decision, for the review list. */
  evidence: { continuity: number; steadiness: number; pulse: number }
}

export interface DetectMusicOptions {
  /** Seconds per analysis window. */
  windowSeconds?: number
  /** Confidence needed before a window counts as music. */
  threshold?: number
  /** Ranges shorter than this are dropped as noise. */
  minRangeSeconds?: number
}

/**
 * `envelope` is a loudness value per bucket (the RMS the waveform view already
 * computes), covering `durationSeconds` of audio.
 */
export function detectMusic(
  envelope: number[],
  durationSeconds: number,
  opts: DetectMusicOptions = {}
): MusicRange[] {
  const windowSeconds = opts.windowSeconds ?? 4
  const threshold = opts.threshold ?? 0.62
  const minRange = opts.minRangeSeconds ?? 3
  if (envelope.length < 16 || durationSeconds <= 0) return []

  const perBucket = durationSeconds / envelope.length
  const bucketsPerWindow = Math.max(8, Math.round(windowSeconds / perBucket))
  const ranges: MusicRange[] = []

  for (let start = 0; start < envelope.length; start += bucketsPerWindow) {
    const window = envelope.slice(start, start + bucketsPerWindow)
    if (window.length < 8) break

    const score = scoreWindow(window, perBucket)
    if (score.confidence < threshold) continue

    const from = round3(start * perBucket)
    const to = round3(Math.min(durationSeconds, (start + window.length) * perBucket))
    const last = ranges[ranges.length - 1]
    if (last && from - last.endSeconds < perBucket * 2) {
      // Merge with the window before it, keeping the strongest evidence.
      last.endSeconds = to
      last.confidence = Math.max(last.confidence, score.confidence)
      last.evidence = score.confidence > last.confidence ? score.evidence : last.evidence
      continue
    }
    ranges.push({ startSeconds: from, endSeconds: to, ...score })
  }

  return ranges.filter((r) => r.endSeconds - r.startSeconds >= minRange)
}

/** The three measurements and their combination, exported for testing. */
export function scoreWindow(
  window: number[],
  secondsPerBucket: number
): { confidence: number; evidence: { continuity: number; steadiness: number; pulse: number } } {
  const peak = Math.max(...window)
  if (peak < 0.01) {
    return { confidence: 0, evidence: { continuity: 0, steadiness: 0, pulse: 0 } }
  }

  const mean = window.reduce((a, b) => a + b, 0) / window.length
  const quiet = window.filter((v) => v < peak * 0.12).length / window.length
  const continuity = 1 - quiet

  const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length
  // Coefficient of variation: speech swings hard between syllables and pauses,
  // music sits in a band. Mapped so ~0.35 CV and below reads as steady.
  const cv = Math.sqrt(variance) / Math.max(1e-6, mean)
  const steadiness = clamp01(1 - cv / 0.9)

  const pulse = pulseStrength(window, secondsPerBucket)

  const confidence = clamp01(0.45 * continuity + 0.35 * steadiness + 0.2 * pulse)
  return {
    confidence: round3(confidence),
    evidence: { continuity: round3(continuity), steadiness: round3(steadiness), pulse: round3(pulse) }
  }
}

/**
 * How strongly the envelope repeats at a musical tempo. Autocorrelation over
 * lags matching 60–180 bpm; the best normalised peak is the score.
 */
export function pulseStrength(window: number[], secondsPerBucket: number): number {
  const mean = window.reduce((a, b) => a + b, 0) / window.length
  const centred = window.map((v) => v - mean)
  const energy = centred.reduce((sum, v) => sum + v * v, 0)
  if (energy < 1e-9) return 0

  const minLag = Math.max(2, Math.round(60 / 180 / secondsPerBucket)) // 180 bpm
  const maxLag = Math.min(window.length - 2, Math.round(60 / 60 / secondsPerBucket)) // 60 bpm
  if (maxLag <= minLag) return 0

  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i] * centred[i + lag]
    best = Math.max(best, sum / energy)
  }
  return clamp01(best)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
