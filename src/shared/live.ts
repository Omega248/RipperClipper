import type { LiveState } from './types.js'

/**
 * The live domain, with no I/O in it.
 *
 * Everything here is a pure function over a `LiveState` and a bounded list of
 * buffered segments, because every rule the feature has to keep is a rule
 * about those two things and none of them is testable through a socket:
 *
 *  - the buffer never holds more than the configured window,
 *  - a dropped connection is not a failure and does not cost the user media,
 *  - a clip marked against a live source survives the stream ending,
 *  - and the event range on that clip is never rewritten when the archive
 *    finally appears.
 *
 * The service in `main/media/liveBuffer.ts` supplies the sockets and the
 * timers; it decides nothing.
 */

/** Buffer windows the UI offers, in seconds. */
export const BUFFER_WINDOWS = [30, 60, 300] as const
export type BufferWindow = (typeof BUFFER_WINDOWS)[number]
export const DEFAULT_BUFFER_WINDOW: BufferWindow = 60

/**
 * Total bytes of live media the whole application may hold at once.
 *
 * At 1080p60 a five-minute window is roughly 1.9 GB per POV, so six live POVs
 * at five minutes is ~11 GB — a configuration that must not be accepted
 * silently. When the cap is reached the *window* degrades (and says so) rather
 * than the process exhausting memory.
 */
export const MAX_LIVE_RESIDENT_BYTES = 3 * 1024 * 1024 * 1024

/** One segment of live media held in memory. */
export interface BufferedSegment {
  /** HLS media sequence number — the only identity stable across refreshes. */
  sequence: number
  /** Wall-clock time of this segment's first frame, epoch seconds. */
  startEpoch: number
  durationSeconds: number
  bytes: number
}

/** Seconds of media currently held. Never a wall-clock subtraction. */
export function bufferedSeconds(segments: readonly BufferedSegment[]): number {
  let total = 0
  for (const s of segments) total += s.durationSeconds
  return round(total)
}

export function bufferedBytes(segments: readonly BufferedSegment[]): number {
  let total = 0
  for (const s of segments) total += s.bytes
  return total
}

/**
 * What survives a prune, oldest-first order preserved.
 *
 * Called on a timer rather than when media is asked for. A buffer that only
 * evicts on demand is not bounded — it is a recording with extra steps, and an
 * eight-hour stream fills the drive.
 *
 * Both caps are enforced here, and time is enforced first: dropping by age is
 * what the user asked for, dropping by size is the safety net underneath it.
 */
export function pruneBuffer(
  segments: readonly BufferedSegment[],
  windowSeconds: number,
  maxBytes = MAX_LIVE_RESIDENT_BYTES
): BufferedSegment[] {
  const kept = [...segments].sort((a, b) => a.sequence - b.sequence)

  // Oldest out until the held duration fits the window. `>` not `>=`: a buffer
  // exactly the size of the window is the intended steady state.
  while (kept.length > 1 && bufferedSeconds(kept) - kept[0].durationSeconds >= windowSeconds) {
    kept.shift()
  }
  while (kept.length > 1 && bufferedBytes(kept) > maxBytes) {
    kept.shift()
  }
  return kept
}

/**
 * The window a source may actually keep, given what every other live source is
 * already holding.
 *
 * Returns the configured window when it fits and a smaller one when it does
 * not, alongside the reason — which the UI is required to state. Silently
 * holding less than the user asked for is the failure this exists to prevent.
 */
export function degradeWindow(
  requestedSeconds: number,
  liveSourceCount: number,
  bytesPerSecondPerSource: number,
  maxBytes = MAX_LIVE_RESIDENT_BYTES
): { windowSeconds: number; reason: string | null } {
  const sources = Math.max(1, liveSourceCount)
  const perSourceBudget = maxBytes / sources
  const affordable = Math.floor(perSourceBudget / Math.max(1, bytesPerSecondPerSource))
  if (affordable >= requestedSeconds) return { windowSeconds: requestedSeconds, reason: null }

  // Never below the shortest offered window: under 30s the feature stops being
  // "clip the thing that just happened" and there is nothing left to degrade to.
  const windowSeconds = Math.max(BUFFER_WINDOWS[0], affordable)
  return {
    windowSeconds,
    reason:
      `Holding ${windowSeconds}s instead of ${requestedSeconds}s — ` +
      `${sources} live angle${sources === 1 ? '' : 's'} share the live memory budget.`
  }
}

// ------------------------------------------------------------- states ----

/**
 * Things that happen to a live source, as opposed to states it is in.
 *
 * `stream-ended` and `connection-lost` are deliberately distinct: the first is
 * the broadcaster finishing, the second is the network, and treating either as
 * the other is how a user loses work — a dropped socket that reads as "ended"
 * abandons a buffer that is still valid, and an ended stream that reads as
 * "reconnecting" retries forever against a broadcast that is over.
 */
export type LiveEvent =
  | { kind: 'playlist-ok'; latencySeconds: number; bufferedSeconds: number; viewers?: number }
  | { kind: 'connection-lost' }
  | { kind: 'stream-ended' }
  | { kind: 'archive-resolved'; vodId: string }
  | { kind: 'recording-found'; vodId: string }

