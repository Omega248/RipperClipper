import { createId } from './clips.js'
import type { AudioEdit } from './audioEdits.js'
import type {
  ClipSegment,
  EditorTimeline,
  TimelineItem,
  TimelineItemKind,
  TimelineMarker,
  TimelineTrack,
  TimelineTransform
} from './types.js'
import type { WatermarkConfig } from './watermark.js'

/**
 * Pure operations on the Editor's multi-track timeline.
 *
 * Every function takes a timeline and returns a new one — no mutation, no
 * IO — so the renderer store and any future headless caller (export,
 * testing) share one definition of what each edit actually does.
 *
 * Linking (a POV's picture and sound arriving as one paired video+audio
 * item) is deliberately NOT auto-followed inside these functions. Each one
 * acts on exactly the item id it's given. A caller that wants "move the
 * audio with the video" calls the same operation twice, once per linked id
 * — that keeps each function's behaviour simple and total, instead of a
 * combinatorial set of link-cascade rules buried in here.
 */

const MIN_ITEM_SECONDS = 0.1

export function emptyTimeline(): EditorTimeline {
  return {
    tracks: [
      { id: createId('track'), kind: 'video', name: 'V1', order: 0 },
      { id: createId('track'), kind: 'audio', name: 'A1', order: 0 }
    ],
    items: [],
    markers: []
  }
}

// --------------------------------------------------------------- tracks ---

export function addTrack(timeline: EditorTimeline, kind: TimelineItemKind): EditorTimeline {
  const ofKind = timeline.tracks.filter((t) => t.kind === kind)
  const order = ofKind.length === 0 ? 0 : Math.max(...ofKind.map((t) => t.order)) + 1
  const prefix = kind === 'video' ? 'V' : 'A'
  const track: TimelineTrack = { id: createId('track'), kind, name: `${prefix}${order + 1}`, order }
  return { ...timeline, tracks: [...timeline.tracks, track] }
}

/** Removes the track and every item on it. */
export function removeTrack(timeline: EditorTimeline, trackId: string): EditorTimeline {
  return {
    ...timeline,
    tracks: timeline.tracks.filter((t) => t.id !== trackId),
    items: timeline.items.filter((i) => i.trackId !== trackId)
  }
}

export function renameTrack(timeline: EditorTimeline, trackId: string, name: string): EditorTimeline {
  const trimmed = name.trim()
  if (trimmed === '') return timeline
  return { ...timeline, tracks: timeline.tracks.map((t) => (t.id === trackId ? { ...t, name: trimmed } : t)) }
}

export function patchTrack(
  timeline: EditorTimeline,
  trackId: string,
  patch: Partial<Pick<TimelineTrack, 'locked' | 'hidden' | 'muted' | 'solo'>>
): EditorTimeline {
  return { ...timeline, tracks: timeline.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) }
}

// ---------------------------------------------------------------- items ---

export function addItem(
  timeline: EditorTimeline,
  init: Omit<TimelineItem, 'id'>
): { timeline: EditorTimeline; id: string } {
  const item: TimelineItem = { ...init, id: createId('titem') }
  return { timeline: { ...timeline, items: [...timeline.items, item] }, id: item.id }
}

/** Moves an item to a (possibly different) track, keeping its duration. */
export function moveItem(
  timeline: EditorTimeline,
  itemId: string,
  trackId: string,
  timelineStartSeconds: number
): EditorTimeline {
  return {
    ...timeline,
    items: timeline.items.map((item) => {
      if (item.id !== itemId) return item
      const duration = item.timelineEndSeconds - item.timelineStartSeconds
      const start = Math.max(0, timelineStartSeconds)
      return { ...item, trackId, timelineStartSeconds: start, timelineEndSeconds: start + duration }
    })
  }
}

/**
 * Trims one edge of an item. The timeline boundary and the source boundary
 * move together — shortening the timeline end by two seconds shows two
 * fewer seconds of the source, not the same source sped up or stretched.
 */
