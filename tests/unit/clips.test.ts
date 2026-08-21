import { describe, expect, it } from 'vitest'
import {
  addClip,
  clipsForSource,
  duplicateClip,
  makeMarker,
  markerToRange,
  normalizeOrder,
  overlappingClipIds,
  removeClip,
  reorderClips,
  updateClip
} from '../../src/shared/clips.js'
import type { ClipSegment } from '../../src/shared/types.js'

const DURATION = 6 * 3600
const SOURCE = 'twitch:123'

function seed(): ClipSegment[] {
  let clips: ClipSegment[] = []
  clips = addClip(clips, { name: 'Funny Death', sourceId: SOURCE, startSeconds: 750, endSeconds: 910 }, DURATION)
  clips = addClip(clips, { name: 'Insane Fight', sourceId: SOURCE, startSeconds: 6440, endSeconds: 6665 }, DURATION)
  clips = addClip(
    clips,
    { name: 'Final Reaction', sourceId: SOURCE, startSeconds: 11742, endSeconds: 11960 },
    DURATION
  )
  return clips
}

describe('clip management', () => {
  it('creates clips with numeric timestamps and derived duration', () => {
    const clips = seed()
    expect(clips).toHaveLength(3)
    expect(clips[0].startSeconds).toBe(750)
    expect(clips[0].durationSeconds).toBe(160)
    expect(clips.map((c) => c.order)).toEqual([0, 1, 2])
  })

  it('rejects an invalid range instead of storing it', () => {
    expect(() =>
      addClip([], { name: 'Bad', sourceId: SOURCE, startSeconds: 100, endSeconds: 50 }, DURATION)
    ).toThrow(/later than Start/)
    expect(() =>
      addClip([], { name: 'Bad', sourceId: SOURCE, startSeconds: 0, endSeconds: DURATION + 1 }, DURATION)
    ).toThrow(/VOD duration/)
  })

  it('renames without touching timestamps', () => {
    const clips = updateClip(seed(), seed()[0].id, { name: 'Renamed' }, DURATION)
    expect(clips[0].startSeconds).toBe(750)
  })

  it('recomputes duration when a boundary moves', () => {
    const base = seed()
    const clips = updateClip(base, base[0].id, { endSeconds: 800 }, DURATION)
    expect(clips[0].durationSeconds).toBe(50)
  })

  it('refuses an edit that would invert the range', () => {
    const base = seed()
    expect(() => updateClip(base, base[0].id, { endSeconds: 10 }, DURATION)).toThrow()
  })

  it('sets and clears a triage tag without touching anything else', () => {
    const base = seed()
    const tagged = updateClip(base, base[0].id, { tag: 'Highlight' }, DURATION)
    expect(tagged[0].tag).toBe('Highlight')
    expect(tagged[0].startSeconds).toBe(750)

    const cleared = updateClip(tagged, tagged[0].id, { tag: null }, DURATION)
    expect(cleared[0].tag).toBeNull()
  })

  it('duplicates with a distinct id and name', () => {
    const base = seed()
    const clips = duplicateClip(base, base[0].id)
    expect(clips).toHaveLength(4)
    const copy = clips.find((c) => c.name === 'Funny Death (copy)')
    expect(copy).toBeDefined()
    expect(copy!.id).not.toBe(base[0].id)
    expect(copy!.startSeconds).toBe(base[0].startSeconds)
    // The copy is inserted directly after the original.
    expect(clips.map((c) => c.name)).toEqual([
      'Funny Death',
      'Funny Death (copy)',
      'Insane Fight',
      'Final Reaction'
    ])
  })

  it('deletes and renumbers', () => {
    const base = seed()
    const clips = removeClip(base, base[1].id)
    expect(clips.map((c) => c.name)).toEqual(['Funny Death', 'Final Reaction'])
    expect(clips.map((c) => c.order)).toEqual([0, 1])
  })

  it('reorders arbitrarily, including non-chronologically', () => {
    const base = seed()
    const moved = reorderClips(base, 2, 0)
    expect(moved.map((c) => c.name)).toEqual(['Final Reaction', 'Funny Death', 'Insane Fight'])
    expect(moved.map((c) => c.order)).toEqual([0, 1, 2])
    // Source timestamps are untouched by reordering.
    expect(moved[0].startSeconds).toBe(11742)
  })

  it('clamps out-of-bounds reorder targets', () => {
    const base = seed()
    expect(reorderClips(base, 0, 99).map((c) => c.name)).toEqual([
      'Insane Fight',
      'Final Reaction',
      'Funny Death'
    ])
    expect(reorderClips(base, 99, 0)).toHaveLength(3)
  })

  it('keeps clips from different VODs separate', () => {
    let clips = seed()
    clips = addClip(
      clips,
      { name: 'Other VOD clip', sourceId: 'youtube:abc', startSeconds: 5, endSeconds: 25 },
      600
    )
    expect(clipsForSource(clips, SOURCE)).toHaveLength(3)
    expect(clipsForSource(clips, 'youtube:abc')).toHaveLength(1)
  })

  it('normalises orders that drifted', () => {
    const clips = seed().map((c, i) => ({ ...c, order: [5, 1, 9][i] }))
    expect(normalizeOrder(clips).map((c) => c.name)).toEqual([
      'Insane Fight',
      'Funny Death',
      'Final Reaction'
    ])
  })
})

describe('markers', () => {
  it('creates a marker with numeric time', () => {
    const marker = makeMarker({ sourceId: SOURCE, timeSeconds: 742.4204, label: 'Funny' })
    expect(marker.timeSeconds).toBe(742.42)
    expect(marker.category).toBe('other')
  })

  it('converts to a clip range clamped to the source', () => {
    const marker = makeMarker({ sourceId: SOURCE, timeSeconds: 5, label: 'Start' })
    expect(markerToRange(marker, 100)).toEqual({ startSeconds: 0, endSeconds: 20 })

    const late = makeMarker({ sourceId: SOURCE, timeSeconds: 95, label: 'End' })
    expect(markerToRange(late, 100)).toEqual({ startSeconds: 80, endSeconds: 100 })
  })
})

describe('overlappingClipIds', () => {
  it('flags two clips that cover nearly the same moment', () => {
    let clips: ClipSegment[] = []
    clips = addClip(clips, { name: 'A', sourceId: SOURCE, startSeconds: 100, endSeconds: 200 }, DURATION)
    clips = addClip(clips, { name: 'B', sourceId: SOURCE, startSeconds: 120, endSeconds: 220 }, DURATION)
    const flagged = overlappingClipIds(clips)
    expect(flagged.size).toBe(2)
    expect(flagged.has(clips[0].id)).toBe(true)
    expect(flagged.has(clips[1].id)).toBe(true)
  })

  it('leaves clips that merely touch alone', () => {
    let clips: ClipSegment[] = []
    clips = addClip(clips, { name: 'A', sourceId: SOURCE, startSeconds: 100, endSeconds: 200 }, DURATION)
    clips = addClip(clips, { name: 'B', sourceId: SOURCE, startSeconds: 190, endSeconds: 300 }, DURATION)
    expect(overlappingClipIds(clips).size).toBe(0)
  })

  it('leaves genuinely unrelated clips alone', () => {
    expect(overlappingClipIds(seed()).size).toBe(0)
  })
})
