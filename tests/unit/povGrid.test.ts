import { describe, expect, it } from 'vitest'
import {
  bestColumns,
  columnsFor,
  followerTargets,
  livePovBudget,
  firstScreenful,
  povCoverage,
  wallSelection
} from '../../src/shared/multiPov.js'
import { DEFAULT_ANGLE_CEILING, normalizeAngleCeiling } from '../../src/shared/defaults.js'
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
    capabilities: { notes: [] },
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

describe('columnsFor at scale', () => {
  it('stays roughly square past nine angles, so twenty still fit a wide stage', () => {
    expect(columnsFor('auto', 9)).toBe(3)
    expect(columnsFor('auto', 12)).toBe(4)
    expect(columnsFor('auto', 20)).toBe(5)
    expect(columnsFor('auto', 30)).toBe(6)
  })

  it('never asks for more columns than there are angles to put in them', () => {
    expect(columnsFor('auto', 1)).toBe(1)
    expect(columnsFor('auto', 2)).toBe(2)
    expect(columnsFor(8, 3)).toBe(3)
    expect(columnsFor('auto', 0)).toBe(1)
  })
})

describe('live POVs in the grid', () => {
  // The regression: every angle but the one being listened to showed
  // "Not recording at this moment" the instant the leader played past the
  // duration the platform happened to report when that POV was added.
  const live = (id: string, startRealTime: number, published: number): VodSource => ({
    ...pov(id, startRealTime, published),
    isLive: true
  })

  it('keeps every live angle playable past the duration the platform reported', () => {
    const epoch = 1_800_000_000
    // All three went live together an hour ago; each reported only a couple of
    // minutes of published recording when it was added.
    const leader = live('a', epoch, 120)
    const sources = [leader, live('b', epoch, 120), live('c', epoch, 120)]

    // The leader is an hour in — far past every follower's reported duration.
    const targets = followerTargets(sources, leader, 3600)
    expect(targets.get('a')).toBe(3600)
    expect(targets.get('b')).toBeCloseTo(3600, 0)
    expect(targets.get('c')).toBeCloseTo(3600, 0)
  })

  it('falls back to the live edge rather than claiming an angle is off air', () => {
    const epoch = 1_800_000_000
    const leader = live('a', epoch, 120)
    // Started being watched half an hour after the leader was, so its clock
    // runs behind and the mapped time comes out negative.
    const later = live('b', epoch + 1800, 120)

    // Not null: this angle is broadcasting right now, whatever the arithmetic
    // says about a clock that started at a different moment.
    expect(followerTargets([leader, later], leader, 60).get('b')).toBe(120)
    // Once the times line up it follows the leader properly again.
    expect(followerTargets([leader, later], leader, 2400).get('b')).toBeCloseTo(600, 0)
  })

  it('gives a live angle its edge even with no sync mapping at all', () => {
    // A POV loaded straight from a channel link has not been aligned against
    // anything yet, which used to read as "not recording".
    const epoch = 1_800_000_000
    const leader = live('a', epoch, 120)
    const unaligned: VodSource = { ...live('b', epoch, 90), syncMapping: undefined }

    expect(followerTargets([leader, unaligned], leader, 60).get('b')).toBe(90)
  })

  it('still bounds a finished VOD by its real length', () => {
    const epoch = 1_800_000_000
    const leader = live('a', epoch, 120)
    const finished = pov('b', epoch, 600)

    expect(followerTargets([leader, finished], leader, 300).get('b')).toBeCloseTo(300, 0)
    expect(followerTargets([leader, finished], leader, 900).get('b')).toBeNull()
  })
})

describe('livePovBudget', () => {
  it('treats 0 as no ceiling — the setting stores "no limit" as zero', () => {
    expect(livePovBudget(20, 0)).toBe(20)
    expect(livePovBudget(20, undefined)).toBe(20)
    expect(livePovBudget(20, null)).toBe(20)
  })

  it('honours a ceiling the user set for a machine that cannot take it', () => {
    expect(livePovBudget(20, 6)).toBe(6)
    expect(livePovBudget(4, 6)).toBe(4)
  })

  it('always leaves at least the focused angle playing', () => {
    expect(livePovBudget(20, 0.4)).toBe(20)
    expect(livePovBudget(20, -3)).toBe(20)
    expect(livePovBudget(20, 1)).toBe(1)
  })

  it('has nothing to play when nothing is loaded', () => {
    expect(livePovBudget(0, 6)).toBe(0)
  })
})

