import { describe, expect, it } from 'vitest'
import { filmstripTimes } from '../../src/renderer/src/hooks/useTimelineFilmstrip.js'

/**
 * The timeline's frames are fetched one at a time, and each one costs a
 * segment off the platform. What makes that affordable is that the sample
 * times sit on a grid: pan a little and the same times come back, so the main
 * process answers from its disk cache instead of the network. If the times
 * ever tracked the viewport exactly, every pixel of panning would be a fresh
 * download.
 */
describe('filmstrip sample times', () => {
  it('lands on a grid, so panning re-asks for what is already cached', () => {
    const a = filmstripTimes(0, 3600, 14400, 12)
    const b = filmstripTimes(60, 3600, 14400, 12)

    const shared = a.filter((t) => b.includes(t))
    expect(shared.length).toBeGreaterThanOrEqual(a.length - 1)
  })

  it('covers the whole view', () => {
    const times = filmstripTimes(1000, 1200, 14400, 10)
    expect(times[0]).toBeLessThanOrEqual(1000)
    expect(times[times.length - 1]).toBeGreaterThan(1000 + 1200 - 1200 / 10)
  })

  it('never asks past the end of the broadcast', () => {
    const times = filmstripTimes(0, 3600, 900, 12)
    for (const t of times) expect(t).toBeLessThan(900)
  })

  it('asks for nothing when there is nothing to ask about', () => {
    expect(filmstripTimes(0, 0, 3600, 12)).toEqual([])
    expect(filmstripTimes(0, 3600, 0, 12)).toEqual([])
    expect(filmstripTimes(0, 3600, 3600, 0)).toEqual([])
  })

  it('is bounded — a long broadcast does not mean a long queue', () => {
    expect(filmstripTimes(0, 40 * 3600, 40 * 3600, 24).length).toBeLessThanOrEqual(26)
  })
})
