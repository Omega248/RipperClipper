import { describe, expect, it } from 'vitest'
import {
  MAX_POV_OFFSET_SECONDS,
  bestPovFor,
  clipRangeInPov,
  nudgedPovOffset
} from '../../src/shared/povMapping.js'
import type { ClipPovRange } from '../../src/shared/povMapping.js'
import type { ClipSegment, VodSource } from '../../src/shared/types.js'

/**
 * The controls behind "full control over every POV in a clip": the per-clip
 * alignment correction, and the pick-the-best-angle shortcut.
 */

function pov(id: string, startRealTime: number | null, duration = 7200): VodSource {
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

const EPOCH = 1_800_000_000

function clip(init: Partial<ClipSegment> = {}): ClipSegment {
  return {
    id: 'clip_1',
    name: 'Insane fight',
    sourceId: 'a',
    startSeconds: 600,
    endSeconds: 700,
    durationSeconds: 100,
    order: 0,
    status: 'idle',
    eventStartTime: EPOCH + 600,
    eventEndTime: EPOCH + 700,
    ...init
  }
}

describe('nudgedPovOffset', () => {
  it('steps by the amount asked for, to the millisecond', () => {
    expect(nudgedPovOffset(0, 0.1)).toBe(0.1)
    expect(nudgedPovOffset(0.1, 0.1)).toBe(0.2) // not 0.30000000000000004
    expect(nudgedPovOffset(0.25, -1)).toBe(-0.75)
  })

  it('walks back to exactly zero rather than through it', () => {
    // Ten backward nudges from +1.0 must land on 0, not on 1e-16.
    let value = 1
    for (let i = 0; i < 10; i++) value = nudgedPovOffset(value, -0.1)
    expect(value).toBe(0)
  })

  it('refuses to become a re-mark', () => {
    // Past a couple of minutes you are no longer aligning; the cap is also
    // what stops a held-down nudge walking a POV off its own recording.
    expect(nudgedPovOffset(MAX_POV_OFFSET_SECONDS, 5)).toBe(MAX_POV_OFFSET_SECONDS)
    expect(nudgedPovOffset(-MAX_POV_OFFSET_SECONDS, -5)).toBe(-MAX_POV_OFFSET_SECONDS)
    expect(nudgedPovOffset(0, 10_000)).toBe(MAX_POV_OFFSET_SECONDS)
  })
})

describe('a per-clip correction actually moves that POV', () => {
  it('shifts only the POV it names, and only for this clip', () => {
    const a = pov('a', EPOCH)
    const b = pov('b', EPOCH)
    const plain = clip()
    const nudged = clip({ povOffsets: { b: 2.5 } })

    // The authoring POV keeps the editor's own numbers either way.
    expect(clipRangeInPov(nudged, a).localStart).toBe(plain.startSeconds)
    // B moves by exactly the correction.
    expect(clipRangeInPov(nudged, b).localStart - clipRangeInPov(plain, b).localStart).toBeCloseTo(2.5, 3)
    expect(clipRangeInPov(nudged, b).offsetSeconds).toBe(2.5)
  })

  it('reports zero for a POV nobody has corrected', () => {
    expect(clipRangeInPov(clip({ povOffsets: { b: 2.5 } }), pov('c', EPOCH)).offsetSeconds).toBe(0)
  })
})

function range(init: Partial<ClipPovRange> & { sourceId: string }): ClipPovRange {
  return {
    clipId: 'clip_1',
    vodId: init.sourceId,
    localStart: 0,
    localEnd: 100,
    requestedLocalStart: 0,
    requestedLocalEnd: 100,
    coverage: 'full',
    confidence: 0.9,
    method: 'platform_metadata',
    authored: false,
    offsetSeconds: 0,
    ...init
  }
}

describe('bestPovFor', () => {
  const a = pov('a', EPOCH)
  const b = pov('b', EPOCH)
  const c = pov('c', EPOCH)

  it('prefers a fully covered angle over a partly covered one, whatever the confidence', () => {
    const picked = bestPovFor(
      [a, b],
      [
        range({ sourceId: 'a', coverage: 'partial', confidence: 1 }),
        range({ sourceId: 'b', coverage: 'full', confidence: 0.5 })
      ]
    )
    expect(picked).toBe('b')
  })

  it('breaks a coverage tie on alignment confidence', () => {
    expect(
      bestPovFor([a, b], [range({ sourceId: 'a', confidence: 0.6 }), range({ sourceId: 'b', confidence: 0.99 })])
    ).toBe('b')
  })

  it('breaks a dead heat in favour of the angle the clip was marked in', () => {
    expect(
      bestPovFor(
        [a, b],
        [range({ sourceId: 'a' }), range({ sourceId: 'b', authored: true })]
      )
    ).toBe('b')
  })

  it('never picks an angle that does not cover the moment', () => {
    expect(
      bestPovFor([a, b], [range({ sourceId: 'a', coverage: 'none' }), range({ sourceId: 'b', coverage: 'unknown' })])
    ).toBeNull()
  })

  it('ignores a candidate with no range, and answers nothing for no candidates', () => {
    expect(bestPovFor([a, c], [range({ sourceId: 'a' })])).toBe('a')
    expect(bestPovFor([], [range({ sourceId: 'a' })])).toBeNull()
  })
})
