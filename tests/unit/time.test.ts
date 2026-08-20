import { describe, expect, it } from 'vitest'
import {
  clampRange,
  formatDuration,
  formatTimecode,
  mergeRanges,
  parseTimecode,
  toFfmpegTime,
  validateRange
} from '../../src/shared/time.js'

describe('parseTimecode', () => {
  it('parses the documented formats', () => {
    expect(parseTimecode('00:00:00')).toBe(0)
    expect(parseTimecode('01:23:45')).toBe(5025)
    expect(parseTimecode('01:23:45.500')).toBe(5025.5)
    expect(parseTimecode('01:23:45,5')).toBe(5025.5)
    expect(parseTimecode('12:30')).toBe(750)
    expect(parseTimecode('42')).toBe(42)
    expect(parseTimecode('742.420')).toBe(742.42)
    expect(parseTimecode('  00:12:22.420 ')).toBe(742.42)
  })

  it('rejects nonsense without throwing', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('01:99:00')).toBeNull()
    expect(parseTimecode('00:00:99')).toBeNull()
    expect(parseTimecode('--:--:--')).toBeNull()
  })

  it('round-trips through formatTimecode', () => {
    for (const seconds of [0, 1.001, 59.999, 742.42, 5025.5, 36000.123]) {
      expect(parseTimecode(formatTimecode(seconds))).toBeCloseTo(seconds, 3)
    }
  })
})

describe('formatting', () => {
  it('formats with millisecond precision by default', () => {
    expect(formatTimecode(742.42)).toBe('00:12:22.420')
    expect(formatTimecode(910.87)).toBe('00:15:10.870')
    expect(formatTimecode(742.42, { millis: false })).toBe('00:12:22')
  })

  it('formats compact durations', () => {
    expect(formatDuration(160)).toBe('02:40')
    expect(formatDuration(3760)).toBe('1:02:40')
  })

  it('emits fixed-precision seconds for ffmpeg', () => {
    expect(toFfmpegTime(742.4204)).toBe('742.420')
    expect(toFfmpegTime(-5)).toBe('0.000')
  })
})

describe('validateRange', () => {
  const duration = 3600

  it('accepts a sane range', () => {
    expect(validateRange(10, 20, duration).ok).toBe(true)
  })

  it('requires start < end', () => {
    const result = validateRange(20, 20, duration)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/later than Start/)
  })

  it('requires start >= 0', () => {
    expect(validateRange(-1, 20, duration).ok).toBe(false)
  })

  it('requires end <= duration', () => {
    const result = validateRange(10, duration + 1, duration)
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/VOD duration/)
  })

  it('rejects a start beyond the VOD', () => {
    expect(validateRange(duration + 5, duration + 10, duration).ok).toBe(false)
  })
})

describe('clampRange', () => {
  it('keeps the length when pushed past the end', () => {
    const result = clampRange(3595, 3615, 3600)
    expect(result.endSeconds).toBe(3600)
    expect(result.endSeconds - result.startSeconds).toBeCloseTo(20, 3)
  })

  it('never returns a negative start', () => {
    expect(clampRange(-10, 5, 3600).startSeconds).toBe(0)
  })
})

describe('mergeRanges', () => {
  it('merges overlapping selections so media is not fetched twice', () => {
    const merged = mergeRanges([
      { startSeconds: 600, endSeconds: 720 },
      { startSeconds: 660, endSeconds: 780 }
    ])
    expect(merged).toEqual([{ startSeconds: 600, endSeconds: 780 }])
  })

  it('leaves disjoint selections alone', () => {
    const merged = mergeRanges([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 100, endSeconds: 110 }
    ])
    expect(merged).toHaveLength(2)
  })
})
