import { describe, expect, it } from 'vitest'
import {
  activeAudioItemsAt,
  activeVideoItemAt,
  activeVideoLayersAt,
  addItem,
  addTrack,
  appendClip,
  computeExportSegments,
  deleteItem,
  duplicateItem,
  emptyTimeline,
  moveItem,
  patchTrack,
  pipCompositionAt,
  removeTrack,
  renameTrack,
  splitItem,
  timelineDurationSeconds,
  trimItem,
  unlinkItem
} from '@shared/timeline'
import type { AudioEdit } from '@shared/audioEdits'
import type { ClipSegment, TimelineItem } from '@shared/types'

function item(init: Partial<TimelineItem> & { trackId: string }): TimelineItem {
  return {
    id: init.id ?? 'item',
    kind: 'video',
    sourceId: 'src_a',
    sourceStartSeconds: 0,
    sourceEndSeconds: 10,
    timelineStartSeconds: 0,
    timelineEndSeconds: 10,
    ...init
  }
}

function clip(init: Partial<ClipSegment> & { id: string }): ClipSegment {
  return {
    name: init.id,
    sourceId: 'src_a',
    startSeconds: 0,
    endSeconds: 10,
    durationSeconds: 10,
    order: 0,
    status: 'idle',
    ...init
  }
}

describe('emptyTimeline', () => {
  it('starts with one video and one audio track, no items', () => {
    const t = emptyTimeline()
    expect(t.tracks.map((tr) => tr.kind)).toEqual(['video', 'audio'])
    expect(t.tracks.map((tr) => tr.name)).toEqual(['V1', 'A1'])
    expect(t.items).toEqual([])
  })
})

describe('tracks', () => {
  it('adds a new video track numbered after existing ones', () => {
    const t = addTrack(addTrack(emptyTimeline(), 'video'), 'video')
    const videoNames = t.tracks.filter((tr) => tr.kind === 'video').map((tr) => tr.name)
    expect(videoNames).toEqual(['V1', 'V2', 'V3'])
  })

  it('removes a track and every item on it', () => {
    let t = emptyTimeline()
    const v1 = t.tracks[0].id
    t = { ...t, items: [item({ id: 'a', trackId: v1 })] }
    t = removeTrack(t, v1)
    expect(t.tracks.find((tr) => tr.id === v1)).toBeUndefined()
    expect(t.items).toEqual([])
  })

  it('renames a track, ignoring a blank name', () => {
    let t = emptyTimeline()
    const v1 = t.tracks[0].id
    t = renameTrack(t, v1, 'Main POV')
    expect(t.tracks[0].name).toBe('Main POV')
    t = renameTrack(t, v1, '   ')
    expect(t.tracks[0].name).toBe('Main POV')
  })

  it('patches mute/solo/lock/hidden flags', () => {
    let t = emptyTimeline()
    const a1 = t.tracks[1].id
    t = patchTrack(t, a1, { muted: true, solo: true })
    expect(t.tracks[1].muted).toBe(true)
    expect(t.tracks[1].solo).toBe(true)
  })
})

describe('addItem / moveItem', () => {
  it('adds an item and assigns it an id', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(t, item({ trackId: t.tracks[0].id }))
    expect(timeline.items).toHaveLength(1)
    expect(timeline.items[0].id).toBe(id)
  })

  it('moves an item to a new track and position, keeping its duration', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(t, item({ trackId: t.tracks[0].id, timelineStartSeconds: 0, timelineEndSeconds: 5 }))
    const moved = moveItem(timeline, id, t.tracks[1].id, 20)
    const moved2 = moved.items[0]
    expect(moved2.trackId).toBe(t.tracks[1].id)
    expect(moved2.timelineStartSeconds).toBe(20)
    expect(moved2.timelineEndSeconds).toBe(25)
  })

  it('never moves an item before 0', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(t, item({ trackId: t.tracks[0].id }))
    const moved = moveItem(timeline, id, t.tracks[0].id, -5)
    expect(moved.items[0].timelineStartSeconds).toBe(0)
  })
})

