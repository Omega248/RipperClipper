import { describe, expect, it } from 'vitest'
import {
  anchorsFromPairing,
  compareMappings,
  eventCoverageSummary,
  eventToLocal,
  findMomentInPovs,
  isSynced,
  localToEvent,
  mapEventRangeToPov,
  solveMapping,
  unsyncedMapping
} from '../../src/shared/sync.js'
import type { SyncAnchor, VodTimeMapping } from '../../src/shared/sync.js'

/**
 * The scenario from the specification: three players recording the same
 * NoPixel event, each starting at a different wall-clock time.
 */
const EVENT = Date.UTC(2026, 7, 17, 22, 17, 49) / 1000 // 22:17:49 real world

// Player A started 2h14m37s before the event moment.
const A_START = EVENT - 8077 // 02:14:37 into A's VOD
// Player B started earlier, so the moment is later in its VOD.
const B_START = EVENT - 8408 // 02:20:08 into B's VOD
// Player C started later, so the moment is earlier in its VOD.
const C_START = EVENT - 7062 // 01:57:42 into C's VOD

function mapping(vodId: string, start: number, over: Partial<VodTimeMapping> = {}): VodTimeMapping {
  return {
    vodId,
    vodStartRealTime: start,
    offsetSeconds: 0,
    driftRate: 0,
    confidence: 0.95,
    method: 'platform_metadata',
    anchorIds: [],
    lastValidatedAt: null,
    warnings: [],
    ...over
  }
}

let counter = 0
const makeId = (prefix: string): string => `${prefix}_${++counter}`

describe('event-time mapping', () => {
  const a = mapping('A', A_START)
  const b = mapping('B', B_START)
  const c = mapping('C', C_START)

  it('converts a POV timestamp to the real-world instant', () => {
    expect(localToEvent(a, 8077)).toBe(EVENT)
    expect(localToEvent(b, 8408)).toBe(EVENT)
    expect(localToEvent(c, 7062)).toBe(EVENT)
  })

  it('converts the real-world instant back to each POV', () => {
    expect(eventToLocal(a, EVENT)).toBe(8077)
    expect(eventToLocal(b, EVENT)).toBe(8408)
    expect(eventToLocal(c, EVENT)).toBe(7062)
  })

  it('round-trips at millisecond precision', () => {
    const t = 8077.42
    expect(eventToLocal(a, localToEvent(a, t)!)).toBeCloseTo(t, 3)
  })

  it('returns null rather than guessing when a POV is unsynced', () => {
    const u = unsyncedMapping('D')
    expect(isSynced(u)).toBe(false)
    expect(localToEvent(u, 100)).toBeNull()
    expect(eventToLocal(u, EVENT)).toBeNull()
  })

  it('applies a manual offset correction', () => {
    const corrected = mapping('B', B_START, { offsetSeconds: 3.42, method: 'manual' })
    // B's clock ran 3.42s ahead, so the event sits 3.42s earlier in its VOD.
    expect(eventToLocal(corrected, EVENT)).toBeCloseTo(8408 - 3.42, 3)
  })

  it('applies drift rather than a flat offset when drift is modelled', () => {
    const drifting = mapping('B', B_START, { driftRate: 0.0001 })
    const early = eventToLocal(drifting, localToEvent(mapping('B', B_START), 60)!)!
    const late = eventToLocal(drifting, localToEvent(mapping('B', B_START), 7200)!)!
    // Later timestamps are corrected more than earlier ones.
    expect(60 - early).toBeLessThan(7200 - late)
  })
})

