import { describe, expect, it } from 'vitest'
import {
  addCollection,
  advanceWorkflow,
  povUsage,
  removeCollection,
  reorderCollection,
  setClipCollection,
  setClipWorkflow,
  setPovUsed,
  sortedCollections,
  unusedPovIds,
  workflowOf
} from '../../src/shared/collections.js'
import { emptyEvent } from '../../src/shared/event.js'
import type { ClipPovMapping, ClipSegment } from '../../src/shared/types.js'

/**
 * Organising an event's clips.
 *
 * The invariant under all of it: organisation is presentation. Filing,
 * re-filing or unfiling a clip must never change when it happened or which
 * POVs cover it.
 */

const mapping = (sourceId: string, status: ClipPovMapping['status']): ClipPovMapping => ({
  sourceId,
  vodStartSeconds: 0,
  vodEndSeconds: 10,
  requestedStartSeconds: 0,
  requestedEndSeconds: 10,
  status,
  confidence: 1,
  method: 'platform_metadata',
  authored: false,
  updatedAt: '2026-08-21T00:00:00Z',
  media: {
    video: { available: true, startSeconds: 0, endSeconds: 10 },
    audio: { available: true, startSeconds: 0, endSeconds: 10 }
  }
})

const clip = (over: Partial<ClipSegment> = {}): ClipSegment => ({
  id: 'clip_1',
  name: 'Bank entry',
  sourceId: 'pov_a',
  startSeconds: 0,
  endSeconds: 10,
  durationSeconds: 10,
  order: 0,
  status: 'idle',
  eventStartTime: 1000,
  eventEndTime: 1010,
  ...over
})

describe('collections', () => {
  it('adds collections in a stable, contiguous order', () => {
    let event = emptyEvent()
    event = addCollection(event, 'Approach').event
    event = addCollection(event, 'Entry').event
    expect(sortedCollections(event).map((c) => c.name)).toEqual(['Approach', 'Entry'])
    expect(sortedCollections(event).map((c) => c.order)).toEqual([0, 1])
  })

  it('refuses a blank name rather than creating an unnameable folder', () => {
    const event = addCollection(emptyEvent(), '   ')
    expect(event.event.collections).toHaveLength(0)
  })

  it('reorders and renumbers so ordering never drifts', () => {
    let event = emptyEvent()
    const a = addCollection(event, 'A')
    event = a.event
    event = addCollection(event, 'B').event
    event = addCollection(event, 'C').event
    event = reorderCollection(event, a.id, 2)
    expect(sortedCollections(event).map((c) => c.name)).toEqual(['B', 'C', 'A'])
    expect(sortedCollections(event).map((c) => c.order)).toEqual([0, 1, 2])
  })

  it('keeps the clips when a collection is deleted — a folder is not the moment', () => {
    const made = addCollection(emptyEvent(), 'Chase')
    const clips = setClipCollection([clip()], 'clip_1', made.id)
    expect(clips[0].collectionId).toBe(made.id)

    const after = removeCollection(made.event, clips, made.id)
    expect(after.event.collections).toHaveLength(0)
    expect(after.clips).toHaveLength(1)
    expect(after.clips[0].collectionId).toBeNull()
    // The moment itself is untouched.
    expect(after.clips[0].eventStartTime).toBe(1000)
  })
})

describe('workflow states', () => {
  it('treats a clip with no stored state as freshly found', () => {
    expect(workflowOf(clip())).toBe('found')
  })

  it('sets a state directly when the editor asks', () => {
    const clips = setClipWorkflow([clip()], 'clip_1', 'in-edit')
    expect(workflowOf(clips[0])).toBe('in-edit')
  })

  it('advances forwards automatically', () => {
    expect(workflowOf(advanceWorkflow(clip(), 'reviewed'))).toBe('reviewed')
  })

  it('never drags a clip backwards past what the editor already decided', () => {
    // Someone marked this ready for edit; an automatic "reviewed" must not undo that.
    const ready = clip({ workflow: 'ready-for-edit' })
    expect(workflowOf(advanceWorkflow(ready, 'reviewed'))).toBe('ready-for-edit')
  })
})

describe('used and unused POVs', () => {
  const covered = clip({
    sourceId: 'pov_a',
    povMappings: [
      mapping('pov_a', 'available'),
      mapping('pov_b', 'available'),
      mapping('pov_c', 'partial'),
      mapping('pov_d', 'out_of_range')
    ]
  })

  it('counts the authoring POV as used without anyone ticking a box', () => {
    expect(povUsage(covered, 'pov_a')).toBe('used')
  })

  it('reports a covering POV nobody chose as unused, not unavailable', () => {
    // This is the distinction the whole feature exists for.
    expect(povUsage(covered, 'pov_b')).toBe('unused')
    expect(povUsage(covered, 'pov_c')).toBe('unused')
  })

  it('reports a POV that was not recording as unavailable', () => {
    expect(povUsage(covered, 'pov_d')).toBe('unavailable')
    expect(povUsage(covered, 'pov_unknown')).toBe('unavailable')
  })

  it('counts a POV chosen for picture or sound as used', () => {
    const withVideo = clip({ ...covered, videoSourceId: 'pov_b' })
    expect(povUsage(withVideo, 'pov_b')).toBe('used')
  })

  it('marks and unmarks a POV by hand', () => {
    const marked = setPovUsed([covered], 'clip_1', 'pov_b', true)
    expect(povUsage(marked[0], 'pov_b')).toBe('used')
    const cleared = setPovUsed(marked, 'clip_1', 'pov_b', false)
    expect(povUsage(cleared[0], 'pov_b')).toBe('unused')
  })

  it('lists exactly the covering POVs nobody has considered yet', () => {
    expect(unusedPovIds(covered).sort()).toEqual(['pov_b', 'pov_c'])
  })
})
