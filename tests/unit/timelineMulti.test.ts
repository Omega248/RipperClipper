import { describe, expect, it } from 'vitest'
import {
  addItem,
  addTrack,
  closeGapAt,
  deleteItems,
  emptyTimeline,
  itemsInSpan,
  moveItems,
  nudgeItems,
  reorderTrack,
  splitItemsAt,
  timelineDurationSeconds,
  withLinked
} from '@shared/timeline'
import type { EditorTimeline, TimelineItem } from '@shared/types'

/**
 * The edits that act on more than one item at a time — a group drag, a
 * blade across a selection, a picture and its sound moving together. These
 * are where a multi-track editor either behaves or quietly desynchronises
 * something, so each one is pinned down here.
 */

function timelineWith(items: Array<Partial<TimelineItem>>): EditorTimeline {
  let t = emptyTimeline()
  const video = t.tracks.find((tr) => tr.kind === 'video')!.id
  const audio = t.tracks.find((tr) => tr.kind === 'audio')!.id
  for (const init of items) {
    t = addItem(t, {
      trackId: init.kind === 'audio' ? audio : video,
      kind: 'video',
      sourceId: 'a',
      sourceStartSeconds: 0,
      sourceEndSeconds: 10,
      timelineStartSeconds: 0,
      timelineEndSeconds: 10,
      ...init
    }).timeline
  }
  return t
}

const at = (t: EditorTimeline, i: number): TimelineItem => t.items[i]

describe('withLinked', () => {
  it('brings a linked partner along', () => {
    let t = timelineWith([{}, { kind: 'audio' }])
    const [video, audio] = t.items
    t = {
      ...t,
      items: [
        { ...video, linkedItemId: audio.id },
        { ...audio, linkedItemId: video.id }
      ]
    }
    expect(withLinked(t, [video.id]).sort()).toEqual([video.id, audio.id].sort())
  })

  it('does not invent a partner that has since been deleted', () => {
    const t = timelineWith([{}])
    const only = t.items[0]
    const dangling = { ...t, items: [{ ...only, linkedItemId: 'gone' }] }
    expect(withLinked(dangling, [only.id])).toEqual([only.id])
  })

  it('ignores ids that are not on the timeline', () => {
    expect(withLinked(timelineWith([{}]), ['nope'])).toEqual([])
  })
})

describe('moveItems', () => {
  it('moves several items in one edit, keeping each duration', () => {
    const t = timelineWith([
      { timelineStartSeconds: 0, timelineEndSeconds: 10 },
      { timelineStartSeconds: 20, timelineEndSeconds: 25 }
    ])
    const moved = moveItems(t, [
      { id: at(t, 0).id, trackId: at(t, 0).trackId, timelineStartSeconds: 5 },
      { id: at(t, 1).id, trackId: at(t, 1).trackId, timelineStartSeconds: 25 }
    ])
    expect([at(moved, 0).timelineStartSeconds, at(moved, 0).timelineEndSeconds]).toEqual([5, 15])
    expect([at(moved, 1).timelineStartSeconds, at(moved, 1).timelineEndSeconds]).toEqual([25, 30])
  })

  it('never lets an item start before zero', () => {
    const t = timelineWith([{ timelineStartSeconds: 3, timelineEndSeconds: 8 }])
    const moved = moveItems(t, [{ id: at(t, 0).id, trackId: at(t, 0).trackId, timelineStartSeconds: -10 }])
    expect(at(moved, 0).timelineStartSeconds).toBe(0)
    expect(at(moved, 0).timelineEndSeconds).toBe(5)
  })

  it('changes nothing when asked to move nothing', () => {
    const t = timelineWith([{}])
    expect(moveItems(t, [])).toBe(t)
  })
})

describe('nudgeItems', () => {
  it('shifts a group without changing the spacing inside it', () => {
    const t = timelineWith([
      { timelineStartSeconds: 10, timelineEndSeconds: 20 },
      { timelineStartSeconds: 30, timelineEndSeconds: 35 }
    ])
    const ids = t.items.map((i) => i.id)
    const nudged = nudgeItems(t, ids, -4)
    expect(at(nudged, 0).timelineStartSeconds).toBe(6)
    expect(at(nudged, 1).timelineStartSeconds).toBe(26)
  })

  it('stops the whole group at zero rather than tearing it apart', () => {
    // The earliest item can only go back 2s; the later one must not go back 9.
    const t = timelineWith([
      { timelineStartSeconds: 2, timelineEndSeconds: 6 },
      { timelineStartSeconds: 30, timelineEndSeconds: 35 }
    ])
    const nudged = nudgeItems(t, t.items.map((i) => i.id), -9)
    expect(at(nudged, 0).timelineStartSeconds).toBe(0)
    expect(at(nudged, 1).timelineStartSeconds).toBe(28)
  })

  it('is a no-op for an empty selection or a zero delta', () => {
    const t = timelineWith([{}])
    expect(nudgeItems(t, [], 5)).toBe(t)
    expect(nudgeItems(t, [at(t, 0).id], 0)).toBe(t)
  })
})