describe('trimItem', () => {
  it('trims the start, pulling the source start forward with it', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(
      t,
      item({ trackId: t.tracks[0].id, sourceStartSeconds: 100, sourceEndSeconds: 110, timelineStartSeconds: 0, timelineEndSeconds: 10 })
    )
    const trimmed = trimItem(timeline, id, 'start', 3)
    const i = trimmed.items[0]
    expect(i.timelineStartSeconds).toBe(3)
    expect(i.sourceStartSeconds).toBe(103)
    expect(i.timelineEndSeconds).toBe(10) // unchanged
    expect(i.sourceEndSeconds).toBe(110) // unchanged
  })

  it('trims the end, pulling the source end back with it', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(
      t,
      item({ trackId: t.tracks[0].id, sourceStartSeconds: 100, sourceEndSeconds: 110, timelineStartSeconds: 0, timelineEndSeconds: 10 })
    )
    const trimmed = trimItem(timeline, id, 'end', 7)
    const i = trimmed.items[0]
    expect(i.timelineEndSeconds).toBe(7)
    expect(i.sourceEndSeconds).toBe(107)
  })

  it('never trims an item shorter than the minimum', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(t, item({ trackId: t.tracks[0].id, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    const trimmed = trimItem(timeline, id, 'start', 9.99)
    expect(trimmed.items[0].timelineEndSeconds - trimmed.items[0].timelineStartSeconds).toBeGreaterThan(0)
  })

  it('leaves the original source untouched — trimming is non-destructive', () => {
    const source: ClipSegment = clip({ id: 'c', startSeconds: 100, endSeconds: 110, durationSeconds: 10 })
    const t = emptyTimeline()
    const { timeline, id } = addItem(
      t,
      item({ trackId: t.tracks[0].id, sourceClipId: source.id, sourceStartSeconds: 100, sourceEndSeconds: 110, timelineStartSeconds: 0, timelineEndSeconds: 10 })
    )
    trimItem(timeline, id, 'start', 3)
    // the source clip object itself is never passed to trimItem and is provably unchanged
    expect(source.startSeconds).toBe(100)
    expect(source.endSeconds).toBe(110)
  })
})

describe('splitItem', () => {
  it('divides one item into two at the split point, dividing the source range to match', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(
      t,
      item({ trackId: t.tracks[0].id, sourceStartSeconds: 100, sourceEndSeconds: 110, timelineStartSeconds: 0, timelineEndSeconds: 10 })
    )
    const split = splitItem(timeline, id, 4)
    expect(split.items).toHaveLength(2)
    const [first, second] = split.items
    expect(first.timelineStartSeconds).toBe(0)
    expect(first.timelineEndSeconds).toBe(4)
    expect(first.sourceStartSeconds).toBe(100)
    expect(first.sourceEndSeconds).toBe(104)
    expect(second.timelineStartSeconds).toBe(4)
    expect(second.timelineEndSeconds).toBe(10)
    expect(second.sourceStartSeconds).toBe(104)
    expect(second.sourceEndSeconds).toBe(110)
    expect(second.id).not.toBe(first.id)
  })

  it('is a no-op when the split point is outside the item', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(t, item({ trackId: t.tracks[0].id, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    expect(splitItem(timeline, id, 0).items).toHaveLength(1)
    expect(splitItem(timeline, id, 10).items).toHaveLength(1)
    expect(splitItem(timeline, id, 15).items).toHaveLength(1)
  })

  it('does not carry the link onto either half automatically', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(
      t,
      item({ trackId: t.tracks[0].id, linkedItemId: 'other', timelineStartSeconds: 0, timelineEndSeconds: 10 })
    )
    const split = splitItem(timeline, id, 5)
    expect(split.items[1].linkedItemId).toBeUndefined()
  })
})

