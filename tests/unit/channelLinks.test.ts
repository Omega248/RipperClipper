import { describe, expect, it } from 'vitest'
import { TwitchAdapter } from '../../src/main/platforms/twitch.js'

/**
 * A link to someone's channel is a link to their recordings.
 *
 * `twitch.tv/<login>/videos?filter=archives` is the page a person is actually
 * looking at when they go to find someone's VODs, and pasting it answered
 * "That link is not a Twitch, Kick or YouTube VOD address" — wrong, and
 * unhelpful about a twitch.tv address. The listing tab is not part of the
 * identity: all of these mean the same channel, which now opens the broadcast
 * in progress, or their newest recording if they are offline.
 */
const twitch = new TwitchAdapter()

describe('Twitch channel links', () => {
  it.each([
    'https://www.twitch.tv/thedlinquent',
    'https://www.twitch.tv/TheDlinQuenT/videos?filter=archives',
    'https://www.twitch.tv/thedlinquent/clips',
    'https://m.twitch.tv/thedlinquent/about'
  ])('reads %s as that channel', (url) => {
    const match = twitch.match(url)
    expect(match?.kind).toBe('channel')
    expect(match?.vodId).toBe('thedlinquent')
  })

  it('still reads a VOD link as a VOD', () => {
    const match = twitch.match('https://www.twitch.tv/videos/2863286849')
    expect(match?.kind).toBe('vod')
    expect(match?.vodId).toBe('2863286849')
  })

  it('does not read Twitch\'s own pages as people', () => {
    expect(twitch.match('https://www.twitch.tv/directory/game/GTA%20V')).toBeNull()
    expect(twitch.match('https://www.twitch.tv/settings/profile')).toBeNull()
  })

  it('does not read a deeper path as a channel', () => {
    // Only the listing tabs; anything else is a page this app does not know.
    expect(twitch.match('https://www.twitch.tv/thedlinquent/videos/extra')).toBeNull()
  })
})
