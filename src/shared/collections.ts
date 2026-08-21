/**
 * Organising an event's clips (§6, §7, §8).
 *
 * Pure operations, same contract as shared/timeline.ts: take state, return new
 * state, never mutate and never do IO — so the renderer store and any headless
 * caller share one definition of what "move this clip into that collection"
 * actually means.
 *
 * A collection is presentation, never truth. Filing a clip under "Chase"
 * changes nothing about when it happened, which POVs cover it, or what gets
 * exported — that all still derives from the event clock. This is the same
 * separation that lets a POV loaded next week backfill into existing clips.
 */

import { createId } from './clips.js'
import { CLIP_WORKFLOW_ORDER } from './types.js'
import type { ClipCollection, ClipSegment, ClipWorkflowState, EventInfo } from './types.js'

// ----------------------------------------------------------- collections ---

export function addCollection(event: EventInfo, name: string): { event: EventInfo; id: string } {
  const trimmed = name.trim()
  if (trimmed === '') return { event, id: '' }
  const order = event.collections.reduce((max, c) => Math.max(max, c.order), -1) + 1
  const collection: ClipCollection = { id: createId('coll'), name: trimmed, order }
  return { event: { ...event, collections: [...event.collections, collection] }, id: collection.id }
}

export function renameCollection(event: EventInfo, id: string, name: string): EventInfo {
  const trimmed = name.trim()
  if (trimmed === '') return event
  return {
    ...event,
    collections: event.collections.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
  }
}

/**
 * Removes a collection. Its clips are *not* deleted — they fall back to loose
 * in the event, because a clip is a real moment that happened and a folder
 * being tidied away is no reason to lose it.
 */
export function removeCollection(
  event: EventInfo,
  clips: ClipSegment[],
  id: string
): { event: EventInfo; clips: ClipSegment[] } {
  return {
    event: { ...event, collections: event.collections.filter((c) => c.id !== id) },
    clips: clips.map((c) => (c.collectionId === id ? { ...c, collectionId: null } : c))
  }
}

/** Moves a collection to a new position, renumbering the rest to stay contiguous. */
export function reorderCollection(event: EventInfo, id: string, toIndex: number): EventInfo {
  const ordered = [...event.collections].sort((a, b) => a.order - b.order)
  const from = ordered.findIndex((c) => c.id === id)
  if (from === -1) return event
  const target = Math.max(0, Math.min(ordered.length - 1, toIndex))
  const [moved] = ordered.splice(from, 1)
  ordered.splice(target, 0, moved)
  return { ...event, collections: ordered.map((c, i) => ({ ...c, order: i })) }
}

export function sortedCollections(event: EventInfo | undefined): ClipCollection[] {
  return [...(event?.collections ?? [])].sort((a, b) => a.order - b.order)
}

/** Files a clip under a collection, or loose in the event when given null. */
export function setClipCollection(
  clips: ClipSegment[],
  clipId: string,
  collectionId: string | null
): ClipSegment[] {
  return clips.map((c) => (c.id === clipId ? { ...c, collectionId } : c))
}

// -------------------------------------------------------------- workflow ---

export function setClipWorkflow(
  clips: ClipSegment[],
  clipId: string,
  workflow: ClipWorkflowState
): ClipSegment[] {
  return clips.map((c) => (c.id === clipId ? { ...c, workflow } : c))
}

export function workflowOf(clip: ClipSegment): ClipWorkflowState {
  return clip.workflow ?? 'found'
}

/**
 * Advances a clip's state, but only ever forwards (§7: "may automatically
 * advance when appropriate").
 *
 * Never moves a clip backwards, and never past a state the editor set by
 * hand: someone who marked a clip "ready for edit" has said something the
 * application should not quietly undo because an export happened to fail.
 */
export function advanceWorkflow(clip: ClipSegment, to: ClipWorkflowState): ClipSegment {
  const current = CLIP_WORKFLOW_ORDER.indexOf(workflowOf(clip))
  const next = CLIP_WORKFLOW_ORDER.indexOf(to)
  return next > current ? { ...clip, workflow: to } : clip
}

// -------------------------------------------------------- used/unused POV ---

export type PovUsage = 'used' | 'unused' | 'unavailable'

/**
 * Which POVs this clip has actually been cut from, versus merely could be
 * (§8).
 *
 * The distinction is the whole point: `povMappings` says a POV *covers* the
 * moment, which is a fact about the recording. Being *used* is a decision the
 * editor made. Surfacing "available but never looked at" is how footage
 * nobody considered gets found, and no amount of coverage data can tell you
 * that on its own.
 */
export function povUsage(clip: ClipSegment, sourceId: string): PovUsage {
  const mapping = clip.povMappings?.find((m) => m.sourceId === sourceId)
  const covers = mapping && (mapping.status === 'available' || mapping.status === 'partial')
  if (!covers) return 'unavailable'
  // The authoring POV and the chosen video/audio POVs are used by definition,
  // whether or not anyone ticked a box.
  if (
    clip.sourceId === sourceId ||
    clip.videoSourceId === sourceId ||
    clip.audioSourceId === sourceId ||
    (clip.usedPovIds ?? []).includes(sourceId)
  ) {
    return 'used'
  }
  return 'unused'
}

export function setPovUsed(clips: ClipSegment[], clipId: string, sourceId: string, used: boolean): ClipSegment[] {
  return clips.map((c) => {
    if (c.id !== clipId) return c
    const current = new Set(c.usedPovIds ?? [])
    if (used) current.add(sourceId)
    else current.delete(sourceId)
    return { ...c, usedPovIds: [...current] }
  })
}

/** Every POV that covers this clip but has not been used — §8's "show unused POVs". */
export function unusedPovIds(clip: ClipSegment): string[] {
  return (clip.povMappings ?? [])
    .filter((m) => povUsage(clip, m.sourceId) === 'unused')
    .map((m) => m.sourceId)
}
