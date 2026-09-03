import { describe, expect, it } from 'vitest'
import { followerTargets, povCoverage, stillOnAir } from '../../src/shared/multiPov.js'
import type { VodSource } from '../../src/shared/types.js'

/**
 * A wall of live angles shows every angle, not just the focused one.
 *
 * Opening a live channel as the VOD the platform is already writing makes the
 * source an ordinary recording — `isLive` is false, because the media seeks and
 * exports like any other. The live fallback in `followerTargets` was gated on
 * `isLive` alone, so every follower fell through to the finished-recording
 * branch, where a target past its (already stale) length is `null`. A null
 * target is a tile reading "Not recording at this moment". The leader is
 * returned before any of those checks, so the wall showed a live picture for
 * exactly one angle: whichever was in focus.
 */
function source(id: string, over: Partial<VodSource> = {}): VodSource {
  return {
    id,
    platform: 'kick',
    url: `https://kick.com/${id}`,
    title: id,
    creator: id,
    durationSeconds: 3600,
    playbackKind: 'hls',
    // Both angles started at the same real-world instant, so local time and
    // event time line up and a follower's target equals the leader's.
    syncMapping: {
      vodStartRealTime: 1_780_000_000,
      offsetSeconds: 0,
      driftRate: 0,
      method: 'metadata',
      confidence: 1
    },
    ...over
  } as unknown as VodSource
}

describe('a wall of angles that are still broadcasting', () => {
  it('counts a still-recording VOD as on air', () => {
    expect(stillOnAir(source('a', { stillRecording: true }))).toBe(true)
    expect(stillOnAir(source('a', { isLive: true }))).toBe(true)
    expect(stillOnAir(source('a'))).toBe(false)
  })

  it('gives a follower its live edge rather than nothing, past its known length', () => {
    const leader = source('leader', { stillRecording: true, durationSeconds: 7200 })
    const follower = source('follower', { stillRecording: true, durationSeconds: 3600 })

    // The leader has played on past what the follower's length said when it
    // was resolved — which for a growing recording is a floor, not a limit.
    const targets = followerTargets([leader, follower], leader, 5000)
    expect(targets.get('follower')).not.toBeNull()
  })

  it('still says "not recording" for a finished VOD that really has ended', () => {
    const leader = source('leader', { durationSeconds: 7200 })
    const follower = source('follower', { durationSeconds: 3600 })
    expect(followerTargets([leader, follower], leader, 5000).get('follower')).toBeNull()
  })

  it('draws a still-recording angle as open-ended on the timeline', () => {
    const leader = source('leader', { stillRecording: true })
    const follower = source('follower', { stillRecording: true })
    const spans = povCoverage([leader, follower], leader)
    expect(spans.every((s) => s.isLive)).toBe(true)
  })
})