export function trimItem(
  timeline: EditorTimeline,
  itemId: string,
  side: 'start' | 'end',
  newTimelineBoundarySeconds: number
): EditorTimeline {
  return {
    ...timeline,
    items: timeline.items.map((item) => {
      if (item.id !== itemId) return item
      const speed = item.speed ?? 1
      if (side === 'start') {
        const maxStart = item.timelineEndSeconds - MIN_ITEM_SECONDS
        const nextStart = Math.max(0, Math.min(maxStart, newTimelineBoundarySeconds))
        const deltaSeconds = (nextStart - item.timelineStartSeconds) * speed
        return {
          ...item,
          timelineStartSeconds: nextStart,
          sourceStartSeconds: Math.max(0, item.sourceStartSeconds + deltaSeconds)
        }
      }
      const minEnd = item.timelineStartSeconds + MIN_ITEM_SECONDS
      const nextEnd = Math.max(minEnd, newTimelineBoundarySeconds)
      const deltaSeconds = (nextEnd - item.timelineEndSeconds) * speed
      return {
        ...item,
        timelineEndSeconds: nextEnd,
        sourceEndSeconds: item.sourceEndSeconds + deltaSeconds
      }
    })
  }
}

/**
 * Divides one item into two at a timeline position, splitting its source
 * range at the equivalent point. A split outside the item's own span is a
 * no-op — there is nothing there to divide.
 */
export function splitItem(timeline: EditorTimeline, itemId: string, atTimelineSeconds: number): EditorTimeline {
  const item = timeline.items.find((i) => i.id === itemId)
  if (!item) return timeline
  if (atTimelineSeconds <= item.timelineStartSeconds + MIN_ITEM_SECONDS) return timeline
  if (atTimelineSeconds >= item.timelineEndSeconds - MIN_ITEM_SECONDS) return timeline

  const speed = item.speed ?? 1
  const sourceSplit = item.sourceStartSeconds + (atTimelineSeconds - item.timelineStartSeconds) * speed

  const first: TimelineItem = { ...item, timelineEndSeconds: atTimelineSeconds, sourceEndSeconds: sourceSplit }
  const second: TimelineItem = {
    ...item,
    id: createId('titem'),
    timelineStartSeconds: atTimelineSeconds,
    sourceStartSeconds: sourceSplit,
    // A split item's own linked partner (if any) would need splitting too,
    // which the caller does explicitly — this half doesn't claim a link the
    // other side doesn't know about yet.
    linkedItemId: undefined
  }

  return {
    ...timeline,
    items: timeline.items.flatMap((i) => (i.id === itemId ? [first, second] : [i]))
  }
}

export function deleteItem(timeline: EditorTimeline, itemId: string, ripple = false): EditorTimeline {
  const item = timeline.items.find((i) => i.id === itemId)
  if (!item) return timeline
  const duration = item.timelineEndSeconds - item.timelineStartSeconds
  const rest = timeline.items.filter((i) => i.id !== itemId)
  if (!ripple) return { ...timeline, items: rest }

  return {
    ...timeline,
    items: rest.map((i) =>
      i.trackId === item.trackId && i.timelineStartSeconds >= item.timelineEndSeconds - 0.001
        ? {
            ...i,
            timelineStartSeconds: i.timelineStartSeconds - duration,
            timelineEndSeconds: i.timelineEndSeconds - duration
          }
        : i
    )
  }
}

export function duplicateItem(
  timeline: EditorTimeline,
  itemId: string
): { timeline: EditorTimeline; id: string } {
  const item = timeline.items.find((i) => i.id === itemId)
  if (!item) return { timeline, id: itemId }
  const duration = item.timelineEndSeconds - item.timelineStartSeconds
  const copy: TimelineItem = {
    ...item,
    id: createId('titem'),
    timelineStartSeconds: item.timelineEndSeconds,
    timelineEndSeconds: item.timelineEndSeconds + duration,
    linkedItemId: undefined
  }
  return { timeline: { ...timeline, items: [...timeline.items, copy] }, id: copy.id }
}

export function patchItem(timeline: EditorTimeline, itemId: string, patch: Partial<TimelineItem>): EditorTimeline {
  return { ...timeline, items: timeline.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }
}

export function unlinkItem(timeline: EditorTimeline, itemId: string): EditorTimeline {
  const item = timeline.items.find((i) => i.id === itemId)
  const partnerId = item?.linkedItemId
  return {
    ...timeline,
    items: timeline.items.map((i) =>
      i.id === itemId || i.id === partnerId ? { ...i, linkedItemId: undefined } : i
    )
  }
}

