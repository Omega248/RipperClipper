import { describe, expect, it } from 'vitest'
import { momentOf, parseClipLink, parseTimeParam } from '../../src/shared/clipLink.js'
import { atRisk, byUrgency, estimateExpiry } from '../../src/shared/expiry.js'

/**
 * Starting from a shared link, and knowing what is about to disappear.
 *
 * The invariant across both: never invent a time. A link that cannot be
 * placed on the clock, or a VOD whose age is unknown, must say so — a wrong
 * time seeds a search that quietly returns the wrong POVs.
 */

describe('parsing a link that points at a moment', () => {
  it('reads a clips.twitch.tv link', () => {
    const link = parseClipLink('https://clips.twitch.tv/BraveTastySalmonKappa')!
    expect(link.platform).toBe('twitch')
    expect(link.kind).toBe('clip')
    expect(link.id).toBe('BraveTastySalmonKappa')
  })

  it('reads a channel-scoped Twitch clip and keeps the channel', () => {
    const link = parseClipLink('https://www.twitch.tv/somestreamer/clip/CoolSlug')!
    expect(link.kind).toBe('clip')
    expect(link.id).toBe('CoolSlug')
    expect(link.channel).toBe('somestreamer')
  })

  it('reads a Twitch VOD link with an offset', () => {
    const link = parseClipLink('https://www.twitch.tv/videos/123456789?t=1h2m3s')!
    expect(link.kind).toBe('vod')
    expect(link.id).toBe('123456789')
    expect(link.offsetSeconds).toBe(3723)
  })

  it('reads Kick clips and VODs', () => {
    expect(parseClipLink('https://kick.com/someone/clips/clip_abc')!.kind).toBe('clip')
    const vod = parseClipLink('https://kick.com/someone/videos/uuid-1234?t=90')!
    expect(vod.kind).toBe('vod')
    expect(vod.offsetSeconds).toBe(90)
    expect(vod.channel).toBe('someone')
  })

  it('reads YouTube in its several shapes', () => {
    expect(parseClipLink('https://youtu.be/abc123?t=45')!.offsetSeconds).toBe(45)
    expect(parseClipLink('https://www.youtube.com/watch?v=abc123&t=45')!.id).toBe('abc123')
    expect(parseClipLink('https://www.youtube.com/live/abc123')!.id).toBe('abc123')
  })

  it('accepts a link pasted without a scheme', () => {
    expect(parseClipLink('twitch.tv/videos/999')!.id).toBe('999')
  })

  it('returns null for anything it cannot place, rather than guessing', () => {
    expect(parseClipLink('https://twitch.tv/somechannel')).toBeNull()
    expect(parseClipLink('https://example.com/whatever')).toBeNull()
    expect(parseClipLink('not a url at all')).toBeNull()
    expect(parseClipLink('')).toBeNull()
  })

  it('parses the several time formats, and rejects nonsense', () => {
    expect(parseTimeParam('3600')).toBe(3600)
    expect(parseTimeParam('1h30m')).toBe(5400)
    expect(parseTimeParam('45s')).toBe(45)
    expect(parseTimeParam('banana')).toBeUndefined()
    expect(parseTimeParam(null)).toBeUndefined()
  })
})

describe('resolving a link to a real-world instant', () => {
  it('adds the offset to the broadcast start', () => {
    const at = momentOf('2026-08-21T18:00:00Z', 3600)!
    expect(at).toBe(Date.parse('2026-08-21T19:00:00Z') / 1000)
  })

  it('refuses to place a moment when either half is missing', () => {
    expect(momentOf(null, 60)).toBeNull()
    expect(momentOf('2026-08-21T18:00:00Z', null)).toBeNull()
    expect(momentOf('nonsense', 60)).toBeNull()
  })
})

describe('how long a broadcast has left', () => {
  const now = Date.parse('2026-08-21T00:00:00Z')
  const daysAgo = (n: number): string => new Date(now - n * 86_400_000).toISOString()

  it('treats YouTube as permanent', () => {
    const e = estimateExpiry('youtube', daysAgo(400), now)
    expect(e.urgency).toBe('permanent')
    expect(e.daysLeft).toBeNull()
  })

  it('counts a fresh Twitch VOD down from 14 days', () => {
    const e = estimateExpiry('twitch', daysAgo(1), now)
    expect(e.urgency).toBe('safe')
    expect(e.daysLeft).toBe(13)
  })

  it('flags a Twitch VOD near the end as critical', () => {
    expect(estimateExpiry('twitch', daysAgo(12), now).urgency).toBe('critical')
    expect(estimateExpiry('twitch', daysAgo(9), now).urgency).toBe('soon')
  })

  it('says an old Twitch VOD may already be gone', () => {
    const e = estimateExpiry('twitch', daysAgo(30), now)
    expect(e.urgency).toBe('gone')
    expect(e.daysLeft).toBe(0)
  })

  it('assumes the shorter Twitch window, because guessing long loses footage', () => {
    // 20 days old is safe under a 60-day policy but gone under 14.
    expect(estimateExpiry('twitch', daysAgo(20), now).urgency).toBe('gone')
  })

  it('reports an unknown date as unknown rather than inventing a deadline', () => {
    const e = estimateExpiry('twitch', null, now)
    expect(e.urgency).toBe('unknown')
    expect(e.daysLeft).toBeNull()
  })

  it('never claims certainty — these are policies, not per-VOD facts', () => {
    for (const p of ['twitch', 'kick', 'youtube'] as const) {
      expect(estimateExpiry(p, daysAgo(1), now).certain).toBe(false)
    }
  })

  it('sorts the most at-risk first', () => {
    const estimates = [
      estimateExpiry('youtube', daysAgo(1), now),
      estimateExpiry('twitch', daysAgo(30), now),
      estimateExpiry('twitch', daysAgo(12), now),
      estimateExpiry('twitch', daysAgo(1), now)
    ].sort(byUrgency)
    expect(estimates.map((e) => e.urgency)).toEqual(['gone', 'critical', 'safe', 'permanent'])
  })

  it('marks exactly the ones worth archiving now', () => {
    expect(atRisk(estimateExpiry('twitch', daysAgo(12), now))).toBe(true)
    expect(atRisk(estimateExpiry('twitch', daysAgo(1), now))).toBe(false)
    expect(atRisk(estimateExpiry('youtube', daysAgo(1), now))).toBe(false)
  })
})
