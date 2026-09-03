import { describe, expect, it } from 'vitest'
import {
  frameDuration,
  framesToSeconds,
  rationalTime,
  secondsToFrames,
  timecode
} from '../../src/shared/editingProject.js'

/**
 * The arithmetic every editor project is built on.
 *
 * Getting this wrong is not a visible bug at first: a timeline imports, looks
 * right, and is a few frames out by the end. NTSC rates are where it happens —
 * 29.97 is 30000/1001, and rounding it to 30 costs about a second per hour.
 */
describe('project timebase', () => {
  it('counts frames at whole rates', () => {
    expect(secondsToFrames(10, 60)).toBe(600)
    expect(secondsToFrames(1.5, 24)).toBe(36)
    expect(framesToSeconds(600, 60)).toBe(10)
  })

  it('does not drift over an hour at 29.97', () => {
    const fps = 30000 / 1001
    const anHour = 3600
    // 107,892 frames, not 108,000: the difference is the 3.6 seconds that
    // separates a synced timeline from one that ends visibly late.
    expect(secondsToFrames(anHour, fps)).toBe(107892)
    // Round-trips to within a frame, which is the most a whole number of
    // frames can promise.
    expect(Math.abs(framesToSeconds(107892, fps) - anHour)).toBeLessThan(1 / fps)
  })

  it('writes rational time Final Cut will accept', () => {
    expect(rationalTime(1, 30)).toBe('30/30s')
    expect(rationalTime(0, 30)).toBe('0/30s')
    // One second at 29.97 is 30 frames of 1001/30000s each.
    expect(rationalTime(1, 30000 / 1001)).toBe('30030/30000s')
    expect(frameDuration(30)).toBe('1/30s')
    expect(frameDuration(30000 / 1001)).toBe('1001/30000s')
    expect(frameDuration(60000 / 1001)).toBe('1001/60000s')
  })

  it('never emits a decimal in a rational', () => {
    for (const fps of [24, 25, 30, 50, 60, 24000 / 1001, 30000 / 1001, 60000 / 1001]) {
      expect(rationalTime(12.345, fps)).toMatch(/^\d+\/\d+s$/)
      expect(frameDuration(fps)).toMatch(/^\d+\/\d+s$/)
    }
  })

  it('formats timecode', () => {
    expect(timecode(0, 30)).toBe('00:00:00:00')
    expect(timecode(61.5, 30)).toBe('00:01:01:15')
    expect(timecode(3661, 25)).toBe('01:01:01:00')
  })

  it('is safe at a nonsense rate rather than looping or dividing by zero', () => {
    expect(secondsToFrames(10, 0)).toBe(0)
    expect(framesToSeconds(10, 0)).toBe(0)
    expect(timecode(10, 0)).toBe('00:00:00:00')
  })
})