describe('deleteItem', () => {
  it('removes the item without ripple, leaving later items where they are', () => {
    const t = emptyTimeline()
    const track = t.tracks[0].id
    let timeline = t
    timeline = addItem(timeline, item({ id: 'a', trackId: track, timelineStartSeconds: 0, timelineEndSeconds: 5 })).timeline
    timeline = addItem(timeline, item({ id: 'b', trackId: track, timelineStartSeconds: 5, timelineEndSeconds: 10 })).timeline
    const after = deleteItem(timeline, timeline.items[0].id, false)
    expect(after.items).toHaveLength(1)
    expect(after.items[0].timelineStartSeconds).toBe(5)
  })

  it('with ripple, shifts later items on the same track left by the gap', () => {
    const t = emptyTimeline()
    const track = t.tracks[0].id
    let timeline = t
    timeline = addItem(timeline, item({ trackId: track, timelineStartSeconds: 0, timelineEndSeconds: 5 })).timeline
    timeline = addItem(timeline, item({ trackId: track, timelineStartSeconds: 5, timelineEndSeconds: 12 })).timeline
    const firstId = timeline.items[0].id
    const after = deleteItem(timeline, firstId, true)
    expect(after.items).toHaveLength(1)
    expect(after.items[0].timelineStartSeconds).toBe(0)
    expect(after.items[0].timelineEndSeconds).toBe(7)
  })

  it('ripple never shifts items on a different track', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [track0, , track1] = t.tracks.map((tr) => tr.id)
    let timeline = t
    timeline = addItem(timeline, item({ trackId: track0, timelineStartSeconds: 0, timelineEndSeconds: 5 })).timeline
    timeline = addItem(timeline, item({ trackId: track1, timelineStartSeconds: 5, timelineEndSeconds: 10 })).timeline
    const firstId = timeline.items[0].id
    const after = deleteItem(timeline, firstId, true)
    expect(after.items[0].timelineStartSeconds).toBe(5) // untouched, different track
  })
})

describe('duplicateItem', () => {
  it('places the copy immediately after the original on the same track', () => {
    const t = emptyTimeline()
    const { timeline, id } = addItem(t, item({ trackId: t.tracks[0].id, timelineStartSeconds: 2, timelineEndSeconds: 6 }))
    const dup = duplicateItem(timeline, id)
    expect(dup.timeline.items).toHaveLength(2)
    const copy = dup.timeline.items.find((i) => i.id === dup.id)!
    expect(copy.timelineStartSeconds).toBe(6)
    expect(copy.timelineEndSeconds).toBe(10)
  })
})

describe('unlinkItem', () => {
  it('clears the link on both sides', () => {
    const t = emptyTimeline()
    let timeline = t
    const a = addItem(timeline, item({ id: 'a', trackId: t.tracks[0].id, linkedItemId: 'placeholder' }))
    timeline = a.timeline
    const b = addItem(timeline, item({ id: 'b', trackId: t.tracks[1].id, kind: 'audio', linkedItemId: a.id }))
    timeline = b.timeline
    timeline = { ...timeline, items: timeline.items.map((i) => (i.id === a.id ? { ...i, linkedItemId: b.id } : i)) }
    const after = unlinkItem(timeline, a.id)
    expect(after.items.find((i) => i.id === a.id)?.linkedItemId).toBeUndefined()
    expect(after.items.find((i) => i.id === b.id)?.linkedItemId).toBeUndefined()
  })
})

