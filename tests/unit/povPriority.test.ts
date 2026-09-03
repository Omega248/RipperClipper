import { describe, expect, it } from 'vitest'
import {
  byPlatformPriority,
  oneAnglePerStreamer,
  personKey,
  platformRank
} from '../../src/shared/povPriority.js'

/**
 * A restreamer is on three sites at once with the same footage. The matcher
 * sees three broadcasts that all cover the moment; the editor wants one angle.
 */
describe('one angle per streamer', () => {
  const candidates = [
    { name: 'Leonarwho', platform: 'youtube', fraction: 1 },
    { name: 'Leonarwho', platform: 'twitch', fraction: 1 },
    { name: 'Leonarwho', platform: 'kick', fraction: 1 },
    { name: 'uhsnow', platform: 'kick', fraction: 1 }
  ]
  const read = {
    key: (c: (typeof candidates)[number]) => personKey({ streamerName: c.name }),
    platform: (c: (typeof candidates)[number]) => c.platform
  }

  it('collapses a simulcast to one, and takes Twitch', () => {
    const kept = oneAnglePerStreamer(candidates, read)
    expect(kept).toHaveLength(2)
    expect(kept.find((c) => c.name === 'Leonarwho')?.platform).toBe('twitch')
  })

  it('keeps the position the better platform did not have', () => {
    // Leonarwho was first in the list on YouTube; the Twitch entry takes that
    // slot rather than jumping to wherever Twitch happened to appear.
    const kept = oneAnglePerStreamer(candidates, read)
    expect(kept.map((c) => c.name)).toEqual(['Leonarwho', 'uhsnow'])
  })

  it('lets a better match beat a better platform', () => {
    // A Twitch VOD that only clips the edge must not displace a Kick VOD that
    // covers the whole moment: platform breaks ties, it does not overrule.
    const mixed = [
      { name: 'Leonarwho', platform: 'twitch', fraction: 0.2 },
      { name: 'Leonarwho', platform: 'kick', fraction: 1 }
    ]
    const kept = oneAnglePerStreamer(mixed, {
      ...read,
      better: (a, b) => b.fraction - a.fraction
    })
    expect(kept).toHaveLength(1)
    expect(kept[0].platform).toBe('kick')
  })

  it('keeps two different people with the same platform', () => {
    const kept = oneAnglePerStreamer(
      [
        { name: 'a', platform: 'twitch', fraction: 1 },
        { name: 'b', platform: 'twitch', fraction: 1 }
      ],
      read
    )
    expect(kept).toHaveLength(2)
  })

  it('treats the library’s person link as the truth when there is one', () => {
    const linked = [
      { name: 'Silbullet', id: 's1', platform: 'youtube' },
      { name: 'SilbulletLIVE', id: 's2', platform: 'twitch' }
    ]
    // Two different display names, one human — only the library knows that.
    const kept = oneAnglePerStreamer(linked, {
      key: (c) => personKey({ streamerId: c.id, streamerName: c.name }, () => 'p1'),
      platform: (c) => c.platform
    })
    expect(kept).toHaveLength(1)
    expect(kept[0].platform).toBe('twitch')
  })

  it('ignores case and spacing in a name', () => {
    expect(personKey({ streamerName: 'The DlinQuenT' })).toBe(personKey({ streamerName: 'thedlinquent' }))
  })

  it('is empty in, empty out', () => {
    expect(oneAnglePerStreamer([], read)).toEqual([])
  })
})

describe('platform order', () => {
  it('is Twitch, Kick, YouTube', () => {
    expect(platformRank('twitch')).toBeLessThan(platformRank('kick'))
    expect(platformRank('kick')).toBeLessThan(platformRank('youtube'))
    expect(['youtube', 'twitch', 'kick'].sort(byPlatformPriority)).toEqual([
      'twitch',
      'kick',
      'youtube'
    ])
  })

  it('puts anything it does not recognise last rather than first', () => {
    expect(platformRank('vimeo')).toBeGreaterThan(platformRank('youtube'))
  })
})

/**
 * The dedupe has to hold in the three places a POV can be added, and the
 * behaviour they share is the interesting part: a person already on the wall
 * is not a candidate on any other platform either.
 */
describe('a person already loaded', () => {
  it('is not offered again under a different platform', () => {
    const loaded = new Set([personKey({ streamerName: 'Leonarwho' })])
    const candidates = [
      { streamerName: 'Leonarwho', platform: 'twitch' },
      { streamerName: 'uhsnow', platform: 'kick' }
    ]
    const fresh = candidates.filter((c) => !loaded.has(personKey(c)))
    expect(fresh.map((c) => c.streamerName)).toEqual(['uhsnow'])
  })
})
