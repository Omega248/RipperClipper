import type { ClipSegment, Marker, MarkerCategory } from './types.js'
import { roundMs, validateRange } from './time.js'
import { Errors } from './errors.js'

/**
 * Pure clip-collection operations. No UI, no IO — the renderer store and the
 * main process both use these so behaviour cannot drift between them.
 */

export function createId(prefix: string): string {
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `${prefix}_${rand}`
}

export function normalizeOrder(clips: ClipSegment[]): ClipSegment[] {
  return clips
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((c, i) => (c.order === i ? c : { ...c, order: i }))
}

export function makeClip(init: {
  name: string
  sourceId: string
  startSeconds: number
  endSeconds: number
  order: number
  /** Real-world range; null when the authoring POV has no known timing yet. */
  eventStartTime?: number | null
  eventEndTime?: number | null
}): ClipSegment {
  const start = roundMs(init.startSeconds)
  const end = roundMs(init.endSeconds)
  return {
    id: createId('clip'),
    name: init.name.trim() === '' ? 'Untitled clip' : init.name.trim(),
    sourceId: init.sourceId,
    startSeconds: start,
    endSeconds: end,
    durationSeconds: roundMs(end - start),
    order: init.order,
    status: 'idle',
    eventStartTime: init.eventStartTime ?? null,
    eventEndTime: init.eventEndTime ?? null
  }
}

export function addClip(
  clips: ClipSegment[],
  init: {
    name: string
    sourceId: string
    startSeconds: number
    endSeconds: number
    eventStartTime?: number | null
    eventEndTime?: number | null
  },
  sourceDuration: number
): ClipSegment[] {
  const validation = validateRange(init.startSeconds, init.endSeconds, sourceDuration)
  if (!validation.ok) throw Errors.invalidRange(validation.errors.join(' '))
  const clip = makeClip({ ...init, order: clips.length })
  return normalizeOrder([...clips, clip])
}

export function updateClip(
  clips: ClipSegment[],
  clipId: string,
  patch: Partial<
    Pick<
      ClipSegment,
      | 'name'
      | 'startSeconds'
      | 'endSeconds'
      | 'status'
      | 'exportedPath'
      | 'lastMessage'
      | 'eventStartTime'
      | 'eventEndTime'
      | 'videoSourceId'
      | 'audioSourceId'
    >
  >,
  sourceDuration: number
): ClipSegment[] {
  return clips.map((clip) => {
    if (clip.id !== clipId) return clip
    const next: ClipSegment = { ...clip, ...patch }
    if (patch.name !== undefined) next.name = patch.name.trim() === '' ? clip.name : patch.name
    if (patch.startSeconds !== undefined || patch.endSeconds !== undefined) {
      next.startSeconds = roundMs(next.startSeconds)
      next.endSeconds = roundMs(next.endSeconds)
      const validation = validateRange(next.startSeconds, next.endSeconds, sourceDuration)
      if (!validation.ok) throw Errors.invalidRange(validation.errors.join(' '))
      next.durationSeconds = roundMs(next.endSeconds - next.startSeconds)
    }
    return next
  })
}

export function duplicateClip(clips: ClipSegment[], clipId: string): ClipSegment[] {
  const index = clips.findIndex((c) => c.id === clipId)
  if (index === -1) return clips
  const original = clips[index]
  const copy: ClipSegment = {
    ...original,
    id: createId('clip'),
    name: nextCopyName(
      original.name,
      clips.map((c) => c.name)
    ),
    status: 'idle',
    exportedPath: undefined,
    lastMessage: undefined,
    order: original.order + 1
  }
  const next = clips.map((c) => (c.order > original.order ? { ...c, order: c.order + 1 } : c))
  return normalizeOrder([...next, copy])
}

export function removeClip(clips: ClipSegment[], clipId: string): ClipSegment[] {
  return normalizeOrder(clips.filter((c) => c.id !== clipId))
}

/** Move the clip at `from` (index in ordered list) to index `to`. */
export function reorderClips(clips: ClipSegment[], from: number, to: number): ClipSegment[] {
  const ordered = normalizeOrder(clips)
  if (from < 0 || from >= ordered.length) return ordered
  const target = Math.max(0, Math.min(ordered.length - 1, to))
  const moved = ordered.slice()
  const [item] = moved.splice(from, 1)
  moved.splice(target, 0, item)
  return moved.map((c, i) => ({ ...c, order: i }))
}

export function clipsForSource(clips: ClipSegment[], sourceId: string): ClipSegment[] {
  return normalizeOrder(clips.filter((c) => c.sourceId === sourceId))
}

function nextCopyName(name: string, existing: string[]): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, '')
  let candidate = `${base} (copy)`
  let n = 2
  const taken = new Set(existing.map((e) => e.toLowerCase()))
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (copy ${n})`
    n++
  }
  return candidate
}

export function makeMarker(init: {
  sourceId: string
  timeSeconds: number
  label: string
  category?: MarkerCategory
}): Marker {
  return {
    id: createId('mark'),
    sourceId: init.sourceId,
    timeSeconds: roundMs(init.timeSeconds),
    label: init.label.trim() === '' ? 'Marker' : init.label.trim(),
    category: init.category ?? 'other'
  }
}

/** Build a clip range centred on a marker, clamped to the source. */
export function markerToRange(
  marker: Marker,
  sourceDuration: number,
  opts: { beforeSeconds?: number; afterSeconds?: number } = {}
): { startSeconds: number; endSeconds: number } {
  const before = opts.beforeSeconds ?? 15
  const after = opts.afterSeconds ?? 15
  const start = Math.max(0, marker.timeSeconds - before)
  const end = Math.min(
    Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : Infinity,
    marker.timeSeconds + after
  )
  return { startSeconds: roundMs(start), endSeconds: roundMs(end) }
}