describe('activeVideoItemAt', () => {
  it('returns the topmost track covering the instant', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    let timeline = t
    timeline = addItem(timeline, item({ trackId: v1, timelineStartSeconds: 0, timelineEndSeconds: 10 })).timeline
    const high = addItem(timeline, item({ trackId: v2, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = high.timeline
    expect(activeVideoItemAt(timeline, 5)?.id).toBe(high.id)
  })

  it('ignores hidden tracks', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    let timeline = patchTrack(t, v2, { hidden: true })
    const low = addItem(timeline, item({ trackId: v1, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = low.timeline
    timeline = addItem(timeline, item({ trackId: v2, timelineStartSeconds: 0, timelineEndSeconds: 10 })).timeline
    expect(activeVideoItemAt(timeline, 5)?.id).toBe(low.id)
  })

  it('returns null when nothing covers the instant', () => {
    const t = emptyTimeline()
    const timeline = addItem(t, item({ trackId: t.tracks[0].id, timelineStartSeconds: 0, timelineEndSeconds: 10 })).timeline
    expect(activeVideoItemAt(timeline, 15)).toBeNull()
  })
})

describe('activeVideoLayersAt', () => {
  it('returns every covering video item, bottom track first', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    let timeline = t
    const low = addItem(timeline, item({ trackId: v1, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = low.timeline
    const high = addItem(timeline, item({ trackId: v2, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = high.timeline
    expect(activeVideoLayersAt(timeline, 5).map((i) => i.id)).toEqual([low.id, high.id])
  })

  it('is empty when nothing covers the instant', () => {
    expect(activeVideoLayersAt(emptyTimeline(), 5)).toEqual([])
  })
})

describe('pipCompositionAt', () => {
  it('is null with nothing on screen', () => {
    expect(pipCompositionAt(emptyTimeline(), 5)).toBeNull()
  })

  it('one layer: it is the background, no inset', () => {
    const t = emptyTimeline()
    const only = addItem(t, item({ trackId: t.tracks[0].id, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    const composition = pipCompositionAt(only.timeline, 5)!
    expect(composition.background.id).toBe(only.id)
    expect(composition.inset).toBeNull()
  })

  it('two overlapping layers, neither marked pip: the topmost wins outright, same as before — no compositing', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    let timeline = t
    timeline = addItem(timeline, item({ trackId: v1, timelineStartSeconds: 0, timelineEndSeconds: 10 })).timeline
    const high = addItem(timeline, item({ trackId: v2, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = high.timeline
    const composition = pipCompositionAt(timeline, 5)!
    expect(composition.background.id).toBe(high.id)
    expect(composition.inset).toBeNull()
  })

  it('a pip-marked item over a plain one: the plain one is the background, the pip one is the inset', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    let timeline = t
    const bg = addItem(timeline, item({ trackId: v1, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = bg.timeline
    const reaction = addItem(
      timeline,
      item({ trackId: v2, timelineStartSeconds: 0, timelineEndSeconds: 10, pip: true })
    )
    timeline = reaction.timeline
    const composition = pipCompositionAt(timeline, 5)!
    expect(composition.background.id).toBe(bg.id)
    expect(composition.inset?.id).toBe(reaction.id)
  })
})

describe('activeAudioItemsAt', () => {
  it('excludes muted tracks and items', () => {
    const t = addTrack(emptyTimeline(), 'audio')
    const [, a1, a2] = t.tracks.map((tr) => tr.id)
    let timeline = patchTrack(t, a2, { muted: true })
    const x = addItem(timeline, item({ kind: 'audio', trackId: a1, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = x.timeline
    timeline = addItem(timeline, item({ kind: 'audio', trackId: a2, timelineStartSeconds: 0, timelineEndSeconds: 10 })).timeline
    const active = activeAudioItemsAt(timeline, 5)
    expect(active.map((i) => i.id)).toEqual([x.id])
  })

  it('when any audio track is soloed, only soloed tracks play', () => {
    const t = addTrack(emptyTimeline(), 'audio')
    const [, a1, a2] = t.tracks.map((tr) => tr.id)
    let timeline = patchTrack(t, a2, { solo: true })
    timeline = addItem(timeline, item({ kind: 'audio', trackId: a1, timelineStartSeconds: 0, timelineEndSeconds: 10 })).timeline
    const y = addItem(timeline, item({ kind: 'audio', trackId: a2, timelineStartSeconds: 0, timelineEndSeconds: 10 }))
    timeline = y.timeline
    const active = activeAudioItemsAt(timeline, 5)
    expect(active.map((i) => i.id)).toEqual([y.id])
  })
})

describe('timelineDurationSeconds', () => {
  it('is the latest end of any item', () => {
    const t = emptyTimeline()
    let timeline = t
    timeline = addItem(timeline, item({ trackId: t.tracks[0].id, timelineStartSeconds: 0, timelineEndSeconds: 5 })).timeline
    timeline = addItem(timeline, item({ trackId: t.tracks[1].id, kind: 'audio', timelineStartSeconds: 20, timelineEndSeconds: 30 })).timeline
    expect(timelineDurationSeconds(timeline)).toBe(30)
  })

  it('is 0 for an empty timeline', () => {
    expect(timelineDurationSeconds(emptyTimeline())).toBe(0)
  })
})

describe('appendClip', () => {
  it('places linked video and audio items back-to-back with earlier content on their tracks', () => {
    const t = emptyTimeline()
    const [v1, a1] = t.tracks.map((tr) => tr.id)
    const c = clip({
      id: 'c1',
      startSeconds: 50,
      endSeconds: 60,
      durationSeconds: 10,
      videoSourceId: 'pov_a',
      audioSourceId: 'pov_b'
    })
    const after = appendClip(t, c, { videoTrackId: v1, audioTrackId: a1 })
    expect(after.items).toHaveLength(2)
    const [video, audio] = after.items
    expect(video.kind).toBe('video')
    expect(video.sourceId).toBe('pov_a')
    expect(video.sourceClipId).toBe('c1')
    expect(audio.kind).toBe('audio')
    expect(audio.sourceId).toBe('pov_b')
    expect(video.linkedItemId).toBe(audio.id)
    expect(audio.linkedItemId).toBe(video.id)
    expect(video.timelineStartSeconds).toBe(0)
    expect(video.timelineEndSeconds).toBe(10)
  })

  it('appends after whatever is already on the target tracks', () => {
    const t = emptyTimeline()
    const [v1, a1] = t.tracks.map((tr) => tr.id)
    let timeline = addItem(t, item({ trackId: v1, timelineStartSeconds: 0, timelineEndSeconds: 7 })).timeline
    const c = clip({ id: 'c2', startSeconds: 0, endSeconds: 5, durationSeconds: 5 })
    timeline = appendClip(timeline, c, { videoTrackId: v1, audioTrackId: a1 })
    const added = timeline.items.find((i) => i.sourceClipId === 'c2')!
    expect(added.timelineStartSeconds).toBe(7)
    expect(added.timelineEndSeconds).toBe(12)
  })

  it('places only a video item when no audio track is given', () => {
    const t = emptyTimeline()
    const c = clip({ id: 'c3', startSeconds: 0, endSeconds: 4, durationSeconds: 4 })
    const after = appendClip(t, c, { videoTrackId: t.tracks[0].id })
    expect(after.items).toHaveLength(1)
    expect(after.items[0].kind).toBe('video')
  })
})

describe('computeExportSegments', () => {
  it('is empty for an empty timeline', () => {
    expect(computeExportSegments(emptyTimeline())).toEqual([])
  })

  it('one video item with no audio: one segment using the video item\'s own sound', () => {
    const t = emptyTimeline()
    const timeline = addItem(t, item({
      trackId: t.tracks[0].id, sourceId: 'pov_a', sourceStartSeconds: 100, sourceEndSeconds: 110,
      timelineStartSeconds: 0, timelineEndSeconds: 10
    })).timeline
    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      durationSeconds: 10,
      videoSourceId: 'pov_a',
      videoStartSeconds: 100,
      videoEndSeconds: 110,
      audioSourceId: null,
      audioStartSeconds: null,
      audioEndSeconds: null
    })
  })

  it('a video item plus a matching audio item: one segment with the audio POV mapped in', () => {
    const t = emptyTimeline()
    const [v1, a1] = t.tracks.map((tr) => tr.id)
    let timeline = t
    timeline = addItem(timeline, item({
      trackId: v1, sourceId: 'pov_a', sourceStartSeconds: 100, sourceEndSeconds: 110,
      timelineStartSeconds: 0, timelineEndSeconds: 10
    })).timeline
    timeline = addItem(timeline, item({
      trackId: a1, kind: 'audio', sourceId: 'pov_b', sourceStartSeconds: 500, sourceEndSeconds: 510,
      timelineStartSeconds: 0, timelineEndSeconds: 10
    })).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      videoSourceId: 'pov_a', videoStartSeconds: 100, videoEndSeconds: 110,
      audioSourceId: 'pov_b', audioStartSeconds: 500, audioEndSeconds: 510
    })
  })

  it('two sequential video items on the same track produce two segments', () => {
    const t = emptyTimeline()
    const v1 = t.tracks[0].id
    let timeline = t
    timeline = addItem(timeline, item({
      id: 'a', trackId: v1, sourceId: 'pov_a', sourceStartSeconds: 0, sourceEndSeconds: 5,
      timelineStartSeconds: 0, timelineEndSeconds: 5
    })).timeline
    timeline = addItem(timeline, item({
      id: 'b', trackId: v1, sourceId: 'pov_b', sourceStartSeconds: 200, sourceEndSeconds: 208,
      timelineStartSeconds: 5, timelineEndSeconds: 13
    })).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ videoSourceId: 'pov_a', durationSeconds: 5 })
    expect(segments[1]).toMatchObject({ videoSourceId: 'pov_b', videoStartSeconds: 200, durationSeconds: 8 })
  })

  it('a higher track wins for the overlap and splits the segment around it', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id) // v2 has the higher order
    let timeline = t
    timeline = addItem(timeline, item({
      id: 'low', trackId: v1, sourceId: 'pov_low', sourceStartSeconds: 0, sourceEndSeconds: 20,
      timelineStartSeconds: 0, timelineEndSeconds: 20
    })).timeline
    timeline = addItem(timeline, item({
      id: 'high', trackId: v2, sourceId: 'pov_high', sourceStartSeconds: 0, sourceEndSeconds: 5,
      timelineStartSeconds: 8, timelineEndSeconds: 13
    })).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toMatchObject({ videoSourceId: 'pov_low', durationSeconds: 8 })
    expect(segments[1]).toMatchObject({ videoSourceId: 'pov_high', durationSeconds: 5 })
    expect(segments[2]).toMatchObject({ videoSourceId: 'pov_low', durationSeconds: 7 })
    // The low track's source range around the gap it lost skips exactly the
    // overlap — it never claims to show what the higher track covered.
    expect(segments[0].videoEndSeconds).toBe(8)
    expect(segments[2].videoStartSeconds).toBe(13)
  })

  it('skips a gap where no video item is on top', () => {
    const t = emptyTimeline()
    const v1 = t.tracks[0].id
    let timeline = t
    timeline = addItem(timeline, item({ trackId: v1, timelineStartSeconds: 0, timelineEndSeconds: 5 })).timeline
    timeline = addItem(timeline, item({ trackId: v1, timelineStartSeconds: 10, timelineEndSeconds: 15 })).timeline
    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(2)
    expect(segments[0].durationSeconds).toBe(5)
    expect(segments[1].durationSeconds).toBe(5)
  })

  it('an audio item shorter than the video item splits the video into three segments', () => {
    const t = emptyTimeline()
    const [v1, a1] = t.tracks.map((tr) => tr.id)
    let timeline = t
    timeline = addItem(timeline, item({
      trackId: v1, sourceId: 'pov_a', sourceStartSeconds: 0, sourceEndSeconds: 20,
      timelineStartSeconds: 0, timelineEndSeconds: 20
    })).timeline
    timeline = addItem(timeline, item({
      trackId: a1, kind: 'audio', sourceId: 'pov_b', sourceStartSeconds: 0, sourceEndSeconds: 6,
      timelineStartSeconds: 7, timelineEndSeconds: 13
    })).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toMatchObject({ durationSeconds: 7, audioSourceId: null })
    expect(segments[1]).toMatchObject({ durationSeconds: 6, audioSourceId: 'pov_b' })
    expect(segments[2]).toMatchObject({ durationSeconds: 7, audioSourceId: null })
    // All three still show the same video POV, continuously.
    expect(segments[0].videoSourceId).toBe('pov_a')
    expect(segments[1].videoSourceId).toBe('pov_a')
    expect(segments[2].videoSourceId).toBe('pov_a')
    expect(segments[0].videoEndSeconds).toBe(segments[1].videoStartSeconds)
    expect(segments[1].videoEndSeconds).toBe(segments[2].videoStartSeconds)
  })

  it('clips and re-zeroes an edit that spans a segment boundary', () => {
    // A separate audio-track item takes over the sound for whatever it
    // covers — deliberately placing one is how the editor says "the sound
    // here comes from this, not from the video POV's own mic" — so to force
    // a mid-clip boundary *without* handing sound ownership to anything
    // else, the boundary comes from a second, higher video track that
    // briefly overlaps instead.
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    const edits: AudioEdit[] = [{ id: 'e1', kind: 'mute', startSeconds: 4, endSeconds: 8 }]
    let timeline = t
    timeline = addItem(timeline, item({
      trackId: v1, sourceId: 'pov_a', sourceStartSeconds: 100, sourceEndSeconds: 110,
      timelineStartSeconds: 0, timelineEndSeconds: 10, audioEdits: edits
    })).timeline
    // Momentarily on top from t=6 to t=6.001 — just enough to force a
    // boundary at t=6 without meaningfully covering any real duration.
    timeline = addItem(timeline, item({
      trackId: v2, sourceId: 'pov_b', sourceStartSeconds: 0, sourceEndSeconds: 0.001,
      timelineStartSeconds: 6, timelineEndSeconds: 6.001
    })).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(3)
    // First segment: 0-6, edit [4,8] clipped to [4,6] then re-zeroed stays [4,6].
    const firstEdits = segments[0].audioEdits
    expect(firstEdits).toHaveLength(1)
    expect(firstEdits[0].startSeconds).toBeCloseTo(4)
    expect(firstEdits[0].endSeconds).toBeCloseTo(6)
    // Third segment: 6.001-10, edit [4,8] clipped to [6.001,8], re-zeroed to ~[0,1.999].
    const thirdEdits = segments[2].audioEdits
    expect(thirdEdits).toHaveLength(1)
    expect(thirdEdits[0].startSeconds).toBeCloseTo(0, 2)
    expect(thirdEdits[0].endSeconds).toBeCloseTo(1.999, 2)
  })

  it('a pip item over the background produces one segment with a pip window, not a split', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    let timeline = t
    timeline = addItem(timeline, item({
      trackId: v1, sourceId: 'pov_main', sourceStartSeconds: 0, sourceEndSeconds: 10,
      timelineStartSeconds: 0, timelineEndSeconds: 10
    })).timeline
    timeline = addItem(timeline, item({
      trackId: v2, sourceId: 'pov_reaction', sourceStartSeconds: 50, sourceEndSeconds: 60,
      timelineStartSeconds: 0, timelineEndSeconds: 10, pip: true,
      transform: { x: 0.7, y: -0.7, scale: 0.3, rotation: 0 }
    })).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(1)
    expect(segments[0].videoSourceId).toBe('pov_main')
    expect(segments[0].pip).toBeDefined()
    expect(segments[0].pip?.sourceId).toBe('pov_reaction')
    expect(segments[0].pip?.startSeconds).toBeCloseTo(50, 3)
    expect(segments[0].pip?.endSeconds).toBeCloseTo(60, 3)
    expect(segments[0].pip?.transform).toEqual({ x: 0.7, y: -0.7, scale: 0.3, rotation: 0 })
  })

  it('a pip item only over part of the background splits into segments with and without an inset', () => {
    const t = addTrack(emptyTimeline(), 'video')
    const [v1, , v2] = t.tracks.map((tr) => tr.id)
    let timeline = t
    timeline = addItem(timeline, item({
      trackId: v1, sourceId: 'pov_main', sourceStartSeconds: 0, sourceEndSeconds: 10,
      timelineStartSeconds: 0, timelineEndSeconds: 10
    })).timeline
    timeline = addItem(timeline, item({
      trackId: v2, sourceId: 'pov_reaction', sourceStartSeconds: 0, sourceEndSeconds: 4,
      timelineStartSeconds: 3, timelineEndSeconds: 7, pip: true
    })).timeline

    const segments = computeExportSegments(timeline)
    expect(segments).toHaveLength(3)
    expect(segments[0].pip).toBeUndefined()
    expect(segments[1].pip?.sourceId).toBe('pov_reaction')
    expect(segments[2].pip).toBeUndefined()
  })
})