describe('find the same moment in every POV', () => {
  it('returns each POV local time for one real-world instant', () => {
    const moments = findMomentInPovs(EVENT, [
      { mapping: mapping('A', A_START), durationSeconds: 20538 },
      { mapping: mapping('B', B_START), durationSeconds: 21702 },
      { mapping: mapping('C', C_START), durationSeconds: 17901 }
    ])
    expect(moments.map((m) => [m.vodId, m.localTime])).toEqual([
      ['A', 8077],
      ['B', 8408],
      ['C', 7062]
    ])
    expect(moments.every((m) => m.withinVod)).toBe(true)
  })

  it('reports a POV that was not recording at that instant', () => {
    // D started an hour after the event.
    const d = mapping('D', EVENT + 3600)
    const [moment] = findMomentInPovs(EVENT, [{ mapping: d, durationSeconds: 3600 }])
    expect(moment.localTime).toBe(-3600)
    expect(moment.withinVod).toBe(false)
  })

  it('skips unsynced POVs instead of inventing a time', () => {
    const moments = findMomentInPovs(EVENT, [
      { mapping: mapping('A', A_START), durationSeconds: 20538 },
      { mapping: unsyncedMapping('E'), durationSeconds: 100 }
    ])
    expect(moments).toHaveLength(1)
  })
})

describe('cross-POV range mapping and coverage', () => {
  const eventStart = EVENT
  const eventEnd = EVENT + 135 // 02:14:37 → 02:16:52

  it('maps an event range onto every POV', () => {
    const a = mapEventRangeToPov(mapping('A', A_START), 20538, eventStart, eventEnd)
    const b = mapEventRangeToPov(mapping('B', B_START), 21702, eventStart, eventEnd)
    const c = mapEventRangeToPov(mapping('C', C_START), 17901, eventStart, eventEnd)

    expect([a.localStart, a.localEnd]).toEqual([8077, 8212])
    expect([b.localStart, b.localEnd]).toEqual([8408, 8543])
    expect([c.localStart, c.localEnd]).toEqual([7062, 7197])
    expect([a.coverage, b.coverage, c.coverage]).toEqual(['full', 'full', 'full'])
  })

  it('reports partial coverage when a POV stops mid-event', () => {
    // This POV's recording ends 60s into the 135s event.
    const short = mapping('S', EVENT)
    const range = mapEventRangeToPov(short, 60, eventStart, eventEnd)
    expect(range.coverage).toBe('partial')
    expect(range.localStart).toBe(0)
    expect(range.localEnd).toBe(60)
    expect(range.requestedLocalEnd).toBe(135)
  })

  it('reports no coverage when the POV was not recording', () => {
    const later = mapping('L', EVENT + 7200)
    expect(mapEventRangeToPov(later, 3600, eventStart, eventEnd).coverage).toBe('none')
  })

  it('reports unknown coverage rather than guessing when unsynced', () => {
    const range = mapEventRangeToPov(unsyncedMapping('U'), 3600, eventStart, eventEnd)
    expect(range.coverage).toBe('unknown')
  })

  it('summarises coverage across POVs', () => {
    const ranges = [
      mapEventRangeToPov(mapping('A', A_START), 20538, eventStart, eventEnd),
      mapEventRangeToPov(mapping('S', EVENT), 60, eventStart, eventEnd),
      mapEventRangeToPov(mapping('L', EVENT + 7200), 3600, eventStart, eventEnd),
      mapEventRangeToPov(unsyncedMapping('U'), 3600, eventStart, eventEnd)
    ]
    expect(eventCoverageSummary(ranges)).toEqual({ full: 1, partial: 1, none: 1, unknown: 1 })
  })
})