export function nextLiveState(current: LiveState, event: LiveEvent): LiveState {
  switch (event.kind) {
    case 'playlist-ok':
      // Reachable again from any state short of the archive having resolved:
      // a broadcaster who ends and restarts within the session is live again,
      // and the retry counter resets because the connection is proven good.
      return {
        ...current,
        state: 'live',
        latencySeconds: event.latencySeconds,
        bufferedSeconds: event.bufferedSeconds,
        viewers: event.viewers ?? current.viewers,
        retries: 0
      }

    case 'connection-lost':
      // Not a failure, and not a state the buffer is cleared in. `retries`
      // drives both the backoff and the wording, so it counts consecutive
      // failures rather than being a flag.
      if (current.state === 'ended' || current.state === 'awaiting-vod') return current
      return { ...current, state: 'reconnecting', retries: (current.retries ?? 0) + 1 }

    case 'stream-ended':
      // Straight to awaiting-vod: there is nothing for the user to restart,
      // and clips already marked against this source are held, not failed.
      if (current.state === 'awaiting-vod' || current.archivedVodId) return current
      return { ...current, state: 'awaiting-vod', latencySeconds: 0, retries: 0 }

    case 'archive-resolved':
      return { ...current, state: 'ended', archivedVodId: event.vodId, retries: 0 }

    case 'recording-found':
      // Deliberately does NOT change `state`: the broadcast is still running
      // and the buffer keeps holding the live edge. All this says is that the
      // platform's own recording of it has been located, so the rest of the
      // app can seek back through the whole session instead of the window.
      return { ...current, recordingVodId: event.vodId }
  }
}

/**
 * How long to wait before the next reconnect attempt.
 *
 * Exponential from one second, capped at half a minute. The cap matters more
 * than the curve: an unbounded backoff on a stream that comes back after ten
 * minutes leaves the user watching nothing for another ten.
 */
export function retryDelayMs(retries: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, retries - 1))
}

/**
 * How often to ask whether the archive has been published.
 *
 * Minutes, not seconds. Platforms take minutes to hours to publish a VOD and
 * nothing about the answer is urgent — the clip is already held.
 */
export function archivePollMs(attempts: number): number {
  return Math.min(15 * 60_000, 60_000 * Math.max(1, attempts))
}

/**
 * How long to wait before looking again for the recording of a broadcast that
 * is still running.
 *
 * Much faster than `archivePollMs`, and for the opposite reason: this one is
 * urgent. Until it lands the user can only clip the last minute, so the first
 * few looks come quickly and then settle to a background check — a recording
 * that has not appeared inside two minutes is usually a platform that is not
 * going to publish one until the broadcast ends.
 */
export function recordingPollMs(attempts: number): number {
  return Math.min(2 * 60_000, 10_000 * Math.max(1, attempts))
}

// ------------------------------------------------------------- clocks ----

/**
 * Where the live edge sits on the event clock.
 *
 * Measured from the media itself — the last segment's PROGRAM-DATE-TIME plus
 * its duration — never assumed from the wall clock. Platform latency,
 * broadcaster delay and buffering all sit between the two, they differ per
 * platform, and they drift over the hours a broadcast runs.
 */
export function liveEdgeEpoch(segments: readonly BufferedSegment[]): number | null {
  const last = segments[segments.length - 1]
  return last ? round(last.startEpoch + last.durationSeconds) : null
}

/** Seconds behind the broadcast edge, as measured. Never negative. */
export function measuredLatency(edgeEpoch: number, nowEpoch: number): number {
  return round(Math.max(0, nowEpoch - edgeEpoch))
}

/**
 * Whether an event range can be served from what is held.
 *
 * The UI is required to say which of these a requested clip is *before* the
 * user asks for it, because it is the difference between instant and slow.
 */
export function bufferCovers(
  segments: readonly BufferedSegment[],
  startEpoch: number,
  endEpoch: number
): boolean {
  if (segments.length === 0) return false
  const first = segments[0]
  const edge = liveEdgeEpoch(segments)
  if (edge === null || startEpoch < first.startEpoch || endEpoch > edge) return false

  /*
   * The endpoints are not enough on their own.
   *
   * A segment that fails to download is skipped and the sequence moves on —
   * correct behaviour, because one bad request must not stall the buffer, but
   * it leaves a hole in the middle of media that still spans the range. This
   * checked only that the range began after the oldest segment and ended
   * before the live edge, so a clip drawn across such a hole was reported as
   * held, written by concatenating what was there, and came out short and
   * time-shifted after the gap — with nothing anywhere saying so. Exports do
   * not verify content, so it would be found by watching the clip.
   *
   * A gap shows as a break in the media sequence, and only matters when it
   * falls inside the range being asked for.
   */
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1]
    const next = segments[i]
    if (next.sequence === previous.sequence + 1) continue
    const holeStart = previous.startEpoch + previous.durationSeconds
    const holeEnd = next.startEpoch
    if (holeStart < endEpoch && holeEnd > startEpoch) return false
  }
  return true
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
