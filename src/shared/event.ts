/**
 * The event: the object everything else in the application hangs off.
 *
 *     EVENT → PEOPLE → STREAMS → POVs → MOMENTS → CLIPS
 *
 * A project already *was* an event in all but name — it holds the POVs, the
 * clips, and the sync anchors that tie both to one real-world clock. So the
 * event is modelled as metadata *on* the project rather than as a second
 * entity beside it: a parallel Event object would have meant two places for
 * "which POVs are in this", and every feature downstream would have had to
 * pick one.
 *
 * What the event block adds is the part a project never stated explicitly:
 * *when the thing actually happened* on the wall clock, and the organisation
 * built on top of that (collections, participants, notable moments).
 */

import type { ClipSegment, EventInfo, EventMoment, ProjectFile, VodSource } from './types.js'
import { isSynced, localToEvent } from './sync.js'

/** Default length assumed for an event given a start but no end. */
export const DEFAULT_EVENT_MINUTES = 30

/**
 * The event window to reason about, in real-world epoch seconds.
 *
 * Falls back to the span the clips themselves occupy when the editor has not
 * declared one, so the event timeline and coverage map are useful immediately
 * rather than only after someone fills in a form.
 */
export function eventWindow(project: ProjectFile): { startSeconds: number; endSeconds: number } | null {
  const declared = project.event
  if (declared?.startSeconds !== undefined && declared.startSeconds !== null) {
    const end =
      declared.endSeconds !== undefined && declared.endSeconds !== null && declared.endSeconds > declared.startSeconds
        ? declared.endSeconds
        : declared.startSeconds + DEFAULT_EVENT_MINUTES * 60
    return { startSeconds: declared.startSeconds, endSeconds: end }
  }

  // Derived: the span covered by clips that know their real-world time.
  const times: number[] = []
  for (const clip of project.clips) {
    if (typeof clip.eventStartTime === 'number') times.push(clip.eventStartTime)
    if (typeof clip.eventEndTime === 'number') times.push(clip.eventEndTime)
  }
  if (times.length === 0) return null
  const start = Math.min(...times)
  const end = Math.max(...times)
  return { startSeconds: start, endSeconds: end > start ? end : start + 60 }
}

/** A POV's own real-world span: when that broadcast started and stopped. */
export function sourceWindow(source: VodSource): { startSeconds: number; endSeconds: number } | null {
  const mapping = source.syncMapping
  if (!mapping || !isSynced(mapping)) return null
  const start = localToEvent(mapping, 0)
  const end = localToEvent(mapping, source.durationSeconds)
  if (start === null || end === null) return null
  return { startSeconds: start, endSeconds: end }
}

export type CoverageState =
  /** Footage exists for this whole stretch. */
  | 'available'
  /** The POV covers part of the stretch only. */
  | 'partial'
  /** The POV was not recording then. */
  | 'missing'
  /** No real-world timing for this POV yet, so nothing can be claimed. */
  | 'unknown'

export interface PovCoverage {
  sourceId: string
  state: CoverageState
  /** Fraction of the event this POV covers, 0..1. */
  fraction: number
  /** Where this POV's footage sits inside the event window, as 0..1 fractions. */
  spans: Array<{ from: number; to: number }>
}

/**
 * How much of the event each POV can actually show (§4).
 *
 * Returned as fractions of the event window rather than seconds so the
 * coverage map can lay bars out without knowing the window itself, and so a
 * zoom or a window change never needs the maths redone.
 */
export function povCoverage(project: ProjectFile): PovCoverage[] {
  const window = eventWindow(project)
  if (!window) {
    return project.sources.map((s) => ({ sourceId: s.id, state: 'unknown', fraction: 0, spans: [] }))
  }
  const span = Math.max(0.001, window.endSeconds - window.startSeconds)

  return project.sources.map((source) => {
    const own = sourceWindow(source)
    if (!own) return { sourceId: source.id, state: 'unknown' as const, fraction: 0, spans: [] }

    const from = Math.max(own.startSeconds, window.startSeconds)
    const to = Math.min(own.endSeconds, window.endSeconds)
    if (to <= from) return { sourceId: source.id, state: 'missing' as const, fraction: 0, spans: [] }

    const fraction = (to - from) / span
    return {
      sourceId: source.id,
      state: fraction >= 0.999 ? ('available' as const) : ('partial' as const),
      fraction,
      spans: [
        {
          from: (from - window.startSeconds) / span,
          to: (to - window.startSeconds) / span
        }
      ]
    }
  })
}

/** Where a clip sits inside the event window, as 0..1 fractions. Null when it has no real-world time. */
export function clipSpan(
  clip: ClipSegment,
  window: { startSeconds: number; endSeconds: number }
): { from: number; to: number } | null {
  if (typeof clip.eventStartTime !== 'number' || typeof clip.eventEndTime !== 'number') return null
  const span = Math.max(0.001, window.endSeconds - window.startSeconds)
  const from = (clip.eventStartTime - window.startSeconds) / span
  const to = (clip.eventEndTime - window.startSeconds) / span
  if (to < 0 || from > 1) return null
  return { from: Math.max(0, from), to: Math.min(1, to) }
}

/**
 * The event's participant summary (§14).
 *
 * Counts people, not broadcasts: a streamer restreaming to two platforms is
 * one participant, which is what `personId` on a saved streamer exists to
 * express. POVs whose timing is unknown are counted separately from ones that
 * genuinely were not recording — "we don't know" and "they weren't there" are
 * different answers and collapsing them hides work still to do.
 */
export interface ParticipantSummary {
  loaded: number
  fullCoverage: number
  partialCoverage: number
  missing: number
  unknown: number
}

export function participantSummary(project: ProjectFile): ParticipantSummary {
  const coverage = povCoverage(project)
  const summary: ParticipantSummary = {
    loaded: project.sources.length,
    fullCoverage: 0,
    partialCoverage: 0,
    missing: 0,
    unknown: 0
  }
  for (const c of coverage) {
    if (c.state === 'available') summary.fullCoverage++
    else if (c.state === 'partial') summary.partialCoverage++
    else if (c.state === 'missing') summary.missing++
    else summary.unknown++
  }
  return summary
}

/**
 * Overall event coverage, 0..1: the fraction of the event window that at
 * least one loaded POV can show.
 *
 * Deliberately a union, not a sum — three POVs covering the same ten minutes
 * is still ten minutes of the event covered, and reporting 300% would be
 * meaningless. This is the number the project dashboard (§18) reports.
 */
export function eventCoverageFraction(project: ProjectFile): number {
  const spans = povCoverage(project)
    .flatMap((c) => c.spans)
    .sort((a, b) => a.from - b.from)
  if (spans.length === 0) return 0

  let covered = 0
  let cursor = 0
  for (const span of spans) {
    const from = Math.max(span.from, cursor)
    if (span.to > from) {
      covered += span.to - from
      cursor = span.to
    }
  }
  return Math.max(0, Math.min(1, covered))
}

/** A blank event block, used when a project first declares one. */
export function emptyEvent(): EventInfo {
  return { name: null, startSeconds: null, endSeconds: null, collections: [], moments: [] }
}

/** Notable moments on the event timeline (§21), earliest first. */
export function sortedMoments(event: EventInfo | undefined): EventMoment[] {
  return [...(event?.moments ?? [])].sort((a, b) => a.timeSeconds - b.timeSeconds)
}