// -------------------------------------------------------------- markers ---

export function addMarker(
  timeline: EditorTimeline,
  init: { timeSeconds: number; name: string; note?: string }
): { timeline: EditorTimeline; id: string } {
  const marker: TimelineMarker = {
    id: createId('marker'),
    timeSeconds: Math.max(0, init.timeSeconds),
    name: init.name,
    note: init.note
  }
  return { timeline: { ...timeline, markers: [...timeline.markers, marker] }, id: marker.id }
}

export function removeMarker(timeline: EditorTimeline, markerId: string): EditorTimeline {
  return { ...timeline, markers: timeline.markers.filter((m) => m.id !== markerId) }
}

export function patchMarker(
  timeline: EditorTimeline,
  markerId: string,
  patch: Partial<Pick<TimelineMarker, 'name' | 'note' | 'timeSeconds'>>
): EditorTimeline {
  return {
    ...timeline,
    markers: timeline.markers.map((m) => (m.id === markerId ? { ...m, ...patch } : m))
  }
}

// -------------------------------------------------------------- queries ---

/**
 * Which video item is on screen at a given timeline second: the topmost
 * (highest track order) item on a visible, non-hidden track that covers the
 * instant. Overlapping lower tracks are there for later compositing work —
 * for now, exactly one POV is ever "the picture" at any moment, which is
 * what the sequential multi-POV cut this app exists for actually needs.
 */
export function activeVideoItemAt(timeline: EditorTimeline, seconds: number): TimelineItem | null {
  const visibleTrackIds = new Set(
    timeline.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
  )
  const trackOrder = new Map(timeline.tracks.map((t) => [t.id, t.order]))
  const covering = timeline.items.filter(
    (i) =>
      i.kind === 'video' &&
      visibleTrackIds.has(i.trackId) &&
      seconds >= i.timelineStartSeconds &&
      seconds < i.timelineEndSeconds
  )
  if (covering.length === 0) return null
  return covering.reduce((top, item) =>
    (trackOrder.get(item.trackId) ?? 0) > (trackOrder.get(top.trackId) ?? 0) ? item : top
  )
}

/** Every video item covering a moment, bottom track first. */
export function activeVideoLayersAt(timeline: EditorTimeline, seconds: number): TimelineItem[] {
  const visibleTrackIds = new Set(
    timeline.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
  )
  const trackOrder = new Map(timeline.tracks.map((t) => [t.id, t.order]))
  return timeline.items
    .filter(
      (i) =>
        i.kind === 'video' &&
        visibleTrackIds.has(i.trackId) &&
        seconds >= i.timelineStartSeconds &&
        seconds < i.timelineEndSeconds
    )
    .sort((a, b) => (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0))
}

/**
 * What's actually on screen at a moment: a background (the lowest video
 * layer not itself marked `pip`, or just the bottom layer if every one of
 * them is) and, at most, one inset — the topmost layer marked `pip` above
 * it. Everything else that happens to overlap is neither shown nor hidden
 * by this on purpose: only an explicit `pip` flag turns an overlap into a
 * composite, so an accidental drag-over on the timeline never silently
 * starts compositing two POVs together.
 */
/**
 * A reasonable corner inset for a video item that's just had `pip` turned
 * on but has no transform of its own yet (or an identity one, which would
 * otherwise cover the whole background — nonsensical for a "picture in
 * picture"). Bottom-right, a bit under a third of the frame. The Inspector
 * applies this the moment `pip` is switched on, so its sliders always
 * reflect where the inset actually renders; the export filter graph
 * (main/media/pipFilter.ts) falls back to the same constant defensively,
 * for a `pip` item that somehow still carries no meaningful transform.
 */
export const DEFAULT_PIP_TRANSFORM: TimelineTransform = { x: 0.62, y: 0.62, scale: 0.28, rotation: 0 }

const IDENTITY_TRANSFORM: TimelineTransform = { x: 0, y: 0, scale: 1, rotation: 0 }