describe('povCoverage', () => {
  // A, B and C from above: B started a minute after A, C a minute before.
  it('lays every angle out on the focused angle\'s own ruler', () => {
    const spans = povCoverage([A, B, C], A)
    const by = new Map(spans.map((s) => [s.sourceId, s]))
    expect(by.get('a')).toMatchObject({ startSeconds: 0, endSeconds: 3600, isLeader: true })
    // B's recording begins 60s into A's and runs an hour from there.
    expect(by.get('b')?.startSeconds).toBeCloseTo(60, 3)
    expect(by.get('b')?.endSeconds).toBeCloseTo(3660, 3)
    // C started a minute earlier, so it begins before A's own zero.
    expect(by.get('c')?.startSeconds).toBeCloseTo(-60, 3)
    expect(by.get('c')?.endSeconds).toBeCloseTo(3540, 3)
  })

  it('says an angle cannot be placed rather than guessing where it goes', () => {
    const [, unsynced] = povCoverage([A, UNSYNCED], A)
    expect(unsynced).toMatchObject({ sourceId: 'd', startSeconds: null, endSeconds: null })
  })

  it('cannot place anything when the focused angle itself has no timing', () => {
    const spans = povCoverage([UNSYNCED, A], UNSYNCED)
    expect(spans[0]).toMatchObject({ isLeader: true, startSeconds: 0 })
    expect(spans[1].startSeconds).toBeNull()
  })

  it('always returns a row per angle, in the order given', () => {
    expect(povCoverage([A, B, C, UNSYNCED], A).map((s) => s.sourceId)).toEqual(['a', 'b', 'c', 'd'])
    expect(povCoverage([A, B], undefined)).toEqual([])
  })

  it('marks a broadcast still in progress', () => {
    const live = { ...B, isLive: true }
    expect(povCoverage([A, live], A)[1].isLive).toBe(true)
  })
})

describe('wallSelection', () => {
  const wall = (n: number): VodSource[] =>
    Array.from({ length: n }, (_, i) => pov(`p${i}`, 0))

  it('shows every angle and decodes up to the ceiling', () => {
    const { shown, decoding, hiddenCount } = wallSelection(wall(14), 'p0', 8)
    expect(shown).toHaveLength(14)
    expect(decoding.size).toBe(8)
    expect(hiddenCount).toBe(0)
  })

  it('gives an unticked angle no tile at all', () => {
    const sources = wall(4)
    sources[2] = { ...sources[2], hiddenInWall: true }
    const { shown, hiddenCount } = wallSelection(sources, 'p0', 8)
    expect(shown.map((s) => s.id)).toEqual(['p0', 'p1', 'p3'])
    expect(hiddenCount).toBe(1)
  })

  it('lets unticking free a decode slot for an angle that was over the ceiling', () => {
    const sources = wall(4)
    expect(wallSelection(sources, 'p0', 2).decoding.has('p3')).toBe(false)

    // Turn off the two in between: p3 now fits under the same ceiling.
    const fewer = sources.map((s) =>
      s.id === 'p1' || s.id === 'p2' ? { ...s, hiddenInWall: true } : s
    )
    const after = wallSelection(fewer, 'p0', 2)
    expect(after.shown.map((s) => s.id)).toEqual(['p0', 'p3'])
    expect(after.decoding.has('p3')).toBe(true)
  })

  it('keeps the focused angle even when it is unticked — it owns the clock', () => {
    const sources = wall(3).map((s) => ({ ...s, hiddenInWall: true }))
    const { shown, decoding } = wallSelection(sources, 'p1', 8)
    expect(shown.map((s) => s.id)).toEqual(['p1'])
    expect(decoding.has('p1')).toBe(true)
  })

  it('always decodes the focused angle, whatever its place in the list', () => {
    // p9 is tenth: with a ceiling of 4 it would never reach a slot by order.
    const { decoding } = wallSelection(wall(10), 'p9', 4)
    expect(decoding.has('p9')).toBe(true)
    expect(decoding.size).toBe(4)
  })

  it('decodes everything shown when there is no ceiling', () => {
    expect(wallSelection(wall(20), 'p0', 0).decoding.size).toBe(20)
  })

  it('has nothing to show for an empty project', () => {
    const { shown, decoding, hiddenCount } = wallSelection([], undefined, 8)
    expect(shown).toEqual([])
    expect(decoding.size).toBe(0)
    expect(hiddenCount).toBe(0)
  })
})