describe('solveMapping', () => {
  it('uses platform metadata when no anchors exist', () => {
    const solved = solveMapping({
      vodId: 'A',
      durationSeconds: 20538,
      evidence: { startRealTime: A_START, method: 'platform_metadata' },
      anchors: []
    })
    expect(solved.vodStartRealTime).toBe(A_START)
    expect(solved.offsetSeconds).toBe(0)
    expect(solved.confidence).toBeGreaterThan(0.9)
    expect(solved.method).toBe('platform_metadata')
  })

  it('is honest when nothing at all is known', () => {
    const solved = solveMapping({
      vodId: 'X',
      durationSeconds: 100,
      evidence: { startRealTime: null, method: 'unsynced' },
      anchors: []
    })
    expect(isSynced(solved)).toBe(false)
    expect(solved.confidence).toBe(0)
  })

  it('derives a start time from anchors alone when metadata is missing', () => {
    const anchors: SyncAnchor[] = anchorsFromPairing(
      [{ vodId: 'Y', localTime: 500 }],
      EVENT,
      'manual',
      makeId
    )
    const solved = solveMapping({
      vodId: 'Y',
      durationSeconds: 3600,
      evidence: { startRealTime: null, method: 'unsynced' },
      anchors
    })
    expect(isSynced(solved)).toBe(true)
    expect(eventToLocal(solved, EVENT)).toBeCloseTo(500, 3)
    expect(solved.warnings.join(' ')).toMatch(/anchors only/i)
  })

  it('corrects metadata with a single anchor', () => {
    // Metadata says the VOD started 5s later than it really did.
    const anchors = anchorsFromPairing([{ vodId: 'B', localTime: 8408 }], EVENT, 'manual', makeId)
    const solved = solveMapping({
      vodId: 'B',
      durationSeconds: 21702,
      evidence: { startRealTime: B_START + 5, method: 'platform_metadata' },
      anchors
    })
    expect(eventToLocal(solved, EVENT)).toBeCloseTo(8408, 3)
    expect(solved.method).toBe('event_anchor')
  })

  it('flags an anchor that wildly contradicts platform metadata', () => {
    const anchors = anchorsFromPairing([{ vodId: 'B', localTime: 8408 }], EVENT, 'manual', makeId)
    const solved = solveMapping({
      vodId: 'B',
      durationSeconds: 21702,
      evidence: { startRealTime: B_START + 600, method: 'platform_metadata' },
      anchors
    })
    expect(solved.warnings.join(' ')).toMatch(/disagrees/i)
    expect(solved.confidence).toBeLessThanOrEqual(0.7)
  })

  it('detects and models clock drift from anchors spread over time', () => {
    // The POV's clock gains 0.6s over 3600s of footage.
    const anchors: SyncAnchor[] = [
      ...anchorsFromPairing([{ vodId: 'D', localTime: 600 }], C_START + 600 + 5.2, 'manual', makeId),
      ...anchorsFromPairing([{ vodId: 'D', localTime: 4200 }], C_START + 4200 + 5.8, 'manual', makeId)
    ]
    const solved = solveMapping({
      vodId: 'D',
      durationSeconds: 7200,
      evidence: { startRealTime: C_START, method: 'platform_metadata' },
      anchors
    })
    expect(solved.driftRate).not.toBe(0)
    expect(solved.warnings.join(' ')).toMatch(/drift/i)
    // Both anchors are honoured, not just the first.
    expect(localToEvent(solved, 600)).toBeCloseTo(C_START + 600 + 5.2, 1)
    expect(localToEvent(solved, 4200)).toBeCloseTo(C_START + 4200 + 5.8, 1)
  })

  it('does not claim drift from anchors that sit close together', () => {
    const anchors: SyncAnchor[] = [
      ...anchorsFromPairing([{ vodId: 'E', localTime: 100 }], C_START + 100 + 2, 'manual', makeId),
      ...anchorsFromPairing([{ vodId: 'E', localTime: 110 }], C_START + 110 + 2.1, 'manual', makeId)
    ]
    const solved = solveMapping({
      vodId: 'E',
      durationSeconds: 7200,
      evidence: { startRealTime: C_START, method: 'platform_metadata' },
      anchors
    })
    expect(solved.driftRate).toBe(0)
    expect(solved.offsetSeconds).toBeCloseTo(2.05, 1)
  })

  it('never discards a manual mapping when re-solving', () => {
    const manual = mapping('M', C_START, { offsetSeconds: -12.18, method: 'manual', confidence: 1 })
    const solved = solveMapping({
      vodId: 'M',
      durationSeconds: 7200,
      evidence: { startRealTime: C_START + 999, method: 'platform_metadata' },
      anchors: [],
      previous: manual
    })
    expect(solved.method).toBe('manual')
    expect(solved.offsetSeconds).toBe(-12.18)
    expect(solved.lastValidatedAt).not.toBeNull()
  })

  it('raises confidence as more agreeing anchors arrive', () => {
    const one = solveMapping({
      vodId: 'F',
      durationSeconds: 7200,
      evidence: { startRealTime: C_START, method: 'upload_metadata' },
      anchors: anchorsFromPairing([{ vodId: 'F', localTime: 100 }], C_START + 100, 'manual', makeId)
    })
    const three = solveMapping({
      vodId: 'F',
      durationSeconds: 7200,
      evidence: { startRealTime: C_START, method: 'upload_metadata' },
      anchors: [
        ...anchorsFromPairing([{ vodId: 'F', localTime: 100 }], C_START + 100, 'manual', makeId),
        ...anchorsFromPairing([{ vodId: 'F', localTime: 2000 }], C_START + 2000, 'manual', makeId),
        ...anchorsFromPairing([{ vodId: 'F', localTime: 5000 }], C_START + 5000, 'manual', makeId)
      ]
    })
    expect(three.confidence).toBeGreaterThan(one.confidence)
  })
})