/** True for "no transform at all" or one that's a no-op — used by both the export filter graph and the Inspector. */
export function isIdentityTransform(transform: TimelineTransform | undefined | null): boolean {
  const t = transform ?? IDENTITY_TRANSFORM
  return t.x === 0 && t.y === 0 && t.scale === 1 && t.rotation % 360 === 0
}

export function pipCompositionAt(
  timeline: EditorTimeline,
  seconds: number
): { background: TimelineItem; inset: TimelineItem | null } | null {
  const layers = activeVideoLayersAt(timeline, seconds) // bottom track first
  if (layers.length === 0) return null
  const nonPip = layers.filter((l) => !l.pip)
  // Topmost non-pip layer wins the background, same "topmost wins" rule as
  // before — a pip item never displaces what would otherwise be showing.
  const background = nonPip.length > 0 ? nonPip[nonPip.length - 1] : layers[layers.length - 1]
  const insetCandidates = layers.filter((l) => l.pip && l.id !== background.id)
  const inset = insetCandidates.length > 0 ? insetCandidates[insetCandidates.length - 1] : null
  return { background, inset }
}

/** Every audio item sounding at a given timeline second, respecting mute/solo. */
export function activeAudioItemsAt(timeline: EditorTimeline, seconds: number): TimelineItem[] {
  const audioTracks = timeline.tracks.filter((t) => t.kind === 'audio')
  const soloed = audioTracks.filter((t) => t.solo)
  const audibleTrackIds = new Set(
    (soloed.length > 0 ? soloed : audioTracks).filter((t) => !t.muted).map((t) => t.id)
  )
  return timeline.items.filter(
    (i) =>
      i.kind === 'audio' &&
      !i.muted &&
      audibleTrackIds.has(i.trackId) &&
      seconds >= i.timelineStartSeconds &&
      seconds < i.timelineEndSeconds
  )
}

export function timelineDurationSeconds(timeline: EditorTimeline): number {
  return timeline.items.reduce((max, item) => Math.max(max, item.timelineEndSeconds), 0)
}

/**
 * One stretch of the assembled sequence where exactly one video item and, at
 * most, one audio item are active — the unit the export pipeline renders one
 * real cut per. `audioSourceId: null` means "use the video item's own
 * sound", the same as a clip with no separate audio POV.
 */
export interface ExportSegment {
  durationSeconds: number
  videoSourceId: string
  videoSourceClipId?: string
  videoStartSeconds: number
  videoEndSeconds: number
  audioSourceId: string | null
  audioStartSeconds: number | null
  audioEndSeconds: number | null
  /** Clip-relative (0 = this segment's own start) mute/bleep/duck ranges. */
  audioEdits: AudioEdit[]
  /** The audio item's own volume, when a separate audio-track item supplies the sound. 1 = unchanged. */
  audioGain?: number
  /** The video item's own transform and opacity, unchanged across the segment. */
  transform?: TimelineTransform
  opacity?: number
  /** Absent inherits the POV's saved watermark; 'none' disables it for this segment only. */
  watermarkOverride?: WatermarkConfig | 'none'
  /** A second POV composited as an inset over this segment's picture, when one was placed on a `pip` item. */
  pip?: {
    sourceId: string
    sourceClipId?: string
    startSeconds: number
    endSeconds: number
    transform?: TimelineTransform
  }
}

/** The higher-order track wins when more than one item of a kind is active. */
function topmostByTrackOrder(timeline: EditorTimeline, items: TimelineItem[]): TimelineItem | null {
  if (items.length === 0) return null
  const order = new Map(timeline.tracks.map((t) => [t.id, t.order]))
  return items.reduce((top, item) => ((order.get(item.trackId) ?? 0) > (order.get(top.trackId) ?? 0) ? item : top))
}

/**
 * Edits stored on an item are in that item's own local time (0 is the
 * item's `sourceStartSeconds`). A segment only ever covers part of an item,
 * so its edits need clipping to the segment's own span and re-zeroing to the
 * segment's own start — exactly what a clip-relative edit list requires.
 */
function editsForWindow(edits: AudioEdit[] | undefined, windowStart: number, windowEnd: number): AudioEdit[] {
  if (!edits || edits.length === 0) return []
  return edits
    .filter((e) => e.endSeconds > windowStart && e.startSeconds < windowEnd)
    .map((e) => ({
      ...e,
      startSeconds: Math.max(0, e.startSeconds - windowStart),
      endSeconds: Math.min(windowEnd - windowStart, e.endSeconds - windowStart)
    }))
}

