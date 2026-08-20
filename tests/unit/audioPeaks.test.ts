import { describe, expect, it } from 'vitest'
import { reduceToBuckets } from '../../src/main/media/audioPeaks.js'

/**
 * The waveform is only useful for lining POVs up if its shape is the audio's
 * shape: a peak envelope with the loudness body inside it.
 */
describe('waveform peaks', () => {
  function pcm(samples: number[]): Buffer {
    const buffer = Buffer.alloc(samples.length * 2)
    samples.forEach((s, i) => buffer.writeInt16LE(Math.round(s * 32767), i * 2))
    return buffer
  }

  it('reduces samples to peak and loudness per bucket', () => {
    // Quiet half, loud half.
    const samples = [...new Array(100).fill(0.1), ...new Array(100).fill(0.9)]
    const { peaks, rms } = reduceToBuckets(pcm(samples), 2)
    expect(peaks[0]).toBeCloseTo(0.1, 2)
    expect(peaks[1]).toBeCloseTo(0.9, 2)
    expect(rms[0]).toBeLessThan(rms[1])
  })

  it('keeps peaks above loudness — an envelope, not a duplicate', () => {
    const samples = new Array(200).fill(0).map((_, i) => (i % 20 === 0 ? 0.95 : 0.02))
    const { peaks, rms } = reduceToBuckets(pcm(samples), 4)
    for (let i = 0; i < peaks.length; i++) {
      expect(peaks[i]).toBeGreaterThanOrEqual(rms[i])
    }
    expect(Math.max(...peaks)).toBeGreaterThan(0.9)
  })

  it('survives silence and empty audio without dividing by zero', () => {
    expect(reduceToBuckets(pcm(new Array(50).fill(0)), 5).peaks.every((p) => p === 0)).toBe(true)
    const empty = reduceToBuckets(Buffer.alloc(0), 10)
    expect(empty.peaks).toHaveLength(10)
    expect(empty.rms.every((v) => v === 0)).toBe(true)
  })

  it('never returns more buckets than samples', () => {
    const { peaks } = reduceToBuckets(pcm([0.5, -0.5, 0.25]), 100)
    expect(peaks).toHaveLength(3)
  })
})
