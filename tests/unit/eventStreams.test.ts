import { describe, expect, it } from 'vitest'
import { coverageLabel, coverageOf, streamsCoveringEvent } from '../../src/shared/eventStreams.js'

/**
 * Finding the other angles of a moment.
 *
 * Everything here compares wall-clock times. Two VODs that both read "01:12:30"
 * were not in the same place at the same time, and the whole feature is wrong
 * if that is ever forgotten.
 */

const EVENT_START = Date.parse('2026-08-18T21:00:00Z') / 1000
const EVENT_END = Date.parse('2026-08-18T21:05:00Z') / 1000

const vod = (start: string, durationSeconds: number | null, url = start) => ({
  url,
  title: 'stream',
  publishedAt: start,
  durationSeconds
})

describe('does a broadcast cover the moment', () => {
  it('accepts one that started before and ended after', () => {
    const c = coverageOf(vod('2026-08-18T20:00:00Z', 3 * 3600), EVENT_START, EVENT_END)!
    expect(c.complete).toBe(true)
    expect(c.fraction).toBe(1)
    expect(c.offsetSeconds).toBe(3600)
  })

  it('rejects one that had already finished', () => {
    expect(coverageOf(vod('2026-08-18T18:00:00Z', 3600), EVENT_START, EVENT_END)).toBeNull()
  })

  it('rejects one that had not started', () => {
    expect(coverageOf(vod('2026-08-18T22:00:00Z', 3600), EVENT_START, EVENT_END)).toBeNull()
  })

  it('reports partial coverage honestly rather than rounding up', () => {
    // 20:50 → 21:03 against a 21:00 → 21:05 clip: three of five minutes.
    const c = coverageOf(vod('2026-08-18T20:50:00Z', 13 * 60), EVENT_START, EVENT_END)!
    expect(c.complete).toBe(false)
    expect(c.fraction).toBeCloseTo(3 / 5, 5)
    expect(coverageLabel(c)).toBe('Covers 60% of the clip')
  })

  it('includes a broadcast of unknown length, clearly marked', () => {
    const c = coverageOf(vod('2026-08-18T20:55:00Z', null), EVENT_START, EVENT_END)!
    expect(c.certain).toBe(false)
    expect(c.complete).toBe(false)
    expect(coverageLabel(c)).toBe('Length unknown')
  })

  it('ignores a broadcast with no start time, which proves nothing', () => {
    expect(
      coverageOf({ url: 'x', title: 'x', publishedAt: null, durationSeconds: 100 }, EVENT_START, EVENT_END)
    ).toBeNull()
  })
})

describe('the list an editor is shown', () => {
  const library = [
    {
      streamerId: 's1',
      streamerName: 'Already loaded',
      platform: 'twitch',
      vods: [vod('2026-08-18T20:00:00Z', 3 * 3600, 'loaded-url')]
    },
    {
      streamerId: 's2',
      streamerName: 'Full coverage',
      platform: 'kick',
      vods: [vod('2026-08-18T20:30:00Z', 3 * 3600, 'full-url')]
    },
    {
      streamerId: 's3',
      streamerName: 'Partial only',
      platform: 'twitch',
      vods: [vod('2026-08-18T20:50:00Z', 13 * 60, 'partial-url')]
    },
    {
      streamerId: 's4',
      streamerName: 'Was not there',
      platform: 'twitch',
      vods: [vod('2026-08-17T20:00:00Z', 3600, 'absent-url')]
    }
  ]

  const result = streamsCoveringEvent({
    eventStartSeconds: EVENT_START,
    eventEndSeconds: EVENT_END,
    library,
    loaded: new Map([['loaded-url', 'pov-1']])
  })

  it('never offers a broadcast that does not cover the moment', () => {
    expect(result.map((r) => r.streamerName)).not.toContain('Was not there')
  })

  it('marks what is already a POV instead of offering it again', () => {
    const loaded = result.find((r) => r.vod.url === 'loaded-url')!
    expect(loaded.availability).toBe('loaded')
    expect(loaded.sourceId).toBe('pov-1')
  })

  it('puts loaded angles first, then the best coverage', () => {
    expect(result.map((r) => r.streamerName)).toEqual([
      'Already loaded',
      'Full coverage',
      'Partial only'
    ])
  })
})