/**
 * Breaks the whole timeline into segments the export pipeline can render one
 * real cut per — every point where the active video item, the active
 * audio item, or the pip composition changes is a new segment. A stretch
 * with no video item on top is a gap: nothing is rendered there, the same
 * way a clip that never got made simply isn't in the output. Mixing more
 * than one simultaneous audio item is still out of scope — the topmost
 * audio item wins — but picture-in-picture is not: a video item marked
 * `pip` that overlaps the background layer is exported as a real
 * compositied inset, not just hidden underneath.
 */
export function computeExportSegments(timeline: EditorTimeline): ExportSegment[] {
  const boundaries = new Set<number>()
  for (const item of timeline.items) {
    boundaries.add(item.timelineStartSeconds)
    boundaries.add(item.timelineEndSeconds)
  }
  const sorted = [...boundaries].sort((a, b) => a - b)

  const segments: ExportSegment[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]
    const end = sorted[i + 1]
    if (end - start < 0.001) continue
    const mid = (start + end) / 2

    const composition = pipCompositionAt(timeline, mid)
    if (!composition) continue
    const video = composition.background
    const audio = topmostByTrackOrder(timeline, activeAudioItemsAt(timeline, mid))

    const videoWindowStart = start - video.timelineStartSeconds
    const videoWindowEnd = end - video.timelineStartSeconds

    const segment: ExportSegment = {
      durationSeconds: end - start,
      videoSourceId: video.sourceId,
      videoSourceClipId: video.sourceClipId,
      videoStartSeconds: video.sourceStartSeconds + videoWindowStart,
      videoEndSeconds: video.sourceStartSeconds + videoWindowEnd,
      audioSourceId: null,
      audioStartSeconds: null,
      audioEndSeconds: null,
      audioEdits: editsForWindow(video.audioEdits, videoWindowStart, videoWindowEnd),
      transform: video.transform,
      opacity: video.opacity,
      watermarkOverride: video.watermarkOverride
    }

    if (composition.inset) {
      const inset = composition.inset
      const insetWindowStart = start - inset.timelineStartSeconds
      const insetWindowEnd = end - inset.timelineStartSeconds
      segment.pip = {
        sourceId: inset.sourceId,
        sourceClipId: inset.sourceClipId,
        startSeconds: inset.sourceStartSeconds + insetWindowStart,
        endSeconds: inset.sourceStartSeconds + insetWindowEnd,
        transform: inset.transform
      }
    }

    if (audio) {
      const audioWindowStart = start - audio.timelineStartSeconds
      const audioWindowEnd = end - audio.timelineStartSeconds
      segment.audioSourceId = audio.sourceId
      segment.audioStartSeconds = audio.sourceStartSeconds + audioWindowStart
      segment.audioEndSeconds = audio.sourceStartSeconds + audioWindowEnd
      segment.audioEdits = editsForWindow(audio.audioEdits, audioWindowStart, audioWindowEnd)
      segment.audioGain = audio.volume
    }

    segments.push(segment)
  }
  return segments
}

/**
 * Lays a clip's picture (and, if it has one, its sound) onto the timeline as
 * one linked pair, appended after everything already on those tracks.
 */
