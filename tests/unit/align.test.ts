import { describe, expect, it } from 'vitest'
import { alignByAudio, MIN_SCORE } from '../../src/shared/align.js'

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