describe('deleteItems', () => {
  it('removes them all', () => {
    const t = timelineWith([{}, { timelineStartSeconds: 20, timelineEndSeconds: 25 }])
    expect(deleteItems(t, t.items.map((i) => i.id)).items).toEqual([])
  })

  it('closes the gap by the total of what it removed, not just the last one', () => {
    // Two 10s items removed from the front of a track: the survivor moves
    // left by 20, not by 10. Deleting one at a time in the wrong order is
    // exactly how that goes wrong.
    const t = timelineWith([
      { timelineStartSeconds: 0, timelineEndSeconds: 10 },
      { timelineStartSeconds: 10, timelineEndSeconds: 20 },
      { timelineStartSeconds: 20, timelineEndSeconds: 30 }
    ])
    const survivor = at(t, 2).id
    const next = deleteItems(t, [at(t, 0).id, at(t, 1).id], true)
    expect(next.items).toHaveLength(1)
    expect(next.items[0].id).toBe(survivor)
    expect(next.items[0].timelineStartSeconds).toBe(0)
  })

  it('leaves positions alone without ripple', () => {
    const t = timelineWith([
      { timelineStartSeconds: 0, timelineEndSeconds: 10 },
      { timelineStartSeconds: 20, timelineEndSeconds: 30 }
    ])
    const next = deleteItems(t, [at(t, 0).id], false)
    expect(next.items[0].timelineStartSeconds).toBe(20)
  })
})

describe('splitItemsAt', () => {
  it('splits everything crossing the blade', () => {
    const t = timelineWith([{}, { kind: 'audio' }])
    const next = splitItemsAt(t, 4)
    expect(next.items).toHaveLength(4)
    expect(next.items.filter((i) => i.timelineEndSeconds === 4)).toHaveLength(2)
  })

  it('leaves a locked track alone', () => {
    let t = timelineWith([{}])
    t = { ...t, tracks: t.tracks.map((tr) => ({ ...tr, locked: tr.kind === 'video' })) }
    expect(splitItemsAt(t, 4).items).toHaveLength(1)
  })

  it('splits only the selection when given one — even on a locked track', () => {
    const t = timelineWith([{}, { kind: 'audio' }])
    const next = splitItemsAt(t, 4, [at(t, 0).id])
    expect(next.items).toHaveLength(3)
  })

  it('does nothing at a position no item spans', () => {
    const t = timelineWith([{}])
    expect(splitItemsAt(t, 40).items).toHaveLength(1)
    // An edge is not a span: splitting exactly on a boundary would make a
    // zero-length item.
    expect(splitItemsAt(t, 0).items).toHaveLength(1)
    expect(splitItemsAt(t, 10).items).toHaveLength(1)
  })
})

describe('itemsInSpan', () => {
  it('catches anything overlapping the box, not only what is inside it', () => {
    const t = timelineWith([
      { timelineStartSeconds: 0, timelineEndSeconds: 10 },
      { timelineStartSeconds: 20, timelineEndSeconds: 30 }
    ])
    const track = at(t, 0).trackId
    expect(itemsInSpan(t, 5, 6, [track])).toEqual([at(t, 0).id])
    expect(itemsInSpan(t, 0, 30, [track])).toHaveLength(2)
  })

  it('reads a box dragged right-to-left the same as one dragged left-to-right', () => {
    const t = timelineWith([{ timelineStartSeconds: 0, timelineEndSeconds: 10 }])
    const track = at(t, 0).trackId
    expect(itemsInSpan(t, 8, 2, [track])).toEqual(itemsInSpan(t, 2, 8, [track]))
  })

  it('ignores tracks the box did not touch', () => {
    const t = timelineWith([{}, { kind: 'audio' }])
    expect(itemsInSpan(t, 0, 100, [at(t, 1).trackId])).toEqual([at(t, 1).id])
  })
})

describe('closeGapAt', () => {
  it('pulls everything after the hole back against what came before', () => {
    const t = timelineWith([
      { timelineStartSeconds: 0, timelineEndSeconds: 10 },
      { timelineStartSeconds: 25, timelineEndSeconds: 30 },
      { timelineStartSeconds: 30, timelineEndSeconds: 40 }
    ])
    const next = closeGapAt(t, at(t, 0).trackId, 15)
    expect(at(next, 1).timelineStartSeconds).toBe(10)
    // Everything downstream keeps its own spacing.
    expect(at(next, 2).timelineStartSeconds).toBe(15)
    expect(timelineDurationSeconds(next)).toBe(25)
  })

  it('closes a hole at the very start too', () => {
    const t = timelineWith([{ timelineStartSeconds: 8, timelineEndSeconds: 18 }])
    expect(at(closeGapAt(t, at(t, 0).trackId, 2), 0).timelineStartSeconds).toBe(0)
  })

  it('does nothing where there is no gap', () => {
    const t = timelineWith([
      { timelineStartSeconds: 0, timelineEndSeconds: 10 },
      { timelineStartSeconds: 10, timelineEndSeconds: 20 }
    ])
    expect(closeGapAt(t, at(t, 0).trackId, 5)).toBe(t)
    // Past the last item there is nothing to pull.
    expect(closeGapAt(t, at(t, 0).trackId, 50)).toBe(t)
  })
})

describe('reorderTrack', () => {
  it('swaps a track with its neighbour of the same kind', () => {
    let t = emptyTimeline()
    t = addTrack(t, 'video')
    const [v1, v2] = t.tracks.filter((tr) => tr.kind === 'video')
    const next = reorderTrack(t, v1.id, 'up')
    const after = new Map(next.tracks.map((tr) => [tr.id, tr.order]))
    expect(after.get(v1.id)).toBe(v2.order)
    expect(after.get(v2.id)).toBe(v1.order)
  })

  it('never pushes a track past the ends of its own stack', () => {
    const t = emptyTimeline()
    const video = t.tracks.find((tr) => tr.kind === 'video')!
    expect(reorderTrack(t, video.id, 'up')).toBe(t)
    expect(reorderTrack(t, video.id, 'down')).toBe(t)
  })

  it('never swaps a video track with an audio one', () => {
    let t = emptyTimeline()
    t = addTrack(t, 'audio')
    const video = t.tracks.find((tr) => tr.kind === 'video')!
    expect(reorderTrack(t, video.id, 'up')).toBe(t)
  })
})
