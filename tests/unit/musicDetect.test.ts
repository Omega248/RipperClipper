import { describe, expect, it } from 'vitest'
import { detectMusic, scoreWindow, pulseStrength } from '../../src/shared/musicDetect.js'

/**
 * The detector must separate a steady, pulsing bed from gappy speech, and must
 * stay quiet when it has no evidence — a false "music here" leads an editor to
 * process audio that never needed it.
 */

const PER_BUCKET = 0.05 // 20 buckets a second

/** Music: continuous, level, with a beat every ~0.5s (120 bpm). */
function musicEnvelope(seconds: number): number[] {
  const buckets = Math.round(seconds / PER_BUCKET)
  return Array.from({ length: buckets }, (_, i) => {
    const beat = i % 10 === 0 ? 0.85 : 0.6
    return beat + 0.02 * Math.sin(i / 3)
  })
}

/** Speech: bursts of a word or two, then a gap. */
function speechEnvelope(seconds: number): number[] {
  const buckets = Math.round(seconds / PER_BUCKET)
  return Array.from({ length: buckets }, (_, i) => {
    const phase = i % 40
    if (phase < 12) return 0.55 + 0.3 * Math.sin(i)
    return 0.01
  })
}

describe('music detection', () => {
  it('finds a music bed and reports where it is', () => {
    const ranges = detectMusic(musicEnvelope(20), 20)
    expect(ranges.length).toBeGreaterThan(0)
    expect(ranges[0].startSeconds).toBeLessThan(5)
    expect(ranges[ranges.length - 1].endSeconds).toBeGreaterThan(15)
    expect(ranges[0].confidence).toBeGreaterThan(0.62)
  })

  it('leaves speech alone', () => {
    expect(detectMusic(speechEnvelope(20), 20)).toEqual([])
  })

  it('finds only the musical half of a mixed clip', () => {
    const envelope = [...speechEnvelope(10), ...musicEnvelope(10)]
    const ranges = detectMusic(envelope, 20)
    expect(ranges.length).toBeGreaterThan(0)
    expect(ranges[0].startSeconds).toBeGreaterThanOrEqual(8)
  })

  it('says nothing about silence', () => {
    expect(detectMusic(new Array(400).fill(0), 20)).toEqual([])
  })

  it('reports the evidence behind each range', () => {
    const [range] = detectMusic(musicEnvelope(20), 20)
    expect(range.evidence.continuity).toBeGreaterThan(0.9)
    expect(range.evidence.steadiness).toBeGreaterThan(0.5)
  })

  it('drops ranges too short to be worth acting on', () => {
    const envelope = [...speechEnvelope(10), ...musicEnvelope(2), ...speechEnvelope(10)]
    expect(detectMusic(envelope, 22, { minRangeSeconds: 3 })).toEqual([])
  })

  it('scores a steady bed higher than a gappy one', () => {
    const music = scoreWindow(musicEnvelope(4), PER_BUCKET)
    const speech = scoreWindow(speechEnvelope(4), PER_BUCKET)
    expect(music.confidence).toBeGreaterThan(speech.confidence + 0.2)
  })

  it('hears a beat and ignores a flat tone', () => {
    const beat = Array.from({ length: 80 }, (_, i) => (i % 10 === 0 ? 1 : 0.3))
    const flat = new Array(80).fill(0.5)
    expect(pulseStrength(beat, PER_BUCKET)).toBeGreaterThan(0.3)
    expect(pulseStrength(flat, PER_BUCKET)).toBe(0)
  })

  it('refuses to analyse a window too small to mean anything', () => {
    expect(detectMusic([0.5, 0.5, 0.5], 1)).toEqual([])
  })
})