export function appendClip(
  timeline: EditorTimeline,
  clip: ClipSegment,
  opts: { videoTrackId: string; audioTrackId?: string }
): EditorTimeline {
  const videoSourceId = clip.videoSourceId ?? clip.sourceId
  const audioSourceId = clip.audioSourceId ?? videoSourceId
  const trackEnd = (trackId: string): number =>
    timeline.items
      .filter((i) => i.trackId === trackId)
      .reduce((max, i) => Math.max(max, i.timelineEndSeconds), 0)

  const videoStart = trackEnd(opts.videoTrackId)
  const videoId = createId('titem')

  if (!opts.audioTrackId) {
    const video: TimelineItem = {
      id: videoId,
      trackId: opts.videoTrackId,
      kind: 'video',
      sourceId: videoSourceId,
      sourceClipId: clip.id,
      sourceStartSeconds: clip.startSeconds,
      sourceEndSeconds: clip.endSeconds,
      timelineStartSeconds: videoStart,
      timelineEndSeconds: videoStart + clip.durationSeconds
    }
    return { ...timeline, items: [...timeline.items, video] }
  }

  const audioId = createId('titem')
  const video: TimelineItem = {
    id: videoId,
    trackId: opts.videoTrackId,
    kind: 'video',
    sourceId: videoSourceId,
    sourceClipId: clip.id,
    sourceStartSeconds: clip.startSeconds,
    sourceEndSeconds: clip.endSeconds,
    timelineStartSeconds: videoStart,
    timelineEndSeconds: videoStart + clip.durationSeconds,
    linkedItemId: audioId
  }
  const audioStart = trackEnd(opts.audioTrackId)
  const audio: TimelineItem = {
    id: audioId,
    trackId: opts.audioTrackId,
    kind: 'audio',
    sourceId: audioSourceId,
    sourceClipId: clip.id,
    sourceStartSeconds: clip.startSeconds,
    sourceEndSeconds: clip.endSeconds,
    timelineStartSeconds: audioStart,
    timelineEndSeconds: audioStart + clip.durationSeconds,
    linkedItemId: videoId
  }

  return { ...timeline, items: [...timeline.items, video, audio] }
}

// ------------------------------------------------------- many items at once ---

/**
 * The ids you asked for, plus the other half of any linked video/audio pair.
 *
 * A clip's picture and its sound are two items that happen to point at the
 * same range. Every edit in this file acts on exactly the id it is given —
 * that is what keeps each one simple — so "move the sound with the picture"
 * has to be spelled somewhere, and this is it. The editor puts every
 * selection through here, which is why dragging a video item no longer
 * silently desynchronises the audio item beneath it.
 */
export function withLinked(timeline: EditorTimeline, ids: Iterable<string>): string[] {
  const out = new Set<string>()
  const byId = new Map(timeline.items.map((i) => [i.id, i]))
  for (const id of ids) {
    if (!byId.has(id)) continue
    out.add(id)
    const partner = byId.get(id)?.linkedItemId
    if (partner !== undefined && byId.has(partner)) out.add(partner)
  }
  return [...out]
}

/** One item's destination in a multi-item drag. */
export interface ItemMove {
  id: string
  trackId: string
  timelineStartSeconds: number
}

/**
 * Moves several items in one edit, so a group drag is a single undo step
 * rather than one per item — and so two items that swap places cannot see
 * each other half-moved.
 */
export function moveItems(timeline: EditorTimeline, moves: ItemMove[]): EditorTimeline {
  if (moves.length === 0) return timeline
  const byId = new Map(moves.map((m) => [m.id, m]))
  return {
    ...timeline,
    items: timeline.items.map((item) => {
      const move = byId.get(item.id)
      if (!move) return item
      const duration = item.timelineEndSeconds - item.timelineStartSeconds
      const start = Math.max(0, move.timelineStartSeconds)
      return { ...item, trackId: move.trackId, timelineStartSeconds: start, timelineEndSeconds: start + duration }
    })
  }
}

/**
 * Shifts items along their own tracks by a delta, clamped so the earliest of
 * them stops at zero rather than the group tearing apart against the start of
 * the sequence.
 */
export function nudgeItems(
  timeline: EditorTimeline,
  ids: Iterable<string>,
  deltaSeconds: number
): EditorTimeline {
  const wanted = new Set(ids)
  const moving = timeline.items.filter((i) => wanted.has(i.id))
  if (moving.length === 0 || deltaSeconds === 0) return timeline
  const earliest = Math.min(...moving.map((i) => i.timelineStartSeconds))
  const delta = Math.max(deltaSeconds, -earliest)
  if (delta === 0) return timeline
  return moveItems(
    timeline,
    moving.map((i) => ({
      id: i.id,
      trackId: i.trackId,
      timelineStartSeconds: i.timelineStartSeconds + delta
    }))
  )
}

/**
 * Deletes several items as one edit. With `ripple` on, each track closes up
 * behind what it lost — applied one item at a time so two deletions on the
 * same track shift the survivors by the sum of both, which is what "close the
 * gap" means when the gap was made twice.
 */
