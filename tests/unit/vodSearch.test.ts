import { describe, expect, it } from 'vitest'
import { vodsAtTime, parseLocalDateTime } from '../../src/shared/vodSearch.js'

/**
 * "Who was live at 22:17?" is how a multi-POV event is actually assembled, so
 * this must include the POVs that were running and exclude the ones that were
 * not — without quietly dropping VODs whose length the platform never reported.
 */

const at = (iso: string): number => Date.parse(iso)

const VODS = [
  { url: 'a', title: 'Started before, still running', publishedAt: '2026-08-17T20:00:00Z', durationSeconds: 4 * 3600 },
  { url: 'b', title: 'Ended before the moment', publishedAt: '2026-08-17T18:00:00Z', durationSeconds: 3600 },
  { url: 'c', title: 'Started after the moment', publishedAt: '2026-08-17T23:00:00Z', durationSeconds: 3600 },
  { url: 'd', title: 'Unknown length', publishedAt: '2026-08-17T21:30:00Z', durationSeconds: null },
  { url: 'e', title: 'No timing at all', publishedAt: null, durationSeconds: 3600 }
]

describe('VODs live at a moment', () => {
  it('finds the broadcasts that were actually running', () => {
    const found = vodsAtTime(VODS, at('2026-08-17T22:17:00Z'))
    expect(found.map((f) => f.vod.url)).toEqual(['d', 'a'])
  })

  it('says how far into each VOD the moment falls', () => {
    const found = vodsAtTime(VODS, at('2026-08-17T22:17:00Z'))
    const a = found.find((f) => f.vod.url === 'a')!
    expect(a.offsetSeconds).toBe(2 * 3600 + 17 * 60)
    expect(a.certain).toBe(true)
  })

  it('marks a VOD of unknown length as uncertain rather than hiding it', () => {
    const found = vodsAtTime(VODS, at('2026-08-17T22:17:00Z'))
    const d = found.find((f) => f.vod.url === 'd')!
    expect(d.certain).toBe(false)
  })

  it('excludes VODs that had already finished', () => {
    const found = vodsAtTime(VODS, at('2026-08-17T22:17:00Z'))
    expect(found.some((f) => f.vod.url === 'b')).toBe(false)
  })

  it('excludes VODs that had not started', () => {
    const found = vodsAtTime(VODS, at('2026-08-17T22:17:00Z'))
    expect(found.some((f) => f.vod.url === 'c')).toBe(false)
  })

  it('ignores VODs the platform gave no start time for', () => {
    const found = vodsAtTime(VODS, at('2026-08-17T22:17:00Z'))
    expect(found.some((f) => f.vod.url === 'e')).toBe(false)
  })

  it('allows a few minutes of slack at the edges', () => {
    // Two minutes before a VOD's first frame still counts: platform start times
    // are rounded, and an event right at the top of a stream is common.
    const found = vodsAtTime(VODS, at('2026-08-17T19:58:00Z'))
    expect(found.some((f) => f.vod.url === 'a')).toBe(true)
  })

  it('reads a datetime-local value, and refuses junk', () => {
    expect(parseLocalDateTime('2026-08-17T22:17')).toBe(new Date('2026-08-17T22:17').getTime())
    expect(parseLocalDateTime('not a date')).toBeNull()
    expect(parseLocalDateTime('')).toBeNull()
  })
})
