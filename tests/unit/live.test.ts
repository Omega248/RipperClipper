import { describe, expect, it } from 'vitest'
import {
  BUFFER_WINDOWS,
  archivePollMs,
  bufferCovers,
  bufferedBytes,
  bufferedSeconds,
  degradeWindow,
  liveEdgeEpoch,
  measuredLatency,
  nextLiveState,
  pruneBuffer,
  recordingPollMs,
  retryDelayMs
} from '../../src/shared/live.js'
import type { BufferedSegment, LiveEvent } from '../../src/shared/live.js'
import type { LiveState } from '../../src/shared/types.js'

/**
 * The live domain's rules, tested where they actually live — as functions over
 * a state and a list of segments, with no socket anywhere near them.
 *
 * Every case here is one of the ways the feature loses the user's work.
 */

const EPOCH = 1_700_000_000

/** `count` two-second segments, 1 MB each, starting at EPOCH. */
function segments(count: number, bytes = 1_000_000): BufferedSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    sequence: 100 + i,
    startEpoch: EPOCH + i * 2,
    durationSeconds: 2,
    bytes
  }))
}

function live(over: Partial<LiveState> = {}): LiveState {
  return {
    state: 'live',
    latencySeconds: 4,
    bufferedSeconds: 60,
    windowSeconds: 60,
    ...over
  }
}

describe('the rolling buffer', () => {
  it('never holds more than the configured window', () => {
    // Five minutes of media offered to a sixty-second buffer.
    const kept = pruneBuffer(segments(150), 60)
    expect(bufferedSeconds(kept)).toBeLessThanOrEqual(60)
    // …and it holds very nearly the whole window, not a token amount.
    expect(bufferedSeconds(kept)).toBeGreaterThan(56)
  })

  it('drops the oldest media, never the newest', () => {
    const kept = pruneBuffer(segments(150), 60)
    const last = segments(150)[149]
    expect(kept[kept.length - 1].sequence).toBe(last.sequence)
    expect(kept[0].sequence).toBeGreaterThan(100)
  })

  it('is bounded by bytes as well as by time', () => {
    // Thirty seconds of media that happens to be 100 MB a segment: inside the
    // window, far outside a 250 MB budget.
    const kept = pruneBuffer(segments(15, 100_000_000), 60, 250_000_000)
    expect(bufferedBytes(kept)).toBeLessThanOrEqual(250_000_000)
    expect(kept.length).toBeGreaterThan(0)
  })

  it('holds a window it is not yet full of, unchanged', () => {
    const kept = pruneBuffer(segments(5), 60)
    expect(kept).toHaveLength(5)
  })

  it('degrades the window rather than the budget, and says why', () => {
    // Six live POVs at ~6.4 MB/s (1080p60) against the standing budget.
    const six = degradeWindow(300, 6, 6_400_000)
    expect(six.windowSeconds).toBeLessThan(300)
    expect(six.reason).toMatch(/6 live angles/)

    // One POV at the same rate fits five minutes with room to spare.
    const one = degradeWindow(300, 1, 6_400_000)
    expect(one.windowSeconds).toBe(300)
    expect(one.reason).toBeNull()
  })

  it('never degrades below the shortest window the UI offers', () => {
    const absurd = degradeWindow(300, 40, 60_000_000)
    expect(absurd.windowSeconds).toBe(BUFFER_WINDOWS[0])
  })
})