export function deleteItems(
  timeline: EditorTimeline,
  ids: Iterable<string>,
  ripple = false
): EditorTimeline {
  let next = timeline
  // Latest first: a ripple delete only moves items that start *after* the one
  // removed, so working backwards means each deletion sees the positions the
  // earlier ones have not yet disturbed.
  const ordered = [...ids]
    .map((id) => next.items.find((i) => i.id === id))
    .filter((i): i is TimelineItem => i !== undefined)
    .sort((a, b) => b.timelineStartSeconds - a.timelineStartSeconds)
  for (const item of ordered) next = deleteItem(next, item.id, ripple)
  return next
}

/**
 * Splits every one of `ids` that actually spans the position — the blade
 * applied to a selection, or (with no ids) to everything crossing that
 * instant on an unlocked track, which is what pressing the split key with
 * nothing selected should do.
 */
export function splitItemsAt(
  timeline: EditorTimeline,
  atTimelineSeconds: number,
  ids?: Iterable<string>
): EditorTimeline {
  const only = ids === undefined ? null : new Set(ids)
  const lockedTrackIds = new Set(timeline.tracks.filter((t) => t.locked).map((t) => t.id))
  const targets = timeline.items
    .filter((i) => (only === null ? !lockedTrackIds.has(i.trackId) : only.has(i.id)))
    .filter((i) => atTimelineSeconds > i.timelineStartSeconds && atTimelineSeconds < i.timelineEndSeconds)
    .map((i) => i.id)
  let next = timeline
  for (const id of targets) next = splitItem(next, id, atTimelineSeconds)
  return next
}

/** Every item overlapping a time span on one of `trackIds` — the marquee's answer. */
export function itemsInSpan(
  timeline: EditorTimeline,
  startSeconds: number,
  endSeconds: number,
  trackIds: Iterable<string>
): string[] {
  const tracks = new Set(trackIds)
  const from = Math.min(startSeconds, endSeconds)
  const to = Math.max(startSeconds, endSeconds)
  return timeline.items
    .filter((i) => tracks.has(i.trackId) && i.timelineEndSeconds > from && i.timelineStartSeconds < to)
    .map((i) => i.id)
}

/**
 * Pulls everything after a gap on one track left until it meets what came
 * before — the "close this hole" command, which trimming and deleting without
 * ripple both leave behind.
 */
export function closeGapAt(
  timeline: EditorTimeline,
  trackId: string,
  atTimelineSeconds: number
): EditorTimeline {
  const onTrack = timeline.items
    .filter((i) => i.trackId === trackId)
    .sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)
  const next = onTrack.find((i) => i.timelineStartSeconds > atTimelineSeconds)
  if (!next) return timeline
  // Where the gap actually begins: the end of the last item before it, or the
  // start of the sequence when nothing precedes it.
  const previousEnd = onTrack
    .filter((i) => i.timelineEndSeconds <= next.timelineStartSeconds + 0.001)
    .reduce((max, i) => Math.max(max, i.timelineEndSeconds), 0)
  const gap = next.timelineStartSeconds - previousEnd
  if (gap <= 0.001) return timeline
  return {
    ...timeline,
    items: timeline.items.map((i) =>
      i.trackId === trackId && i.timelineStartSeconds >= next.timelineStartSeconds - 0.001
        ? {
            ...i,
            timelineStartSeconds: i.timelineStartSeconds - gap,
            timelineEndSeconds: i.timelineEndSeconds - gap
          }
        : i
    )
  }
}

/** Moves a track up or down its own kind's stack, which is what decides who is on top. */
export function reorderTrack(
  timeline: EditorTimeline,
  trackId: string,
  direction: 'up' | 'down'
): EditorTimeline {
  const track = timeline.tracks.find((t) => t.id === trackId)
  if (!track) return timeline
  const siblings = timeline.tracks
    .filter((t) => t.kind === track.kind)
    .sort((a, b) => a.order - b.order)
  const index = siblings.findIndex((t) => t.id === trackId)
  const swapWith = siblings[index + (direction === 'up' ? 1 : -1)]
  if (!swapWith) return timeline
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) =>
      t.id === track.id ? { ...t, order: swapWith.order } : t.id === swapWith.id ? { ...t, order: track.order } : t
    )
  }
}