describe('the angle ceiling, and the sentinel it used to store', () => {
  it('folds a legacy 0 into the default rather than reading it as "no limit"', () => {
    // 0 meant "no ceiling" and was also the old default, so it is on every
    // install from before the wall had an angle picker. Nothing writes a 0 any
    // more, so anything holding one never chose it.
    expect(normalizeAngleCeiling(0)).toBe(DEFAULT_ANGLE_CEILING)
    expect(normalizeAngleCeiling(undefined)).toBe(DEFAULT_ANGLE_CEILING)
    expect(normalizeAngleCeiling(null)).toBe(DEFAULT_ANGLE_CEILING)
    expect(normalizeAngleCeiling('nonsense')).toBe(DEFAULT_ANGLE_CEILING)
    expect(normalizeAngleCeiling(-4)).toBe(DEFAULT_ANGLE_CEILING)
  })

  it('keeps a ceiling the person actually picked', () => {
    expect(normalizeAngleCeiling(4)).toBe(4)
    expect(normalizeAngleCeiling(24)).toBe(24)
    expect(normalizeAngleCeiling(8.7)).toBe(8)
  })

  it('is high by default, because past it an angle refuses rather than degrades', () => {
    // The machine's real limit is handled by the bandwidth budget and the
    // wall's own quality ladder, both of which make tiles smaller. This one
    // only ever says no, so it is a bad place to be cautious: at eight, a
    // ninth angle produced "over your angle ceiling" instead of a picture.
    expect(DEFAULT_ANGLE_CEILING).toBeGreaterThanOrEqual(16)
  })
})

describe('firstScreenful', () => {
  const wall = (n: number): VodSource[] =>
    Array.from({ length: n }, (_, i) => pov(`p${i}`, 0))

  it('leaves exactly a screenful showing', () => {
    const sources = wall(14)
    const hidden = firstScreenful(sources, 'p0', 8)
    expect(sources.length - hidden.length).toBe(8)
  })

  it('counts the focused angle against the ceiling rather than adding to it', () => {
    // p12 is thirteenth. Keeping it *and* the first eight would be nine tiles
    // under a ceiling of eight — one of them unable to decode, which is the
    // state this shortcut exists to get out of.
    const sources = wall(14)
    const hidden = new Set(firstScreenful(sources, 'p12', 8))
    expect(sources.length - hidden.size).toBe(8)
    expect(hidden.has('p12')).toBe(false)
    expect(hidden.has('p7')).toBe(true)
  })

  it('lands on a wall the ceiling actually allows', () => {
    const sources = wall(14).map((s) =>
      firstScreenful(wall(14), 'p12', 8).includes(s.id) ? { ...s, hiddenInWall: true } : s
    )
    const { shown, decoding } = wallSelection(sources, 'p12', 8)
    expect(shown).toHaveLength(8)
    expect(decoding.size).toBe(8)
  })

  it('hides nothing when everything already fits', () => {
    expect(firstScreenful(wall(5), 'p0', 8)).toEqual([])
  })
})

describe('bestColumns', () => {
  /*
   * Every tile draws a 16:9 picture inside a box the grid stretches to fill,
   * so any mismatch is letterboxing — black bars on the one surface whose job
   * is letting you see what you are cutting. Measured on a two-angle wall: the
   * picture was using 39% of the stage.
   */
  /** Picture width as a fraction of the stage width — bigger is better. */
  const pictureWidth = (count: number, columns: number, aspect: number): number => {
    const rows = Math.ceil(count / columns)
    return Math.min(1 / columns, 16 / (9 * rows * aspect))
  }

  it('never picks a shape a different column count beats', () => {
    for (const aspect of [21 / 9, 16 / 9, 16 / 10, 4 / 3, 1, 3 / 4]) {
      for (const count of [2, 3, 4, 5, 6, 8, 9, 12, 16, 20]) {
        const chosen = bestColumns(count, aspect)
        const best = pictureWidth(count, chosen, aspect)
        for (let c = 1; c <= count; c++) {
          expect(
            pictureWidth(count, c, aspect),
            `${count} angles at ${aspect.toFixed(2)}: ${c} columns beats ${chosen}`
          ).toBeLessThanOrEqual(best + 1e-9)
        }
      }
    }
  })

  it('lays two angles side by side on a wide stage and stacks them on a tall one', () => {
    expect(bestColumns(2, 21 / 9)).toBe(2)
    expect(bestColumns(2, 9 / 16)).toBe(1)
  })

  it('keeps sixteen angles square on a 16:9 stage', () => {
    expect(bestColumns(16, 16 / 9)).toBe(4)
  })

  it('survives a stage that has not been measured yet', () => {
    expect(bestColumns(4, 0)).toBe(2)
    expect(bestColumns(4, Number.NaN)).toBe(2)
    expect(bestColumns(1, 16 / 9)).toBe(1)
  })

  it('is what Automatic uses, and an explicit layout still wins', () => {
    expect(columnsFor('auto', 2, 21 / 9)).toBe(2)
    expect(columnsFor('auto', 2, 9 / 16)).toBe(1)
    // "4 across" is a shape the person chose; the stage does not override it.
    expect(columnsFor(4, 9, 9 / 16)).toBe(2)
  })
})
