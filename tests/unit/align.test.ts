import { describe, expect, it } from 'vitest'
import { alignByAudio, buildAudioAnchors, MIN_SCORE, slideMatch } from '../../src/shared/align.js'
import type { AlignmentResult } from '../../src/shared/align.js'

/**
 * Two POVs of one event hear the same bangs at the same instant. Sliding one
 * envelope against the other must recover the offset — and must refuse to
 * answer when the audio gives no evidence, because a wrong "match" silently
 * misaligns every clip.
 */

/** A loudness envelope with bursts at the given bucket positions. */
function envelope(length: number, bursts: number[], width = 3): number[] {
  const out = new Array<number>(length).fill(0.02)
  for (const at of bursts) {
    for (let i = at; i < at + width && i < length; i++) out[i] = 0.9
  }
  return out
}

describe('aligning POVs by their audio', () => {
  it('finds a positive offset when the target lags', () => {
    const ref = envelope(200, [20, 60, 130])
    const target = envelope(200, [30, 70, 140]) // 10 buckets later
    const result = alignByAudio(ref, target, 0.05) // 50ms per bucket
    expect(result.confident).toBe(true)
    expect(result.offsetSeconds).toBeCloseTo(0.5, 2)
  })

  it('finds a negative offset when the target leads', () => {
    const ref = envelope(200, [40, 90, 150])
    const target = envelope(200, [28, 78, 138])
    const result = alignByAudio(ref, target, 0.05)
    expect(result.confident).toBe(true)
    expect(result.offsetSeconds).toBeCloseTo(-0.6, 2)
  })

  it('reports zero for audio that already lines up', () => {
    const ref = envelope(200, [20, 60, 130])
    const result = alignByAudio(ref, [...ref], 0.05)
    expect(result.offsetSeconds).toBe(0)
    expect(result.score).toBeGreaterThan(MIN_SCORE)
  })

  it('refuses to guess when one POV is silent', () => {
    const ref = envelope(200, [20, 60, 130])
    const silence = new Array<number>(200).fill(0)
    const result = alignByAudio(ref, silence, 0.05)
    expect(result.confident).toBe(false)
    expect(result.score).toBe(0)
  })

  it('refuses to guess on unrelated noise', () => {
    // Deterministic pseudo-noise: no shared structure to lock onto.
    const noise = (seed: number): number[] =>
      Array.from({ length: 300 }, (_, i) => Math.abs(Math.sin(i * seed) * 0.5) + 0.1)
    const result = alignByAudio(noise(1.7), noise(0.31), 0.05)
    expect(result.confident).toBe(false)
  })

  it('is not fooled by a repeating pattern, where several shifts fit equally', () => {
    // A metronome: every shift of one period matches just as well.
    const beat = Array.from({ length: 240 }, (_, i) => (i % 20 < 3 ? 0.9 : 0.02))
    const shifted = Array.from({ length: 240 }, (_, i) => ((i + 10) % 20 < 3 ? 0.9 : 0.02))
    const result = alignByAudio(beat, shifted, 0.05)
    expect(result.confident).toBe(false)
  })

  it('says nothing rather than something on too little audio', () => {
    expect(alignByAudio([0.1, 0.9], [0.9, 0.1], 0.05).confident).toBe(false)
    expect(alignByAudio([], [], 0.05).offsetSeconds).toBe(0)
  })
})

