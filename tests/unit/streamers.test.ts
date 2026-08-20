import { describe, expect, it } from 'vitest'
import { channelHandleFrom } from '../../src/main/services/sources.js'
import {
  channelVideosUrl,
  kickVodsFromChannel,
  parseChannelUrl,
  sameStreamer,
  vodsFromFlatPlaylist
} from '../../src/main/services/streamers.js'
import type { SavedStreamer } from '../../src/shared/ipc.js'

describe('channel links', () => {
  it('recognises channel pages on every platform', () => {
    expect(parseChannelUrl('https://www.twitch.tv/somestreamer')).toEqual({
      platform: 'twitch',
      handle: 'somestreamer'
    })
    expect(parseChannelUrl('kick.com/somestreamer')).toEqual({
      platform: 'kick',
      handle: 'somestreamer'
    })
    expect(parseChannelUrl('https://www.youtube.com/@somestreamer/streams')).toEqual({
      platform: 'youtube',
      handle: 'somestreamer'
    })
  })

  it('refuses VOD links, so a clip source is never saved as a channel', () => {
    expect(parseChannelUrl('https://www.twitch.tv/videos/123456')).toBeNull()
    expect(parseChannelUrl('https://kick.com/video/01a00c92-5600-7726-bca4-403b6524da32')).toBeNull()
    expect(parseChannelUrl('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(parseChannelUrl('not a url')).toBeNull()
  })

  it('points at each platform archive listing', () => {
    expect(channelVideosUrl('twitch', 'name')).toBe('https://www.twitch.tv/name/videos?filter=archives')
    expect(channelVideosUrl('youtube', '@name')).toBe('https://www.youtube.com/@name/streams')
    expect(channelVideosUrl('kick', 'name')).toBe('https://kick.com/name')
  })

  it('treats the same channel as the same streamer regardless of case', () => {
    const saved: SavedStreamer = {
      id: 's1',
      platform: 'twitch',
      handle: 'SomeStreamer',
      displayName: 'SomeStreamer',
      channelUrl: 'https://www.twitch.tv/SomeStreamer/videos?filter=archives',
      addedAt: '2026-08-01T00:00:00.000Z',
      lastUsedAt: null
    }
    expect(sameStreamer(saved, { platform: 'twitch', handle: 'somestreamer' })).toBe(true)
    expect(sameStreamer(saved, { platform: 'kick', handle: 'somestreamer' })).toBe(false)
  })
})

describe('recent VOD listings', () => {
  it('maps Kick channel videos to loadable links', () => {
    const vods = kickVodsFromChannel(
      [
        {
          session_title: 'NoPixel | Day 3',
          duration: 21_600_000,
          views: 4210,
          start_time: '2026-08-16 21:55:12',
          thumbnail: { src: 'https://images.kick.com/a.jpg' },
          video: { uuid: '3aaa767a-a079-4f64-b8bf-b2f783f88288' }
        },
        { session_title: 'no video record', duration: 100 }
      ],
      'somestreamer'
    )
    expect(vods).toHaveLength(1)
    expect(vods[0].url).toBe(
      'https://kick.com/somestreamer/videos/3aaa767a-a079-4f64-b8bf-b2f783f88288'
    )
    expect(vods[0].durationSeconds).toBe(21_600)
    expect(vods[0].publishedAt).toBe('2026-08-16T21:55:12.000Z')
    expect(vods[0].viewCount).toBe(4210)
  })

  it('maps a yt-dlp flat playlist and skips anything still live', () => {
    const vods = vodsFromFlatPlaylist({
      entries: [
        {
          url: 'https://www.twitch.tv/videos/111',
          title: 'Ranked session',
          duration: 3600.4,
          timestamp: 1_786_917_312
        },
        { url: 'https://www.twitch.tv/somestreamer', title: 'LIVE now', live_status: 'is_live' },
        { title: 'no url at all' }
      ]
    })
    expect(vods).toHaveLength(1)
    expect(vods[0].durationSeconds).toBe(3600)
    expect(vods[0].publishedAt).toBe(new Date(1_786_917_312 * 1000).toISOString())
  })

  it('accepts YouTube upload dates, which have no clock time', () => {
    const vods = vodsFromFlatPlaylist({
      entries: [{ url: 'https://youtu.be/abc', title: 'Stream', upload_date: '20260816' }]
    })
    expect(vods[0].publishedAt).toBe('2026-08-16T00:00:00.000Z')
  })

  it('returns nothing rather than throwing on an unexpected payload', () => {
    expect(kickVodsFromChannel(null, 'x')).toEqual([])
    expect(vodsFromFlatPlaylist({ nope: true })).toEqual([])
  })
})

describe('loading a POV remembers its streamer', () => {
  it('takes the handle from the resolver metadata, not the display name', () => {
    expect(
      channelHandleFrom({ uploader: 'Some Streamer', uploader_id: 'somestreamer' }, 'https://www.twitch.tv/videos/1')
    ).toBe('somestreamer')
  })

  it('prefers the channel slug in a Kick link', () => {
    expect(
      channelHandleFrom(
        { uploader: 'Some Streamer', uploader_id: '12345' },
        'https://kick.com/somestreamer/videos/01a00c92-5600-7726-bca4-403b6524da32'
      )
    ).toBe('somestreamer')
  })

  it('strips a leading @ from a YouTube handle', () => {
    expect(channelHandleFrom({ uploader_id: '@somestreamer' }, 'https://youtu.be/abc')).toBe(
      'somestreamer'
    )
  })

  it('refuses a handle with spaces, which would make a dead channel link', () => {
    expect(channelHandleFrom({ uploader: 'Some Streamer' }, 'https://youtu.be/abc')).toBeUndefined()
  })
})
