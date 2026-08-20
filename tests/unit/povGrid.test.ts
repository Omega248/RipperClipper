import { describe, expect, it } from 'vitest'
import { columnsFor, followerTargets } from '../../src/shared/multiPov.js'
import type { VodSource } from '../../src/shared/types.js'

/**
 * Show All has one clock. These cover the arithmetic that turns the focused
 * POV's position into everybody else's — including the POVs that were not
 * recording, which must be told so rather than seeked into nothing.
 */

function pov(id: string, startRealTime: number | null, duration = 3600): VodSource {
  return {
    id,
    platform: 'kick',
    vodId: id,
    url: `https://kick.com/${id}`,
    title: id,
    creator: id,
    durationSeconds: duration,
    playbackKind: 'hls',
    capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
    formatsInspected: true,
    syncMapping: {
      vodId: id,
      vodStartRealTime: startRealTime,
      offsetSeconds: 0,
      driftRate: 0,
      confidence: 0.95,
      method: startRealTime === null ? 'unsynced' : 'platform_metadata',
      anchorIds: [],
      lastValidatedAt: null,
      warnings: []
    }
  }
}

const A = pov('a', 1_000_000)
const B = pov('b', 1_000_060) // started a minute after A
const C = pov('c', 999_940) // started a minute before A
const UNSYNCED = pov('d', null)

describe('one playhead, every angle', () => {
  it('puts each POV at the same real-world moment in its own VOD', () => {
    const targets = followerTargets([A, B, C], A, 600)
    expect(targets.get('a')).toBe(600)
    expect(targets.get('b')).toBe(540) // B started later, so it is earlier in its VOD
    expect(targets.get('c')).toBe(660)
  })

  it('says nothing rather than guessing for a POV with no timing', () => {
    expect(followerTargets([A, UNSYNCED], A, 600).get('d')).toBeNull()
  })

  it('refuses to seek a POV that was not recording yet', () => {
    // B starts 60s after A, so A's first 30 seconds do not exist in B.
    expect(followerTargets([A, B], A, 30).get('b')).toBeNull()
  })

  it('refuses to seek past the end of a POV that stopped early', () => {
    const short = pov('short', 1_000_000, 120)
    expect(followerTargets([A, short], A, 300).get('short')).toBeNull()
    expect(followerTargets([A, short], A, 100).get('short')).toBe(100)
  })

  it('follows whichever POV is focused, not a fixed one', () => {
    const fromB = followerTargets([A, B], B, 540)
    expect(fromB.get('b')).toBe(540)
    expect(fromB.get('a')).toBe(600)
  })

  it('leaves everyone unplaceable when the focused POV has no timing', () => {
    const targets = followerTargets([UNSYNCED, A], UNSYNCED, 10)
    expect(targets.get('d')).toBe(10)
    expect(targets.get('a')).toBeNull()
  })
})

describe('grid shape', () => {
  it('grows with the number of angles', () => {
    expect(columnsFor('auto', 1)).toBe(1)
    expect(columnsFor('auto', 2)).toBe(2)
    expect(columnsFor('auto', 5)).toBe(3)
    expect(columnsFor('auto', 12)).toBe(4)
  })

  it('respects an explicit choice', () => {
    expect(columnsFor(1, 8)).toBe(1)
    expect(columnsFor(2, 8)).toBe(2)
    expect(columnsFor(4, 8)).toBe(2)
    expect(columnsFor(8, 8)).toBe(3)
  })

  it('never reserves more columns than there are angles to fill them', () => {
    // Picking "8 across" with only one other angle loaded must not leave
    // empty grid tracks next to an undersized tile.
    expect(columnsFor(8, 1)).toBe(1)
    expect(columnsFor(8, 2)).toBe(2)
    expect(columnsFor(4, 1)).toBe(1)
    expect(columnsFor(6, 2)).toBe(2)
  })
})