describe('slideMatch — finding a short probe inside a long, otherwise-untimed recording', () => {
  /**
   * A smoothed random walk — irregular from sample to sample like a real
   * loudness envelope, so every window of a long enough track is locally
   * unique. A handful of identical burst spikes (as `envelope` alone makes)
   * is the wrong fixture for "find this exact moment" tests: several
   * identical bursts are genuinely ambiguous, and a correct matcher should
   * (and does, per the tests below) refuse to guess among them. A pure sine
   * wave is the wrong fixture too — it's periodic, so nearby windows are
   * near-duplicates of each other and the "true" position isn't uniquely
   * findable either.
   */
  function mulberry32(seed: number): () => number {
    let a = seed
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function distinctiveTrack(length: number, seed = 42): number[] {
    const rand = mulberry32(seed)
    const out = new Array<number>(length)
    let v = 0.3
    for (let i = 0; i < length; i++) {
      v = v * 0.7 + rand() * 0.3
      out[i] = v
    }
    return out
  }

  it('finds the needle near the start of a much longer haystack', () => {
    const haystack = distinctiveTrack(2000)
    const trueOffset = 300
    const needle = haystack.slice(trueOffset, trueOffset + 60)
    const result = slideMatch(haystack, needle)
    expect(result.confident).toBe(true)
    expect(result.offsetBuckets).toBe(trueOffset)
  })

  it('finds the needle near the end of the haystack', () => {
    const haystack = distinctiveTrack(3000, 71)
    const trueOffset = 3000 - 65
    const needle = haystack.slice(trueOffset, trueOffset + 50)
    const result = slideMatch(haystack, needle)
    expect(result.confident).toBe(true)
    expect(result.offsetBuckets).toBe(trueOffset)
  })

  it('refuses to guess when the needle is silent', () => {
    const haystack = envelope(1000, [100, 500, 800])
    const silentNeedle = new Array<number>(40).fill(0)
    const result = slideMatch(haystack, silentNeedle)
    expect(result.confident).toBe(false)
    expect(result.score).toBe(0)
  })

  it('refuses to guess when nothing in the haystack resembles the needle', () => {
    const haystack = new Array<number>(1000).fill(0.02) // flat — nothing distinctive anywhere
    const needle = envelope(40, [10, 25])
    const result = slideMatch(haystack, needle)
    expect(result.confident).toBe(false)
  })

  it('is not fooled by several identical bursts, where every one fits equally', () => {
    const haystack = envelope(2000, [50, 90, 300, 900, 1500])
    const needle = haystack.slice(300, 360)
    const result = slideMatch(haystack, needle)
    expect(result.confident).toBe(false)
  })

  it('is not fooled by a repeating beat, where many positions fit equally', () => {
    const beat = Array.from({ length: 2000 }, (_, i) => (i % 20 < 3 ? 0.9 : 0.02))
    const needle = beat.slice(500, 540)
    const result = slideMatch(beat, needle)
    expect(result.confident).toBe(false)
  })

  it('says nothing rather than something when the needle is longer than the haystack', () => {
    const result = slideMatch(envelope(20, [5]), envelope(40, [5, 30]))
    expect(result.confident).toBe(false)
    expect(result.offsetBuckets).toBe(0)
  })
})

describe('turning a match into sync evidence', () => {
  const confident: AlignmentResult = { offsetSeconds: 0.6, score: 0.9, margin: 0.4, confident: true }
  const weak: AlignmentResult = { offsetSeconds: 0.6, score: 0.3, margin: 0.05, confident: false }

  it('refuses to turn a weak match into evidence', () => {
    expect(
      buildAudioAnchors(
        { vodId: 'A', localTime: 100 },
        { vodId: 'B', localTime: 110 },
        1_700_000_000,
        weak,
        (p) => `${p}_1`
      )
    ).toBeNull()
  })

  it('anchors both POVs at the shared instant, folding the offset into the target only', () => {
    const anchors = buildAudioAnchors(
      { vodId: 'A', localTime: 100 },
      { vodId: 'B', localTime: 110 },
      1_700_000_000,
      confident,
      (p) => `${p}_1`
    )!
    expect(anchors).toHaveLength(2)
    expect(anchors.every((a) => a.eventTime === 1_700_000_000)).toBe(true)
    expect(anchors.every((a) => a.source === 'audio_anchor')).toBe(true)
    expect(anchors.find((a) => a.vodId === 'A')?.localTime).toBe(100)
    // The target's local time shifts by the alignment's offset — the
    // reference is trusted as-is, the target's estimate gets corrected.
    expect(anchors.find((a) => a.vodId === 'B')?.localTime).toBeCloseTo(110.6, 6)
  })

  it('weighs a clean, decisive match higher than a merely-confident one', () => {
    const decisive = buildAudioAnchors(
      { vodId: 'A', localTime: 0 },
      { vodId: 'B', localTime: 0 },
      0,
      { offsetSeconds: 0, score: 0.95, margin: 0.5, confident: true },
      (p) => `${p}_1`
    )!
    const barelyConfident = buildAudioAnchors(
      { vodId: 'A', localTime: 0 },
      { vodId: 'B', localTime: 0 },
      0,
      { offsetSeconds: 0, score: MIN_SCORE, margin: 0.12, confident: true },
      (p) => `${p}_1`
    )!
    expect(decisive[0].weight).toBeGreaterThan(barelyConfident[0].weight)
  })
})
