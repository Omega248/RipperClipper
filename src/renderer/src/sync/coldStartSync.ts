import { createId } from '@shared/clips'
import { anchorsFromPairing, isSynced, localToEvent } from '@shared/sync'
import type { SyncAnchor } from '@shared/sync'
import { slideMatch } from '@shared/align'
import type { VodSource } from '@shared/types'

/**
 * Cold-start audio sync: aligning a POV with no usable timing at all against
 * one that already has some, by searching the *whole* untimed recording —
 * not the narrow known window `crossCheckByAudio` nudges within once a POV
 * already has a rough estimate to refine.
 *
 * The approach: take several short audio probes spread across the already-
 * synced reference, and for each, search the entire target for where that
 * same moment occurs (`slideMatch`). Every confident hit becomes one sync
 * anchor pair; several independent hits go through the same weighted
 * least-squares solver every other anchor source already uses
 * (`solveMapping`), which is what actually turns "a few matched moments"
 * into a trustworthy offset (and drift, if the probes are far enough apart)
 * — no separate voting scheme needed here.
 *
 * This is a real search across hours of audio, not an instant lookup: it
 * fetches a probe window's worth of audio from the reference and the
 * target's *entire* duration in chunks. Bounded concurrency keeps it from
 * firing the target's whole VOD's worth of requests at once, but a long
 * recording still means this can take from several seconds to a couple of
 * minutes — callers should show that, not treat it like a quick nudge.
 */

const PROBE_COUNT = 6
const PROBE_WINDOW_SECONDS = 20
const BUCKET_SECONDS = 0.25
const CHUNK_SECONDS = 900 // 15 minutes
const MAX_CONCURRENT_FETCHES = 3
/** A cold-start result needs corroboration — one lucky match is not enough. */
const MIN_SUPPORTING_MATCHES = 2

export interface ColdStartProgress {
  phase: 'probes' | 'searching'
  done: number
  total: number
}

export interface ColdStartOutcome {
  anchors: SyncAnchor[]
  /** How many of the probes found a confident match somewhere in the target. */
  matchedProbes: number
  probesAttempted: number
}

function bucketsFor(durationSeconds: number): number {
  return Math.max(8, Math.round(durationSeconds / BUCKET_SECONDS))
}

/**
 * Finds `target`'s timing against `reference` from audio alone, with no
 * prior estimate for `target` required. Returns null when `reference` isn't
 * itself synced (there is nothing to search *for* without that), either
 * source has no duration, or too few probes found a confident match to
 * trust the result.
 */
export async function coldStartSyncByAudio(
  reference: VodSource,
  target: VodSource,
  onProgress?: (p: ColdStartProgress) => void,
  signal?: AbortSignal
): Promise<ColdStartOutcome | null> {
  const refMapping = reference.syncMapping
  if (!refMapping || !isSynced(refMapping)) return null
  if (!(reference.durationSeconds > 0) || !(target.durationSeconds > 0)) return null

  // Spread probes across the middle of the reference — intros/outros
  // ("starting soon", loading screens) tend to be the least distinctive
  // audio a stream has.
  const usableSpan = reference.durationSeconds * 0.8
  const spanStart = reference.durationSeconds * 0.1
  const probeLocalTimes = Array.from(
    { length: PROBE_COUNT },
    (_, i) => spanStart + (usableSpan * (i + 0.5)) / PROBE_COUNT
  )

  onProgress?.({ phase: 'probes', done: 0, total: probeLocalTimes.length })
  const probes = await Promise.all(
    probeLocalTimes.map(async (localTime, i) => {
      const endSeconds = Math.min(reference.durationSeconds, localTime + PROBE_WINDOW_SECONDS)
      const peaks = await window.api.audioPeaks({
        source: reference,
        startSeconds: localTime,
        endSeconds,
        buckets: bucketsFor(endSeconds - localTime)
      })
      onProgress?.({ phase: 'probes', done: i + 1, total: probeLocalTimes.length })
      return { localTime, rms: peaks.rms }
    })
  )
  const usableProbes = probes.filter((p) => p.rms.length >= 8)
  if (usableProbes.length === 0) return null

  const chunkStarts: number[] = []
  for (let t = 0; t < target.durationSeconds; t += CHUNK_SECONDS) chunkStarts.push(t)

  let chunksDone = 0
  // Only the single best match per probe is kept — a probe hitting more
  // than one chunk (a repeated sound, or menu music) would otherwise hand
  // the solver two contradictory anchors for the same reference moment.
  const bestByProbe = new Map<number, { targetLocal: number; score: number; margin: number }>()

  const runNext = async (cursor: { i: number }): Promise<void> => {
    while (cursor.i < chunkStarts.length) {
      if (signal?.aborted) return
      const chunkStart = chunkStarts[cursor.i++]
      const chunkEnd = Math.min(target.durationSeconds, chunkStart + CHUNK_SECONDS)
      const chunk = await window.api.audioPeaks({
        source: target,
        startSeconds: chunkStart,
        endSeconds: chunkEnd,
        buckets: bucketsFor(chunkEnd - chunkStart)
      })
      if (signal?.aborted) return
      const secondsPerBucket = (chunkEnd - chunkStart) / Math.max(1, chunk.rms.length)

      for (const probe of usableProbes) {
        const match = slideMatch(chunk.rms, probe.rms)
        if (!match.confident) continue
        const existing = bestByProbe.get(probe.localTime)
        if (existing && existing.score >= match.score) continue
        bestByProbe.set(probe.localTime, {
          targetLocal: chunkStart + match.offsetBuckets * secondsPerBucket,
          score: match.score,
          margin: match.margin
        })
      }
      chunksDone++
      onProgress?.({ phase: 'searching', done: chunksDone, total: chunkStarts.length })
    }
  }

  const cursor = { i: 0 }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_FETCHES, chunkStarts.length) }, () => runNext(cursor))
  )

  if (bestByProbe.size < MIN_SUPPORTING_MATCHES) return null

  const anchors: SyncAnchor[] = []
  for (const [probeLocalTime, match] of bestByProbe) {
    const eventTime = localToEvent(refMapping, probeLocalTime)
    if (eventTime === null) continue
    anchors.push(
      ...anchorsFromPairing(
        [
          { vodId: reference.id, localTime: probeLocalTime },
          { vodId: target.id, localTime: match.targetLocal }
        ],
        eventTime,
        'audio_anchor',
        createId,
        Math.max(0.3, Math.min(0.95, match.score * (0.5 + match.margin)))
      )
    )
  }

  return {
    anchors,
    matchedProbes: bestByProbe.size,
    probesAttempted: usableProbes.length
  }
}