describe('synchronisation must not silently move existing work', () => {
  it('flags a material change and preserves the previous mapping', () => {
    const previous = mapping('B', B_START)
    const next = mapping('B', B_START + 4)
    const change = compareMappings(previous, next, 8408)
    expect(change.material).toBe(true)
    expect(change.shiftSeconds).toBeCloseTo(4, 3)
    expect(change.previous).toBe(previous)
  })

  it('does not flag a sub-frame correction as material', () => {
    const change = compareMappings(mapping('B', B_START), mapping('B', B_START + 0.02), 8408)
    expect(change.material).toBe(false)
  })
})

describe('late-added POV inherits existing clips', () => {
  it('maps every existing clip onto a POV added afterwards', () => {
    // Five clips created while only A and B were loaded.
    const clips = [
      { name: 'MRPD Shootout', start: EVENT, end: EVENT + 135 },
      { name: 'Bank Robbery', start: EVENT + 600, end: EVENT + 780 },
      { name: 'Police Chase', start: EVENT + 1800, end: EVENT + 1900 },
      { name: 'Late One', start: EVENT + 7000, end: EVENT + 7200 },
      { name: 'Much Later', start: EVENT + 20000, end: EVENT + 20100 }
    ]

    // C is discovered later: starts 7062s before the event, records for 8000s.
    const c = solveMapping({
      vodId: 'C',
      durationSeconds: 8000,
      evidence: { startRealTime: C_START, method: 'platform_metadata' },
      anchors: []
    })

    const coverage = clips.map((clip) => ({
      name: clip.name,
      ...mapEventRangeToPov(c, 8000, clip.start, clip.end)
    }))

    expect(coverage.map((x) => [x.name, x.coverage])).toEqual([
      ['MRPD Shootout', 'full'],
      ['Bank Robbery', 'full'],
      // C's recording ends 938s after the event moment, mid-way through this clip.
      ['Police Chase', 'none'],
      ['Late One', 'none'],
      ['Much Later', 'none']
    ])
    // Nothing about the clips themselves changed — only derived ranges.
    expect(clips[0].start).toBe(EVENT)
  })

  it('produces partial coverage for a clip that straddles the end of a POV', () => {
    const c = mapping('C', C_START)
    // C records for exactly 7100s: the event starts at 7062 and runs 135s.
    const range = mapEventRangeToPov(c, 7100, EVENT, EVENT + 135)
    expect(range.coverage).toBe('partial')
    expect(range.localStart).toBe(7062)
    expect(range.localEnd).toBe(7100)
  })
})
