import { createId } from '@shared/clips'
import { eventToLocal, isSynced, localToEvent } from '@shared/sync'
import type { SyncAnchor } from '@shared/sync'
import { alignByAudio, buildAudioAnchors } from '@shared/align'
import type { AlignmentResult } from '@shared/align'
import type { VodSource } from '@shared/types'

/** Long enough to catch a distinctive sound, short enough to fetch quickly. */
const WINDOW_SECONDS = 30

export interface CrossCheckOutcome {
  alignment: AlignmentResult
  /** Null when the match wasn't confident enough to act on. */
  anchors: SyncAnchor[] | null
}

/**
 * Corroborate or refine `target`'s timing against `reference`'s, using the
 * same cross-correlation the manual "Align POVs" dialog already runs on
 * request — just triggered automatically instead of by hand.
 *
 * Both sides need *some* existing timing before this can help: it searches
 * near where each POV's current mapping already estimates the shared moment
 * to be, the same way the manual dialog does. A POV with no timing at all
 * still needs metadata or a manual anchor first — this refines an estimate,
 * it doesn't invent one by searching a whole VOD blind, which would be both
 * slow and unreliable against repetitive game audio.
 *
 * Returns null when there's nothing useful to check (either side unsynced,
 * or their estimated recording windows don't even overlap).
 */
export async function crossCheckByAudio(
  reference: VodSource,
  target: VodSource
): Promise<CrossCheckOutcome | null> {
  const refMapping = reference.syncMapping
  const targetMapping = target.syncMapping
  if (!refMapping || !targetMapping || !isSynced(refMapping) || !isSynced(targetMapping)) return null

  const refEventStart = localToEvent(refMapping, 0)!
  const refEventEnd = localToEvent(refMapping, reference.durationSeconds)!
  const targetEventStart = localToEvent(targetMapping, 0)!
  const targetEventEnd = localToEvent(targetMapping, target.durationSeconds)!
  const overlapStart = Math.max(refEventStart, targetEventStart)
  const overlapEnd = Math.min(refEventEnd, targetEventEnd)
  if (overlapEnd - overlapStart < WINDOW_SECONDS) return null

  const eventTime = (overlapStart + overlapEnd) / 2
  const half = WINDOW_SECONDS / 2
  const refLocal = eventToLocal(refMapping, eventTime)!
  const targetLocal = eventToLocal(targetMapping, eventTime)!
  const refStart = Math.max(0, refLocal - half)
  const targetStart = Math.max(0, targetLocal - half)

  const [a, b] = await Promise.all([
    window.api.audioPeaks({
      source: reference,
      startSeconds: refStart,
      endSeconds: refStart + WINDOW_SECONDS,
      buckets: 900
    }),
    window.api.audioPeaks({
      source: target,
      startSeconds: targetStart,
      endSeconds: targetStart + WINDOW_SECONDS,
      buckets: 900
    })
  ])

  const secondsPerBucket = WINDOW_SECONDS / Math.max(1, a.rms.length)
  const alignment = alignByAudio(a.rms, b.rms, secondsPerBucket)
  const anchors = buildAudioAnchors(
    { vodId: reference.id, localTime: refStart + half },
    { vodId: target.id, localTime: targetStart + half },
    eventTime,
    alignment,
    createId
  )
  return { alignment, anchors }
}

/** The synced POV whose mapping the solver trusts most — the safest reference. */
export function strongestSyncedSibling(
  sources: VodSource[],
  excludeId: string
): VodSource | null {
  let best: VodSource | null = null
  for (const source of sources) {
    if (source.id === excludeId || !isSynced(source.syncMapping)) continue
    if (!best || (source.syncMapping?.confidence ?? 0) > (best.syncMapping?.confidence ?? 0)) {
      best = source
    }
  }
  return best
}

/** Has this POV ever been corroborated by an audio cross-check? */
export function hasAudioAnchor(anchors: SyncAnchor[], vodId: string): boolean {
  return anchors.some((a) => a.vodId === vodId && a.source === 'audio_anchor')
}