describe('live state transitions', () => {
  const step = (state: LiveState, ...events: LiveEvent[]): LiveState =>
    events.reduce(nextLiveState, state)

  it('treats a dropped connection as reconnecting, not as failure', () => {
    const s = nextLiveState(live(), { kind: 'connection-lost' })
    expect(s.state).toBe('reconnecting')
    // Everything the user would lose is still here.
    expect(s.bufferedSeconds).toBe(60)
    expect(s.windowSeconds).toBe(60)
  })

  it('counts consecutive failures and backs off exponentially', () => {
    const s = step(live(), { kind: 'connection-lost' }, { kind: 'connection-lost' })
    expect(s.retries).toBe(2)
    expect(retryDelayMs(1)).toBe(1000)
    expect(retryDelayMs(2)).toBe(2000)
    expect(retryDelayMs(3)).toBe(4000)
    // Capped, so a stream that returns after ten minutes is not missed by another ten.
    expect(retryDelayMs(50)).toBe(30_000)
  })

  it('clears the retry count when the stream comes back', () => {
    const s = step(
      live(),
      { kind: 'connection-lost' },
      { kind: 'connection-lost' },
      { kind: 'playlist-ok', latencySeconds: 6, bufferedSeconds: 42 }
    )
    expect(s.state).toBe('live')
    expect(s.retries).toBe(0)
    expect(s.latencySeconds).toBe(6)
  })

  it('sends an ended stream to awaiting-vod, not to an error', () => {
    const s = nextLiveState(live(), { kind: 'stream-ended' })
    expect(s.state).toBe('awaiting-vod')
    expect(s.archivedVodId).toBeUndefined()
  })

  it('completes only when the archive resolves, and remembers which one', () => {
    const s = step(live(), { kind: 'stream-ended' }, { kind: 'archive-resolved', vodId: 'v99' })
    expect(s.state).toBe('ended')
    expect(s.archivedVodId).toBe('v99')
  })

  it('does not send a source that has already ended back to reconnecting', () => {
    const ended = step(live(), { kind: 'stream-ended' })
    expect(nextLiveState(ended, { kind: 'connection-lost' })).toEqual(ended)
  })

  it('polls for the archive in minutes, not seconds', () => {
    expect(archivePollMs(1)).toBeGreaterThanOrEqual(60_000)
    expect(archivePollMs(100)).toBe(15 * 60_000)
  })
})

describe('the live clock', () => {
  it('measures the edge from the media, not the wall clock', () => {
    const held = segments(10)
    expect(liveEdgeEpoch(held)).toBe(EPOCH + 20)
    // Twelve seconds of platform latency between the media and now.
    expect(measuredLatency(EPOCH + 20, EPOCH + 32)).toBe(12)
  })

  it('never reports a negative latency', () => {
    expect(measuredLatency(EPOCH + 20, EPOCH + 10)).toBe(0)
  })

  it('has no edge when nothing is held', () => {
    expect(liveEdgeEpoch([])).toBeNull()
  })

  it('says whether a requested range is inside the buffer or needs an origin fetch', () => {
    const held = segments(30) // EPOCH .. EPOCH+60
    expect(bufferCovers(held, EPOCH + 10, EPOCH + 40)).toBe(true)
    // Before the held band: media the app does not have.
    expect(bufferCovers(held, EPOCH - 30, EPOCH + 10)).toBe(false)
    // Past the live edge: media that does not exist yet.
    expect(bufferCovers(held, EPOCH + 50, EPOCH + 90)).toBe(false)
    expect(bufferCovers([], EPOCH, EPOCH + 5)).toBe(false)
  })
})

describe('the recording of a broadcast in progress', () => {
  const live = (): LiveState => ({
    state: 'live',
    latencySeconds: 2,
    bufferedSeconds: 60,
    windowSeconds: 60,
    retries: 0
  })

  it('is remembered without ending the broadcast', () => {
    // The whole point: the stream is still running and the buffer is still
    // holding the edge. All this says is that the session can now be seeked
    // back to its start.
    const next = nextLiveState(live(), { kind: 'recording-found', vodId: 'v123' })
    expect(next.recordingVodId).toBe('v123')
    expect(next.state).toBe('live')
    expect(next.bufferedSeconds).toBe(60)
  })

  it('survives a reconnect, and is replaced by the final archive when it ends', () => {
    let state = nextLiveState(live(), { kind: 'recording-found', vodId: 'v123' })
    state = nextLiveState(state, { kind: 'connection-lost' })
    expect(state.state).toBe('reconnecting')
    expect(state.recordingVodId).toBe('v123')

    state = nextLiveState(state, { kind: 'stream-ended' })
    state = nextLiveState(state, { kind: 'archive-resolved', vodId: 'v123' })
    expect(state.state).toBe('ended')
    expect(state.archivedVodId).toBe('v123')
  })

  it('backs off from urgent to background while nothing is published', () => {
    // Fast at first because the user can only clip the last minute until it
    // lands; then it settles, because a platform that has not published one
    // in two minutes is usually not going to until the broadcast ends.
    expect(recordingPollMs(1)).toBe(10_000)
    expect(recordingPollMs(6)).toBe(60_000)
    expect(recordingPollMs(60)).toBe(120_000)
    expect(recordingPollMs(1)).toBeLessThan(archivePollMs(1))
  })
})
