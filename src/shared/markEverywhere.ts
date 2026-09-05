import { eventToLocal, isSynced, localToEvent } from './sync.js'
import type { Marker, MarkerCategory, VodSource } from './types.js'
import { makeMarker } from './clips.js'

/**
 * The same instant, marked in every angle.
 *
 * Finding a moment is the expensive part of multi-POV work, and finding it
 * once should be enough. Today a marker belongs to the POV it was dropped in;
 * switch angle and it is gone, so the same beat gets hunted down five times.
 *
 * Every angle already knows where the real-world clock falls in its own
 * recording — that is what `syncMapping` is for and what every clip already
 * relies on. Projecting one marker through all of them is arithmetic that has
 * already been done.
 *
 * Two refusals worth stating: an angle with no usable mapping is skipped
 * rather than marked at a guessed time, and an angle whose recording does not
 * reach that instant is skipped rather than clamped to its first or last
 * frame — a marker piled up on frame zero is worse than no marker, because it
 * looks like a real answer.
 */

export interface MarkEverywhereInput {
  sources: VodSource[]
  /** The angle the moment was found in. */
  fromSourceId: string
  /** Where the playhead is in that angle's own seconds. */
  atSeconds: number
  label: string
  category?: MarkerCategory
}

export interface MarkEverywhereResult {
  markers: Marker[]
  /** Angles that could not be marked, and why, so the count is never a lie. */
  skipped: Array<{ sourceId: string; reason: 'unsynced' | 'not-recording' }>
  /** The real-world instant, when one could be worked out. */
  eventSeconds: number | null
}

export function markEverywhere(input: MarkEverywhereInput): MarkEverywhereResult {
  const { sources, fromSourceId, atSeconds, label, category } = input
  const from = sources.find((s) => s.id === fromSourceId)
  if (!from) return { markers: [], skipped: [], eventSeconds: null }

  const here = makeMarker({ sourceId: from.id, timeSeconds: atSeconds, label, category })

  // Without a clock on the source angle there is nothing to project through,
  // so this degrades to exactly what marking did before: one marker, here.
  const mapping = from.syncMapping
  const eventSeconds = mapping && isSynced(mapping) ? localToEvent(mapping, atSeconds) : null
  if (eventSeconds === null) {
    return {
      markers: [here],
      skipped: sources.filter((s) => s.id !== from.id).map((s) => ({ sourceId: s.id, reason: 'unsynced' as const })),
      eventSeconds: null
    }
  }

  const markers: Marker[] = [here]
  const skipped: MarkEverywhereResult['skipped'] = []

  for (const source of sources) {
    if (source.id === from.id) continue
    const target = source.syncMapping
    if (!target || !isSynced(target)) {
      skipped.push({ sourceId: source.id, reason: 'unsynced' })
      continue
    }
    const local = eventToLocal(target, eventSeconds)
    if (local === null || local < 0 || local > source.durationSeconds) {
      skipped.push({ sourceId: source.id, reason: 'not-recording' })
      continue
    }
    markers.push(makeMarker({ sourceId: source.id, timeSeconds: local, label, category }))
  }

  return { markers, skipped, eventSeconds }
}
