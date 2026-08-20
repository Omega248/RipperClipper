import { describe, expect, it } from 'vitest'
import { KickAdapter, matchVodByStartTime, vodTimestampFromId } from '../../src/main/platforms/kick.js'
import type { KickChannelVideo } from '../../src/main/platforms/kick.js'
import { toStreamInfos } from '../../src/main/media/resolver.js'

/**
 * Kick's own video document + master playlist must produce exactly what the
 * rest of the pipeline expects from yt-dlp, or the fallback is useless.
 */

const API = {
  id: '52731',
  uuid: '01a00c92-5600-7726-bca4-403b6524da32',
  source: 'https://stream.kick.com/ivs/v1/vod/abc/master.m3u8',
  created_at: '2026-08-16T19:04:11.000Z',
  livestream: {
    session_title: 'NoPixel | Day 3',
    slug: 'nopixel-day-3',
    duration: 21_600_000,
    thumbnail: { url: 'https://images.kick.com/thumb.jpg' },
    channel: { slug: 'somestreamer', user: { username: 'SomeStreamer' } }
  }
}

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6221000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.640028,mp4a.40.2",NAME="1080p60"
1080p60/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3221000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.64001f,mp4a.40.2",NAME="720p60"
720p60/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=898000,RESOLUTION=852x480,FRAME-RATE=30.000,CODECS="avc1.4d001f,mp4a.40.2",NAME="480p"
480p/playlist.m3u8
`

const master = { text: MASTER, url: API.source }

describe('Kick direct resolution', () => {
  it('maps the video document onto the resolver shape', () => {
    const raw = new KickAdapter().fromApi(API, master)
    expect(raw.title).toBe('NoPixel | Day 3')
    expect(raw.uploader).toBe('SomeStreamer')
    expect(raw.channel).toBe('somestreamer')
    expect(raw.duration).toBe(21_600)
    expect(raw.thumbnail).toBe('https://images.kick.com/thumb.jpg')
    expect(raw.is_live).toBe(false)
    expect(raw.webpage_url).toBe(
      'https://kick.com/somestreamer/videos/01a00c92-5600-7726-bca4-403b6524da32'
    )
  })

  it('turns master variants into usable HLS formats, best first', () => {
    const raw = new KickAdapter().fromApi(API, master)
    const formats = toStreamInfos(raw)
    expect(formats).toHaveLength(3)
    expect(formats[0].height).toBe(1080)
    expect(formats[0].fps).toBe(60)
    expect(formats[0].protocol).toBe('hls')
    expect(formats[0].url).toBe(
      'https://stream.kick.com/ivs/v1/vod/abc/1080p60/playlist.m3u8'
    )
    // Kick muxes audio into each variant, so every format must claim both.
    expect(formats.every((f) => f.hasVideo && f.hasAudio)).toBe(true)
    expect(formats[0].codec).toBe('avc1.640028')
  })

  it('builds a source the editor can use', () => {
    const adapter = new KickAdapter()
    const match = adapter.match(
      'https://kick.com/somestreamer/videos/01a00c92-5600-7726-bca4-403b6524da32'
    )!
    const source = adapter.buildSource(match, adapter.fromApi(API, master))
    expect(source.platform).toBe('kick')
    expect(source.durationSeconds).toBe(21_600)
    expect(source.playbackKind).toBe('hls')
    expect(source.playbackUrl).toContain('1080p60')
    expect(source.createdAt).toBe('2026-08-16T19:04:11.000Z')
  })

  it('accepts the short /video/<uuid> link yt-dlp cannot match', () => {
    const match = new KickAdapter().match(
      'https://kick.com/video/01a00c92-5600-7726-bca4-403b6524da32'
    )
    expect(match?.vodId).toBe('01a00c92-5600-7726-bca4-403b6524da32')
  })
})

/**
 * Kick's new VOD links (August 2026) carry a UUIDv7 whose timestamp is the
 * broadcast start; the video API still keys off the old random UUIDs. These
 * numbers are from a live VOD checked against Kick's own endpoints:
 * kick.com/restt/videos/019f8589-dea8-7855-9a53-38df793bd1fb started at
 * 2026-07-21T16:37:13Z, and that channel's list holds exactly one broadcast at
 * that instant, video uuid 3aaa767a-a079-4f64-b8bf-b2f783f88288.
 */
describe('new-style Kick VOD links', () => {
  const CHANNEL_VIDEOS: KickChannelVideo[] = [
    { id: 122232616, start_time: '2026-08-14 16:02:28', video: { uuid: 'c8abef98-7b4f-4b52-b5c3-d94375012324' } },
    { id: 119640922, start_time: '2026-07-22 16:55:29', video: { uuid: '25c5b2d6-2d2e-47e9-8f35-992751f6dd53' } },
    { id: 119480021, start_time: '2026-07-21 16:37:13', video: { uuid: '3aaa767a-a079-4f64-b8bf-b2f783f88288' } },
    { id: 119320011, start_time: '2026-07-20 16:58:19', video: { uuid: '91c9a270-20fb-4679-90c1-3e78853e46fa' } }
  ]

  it('reads the broadcast start out of a v7 link id', () => {
    expect(vodTimestampFromId('019f8589-dea8-7855-9a53-38df793bd1fb')).toBe(
      Date.parse('2026-07-21T16:37:13.000Z')
    )
  })

  it('leaves old random ids alone', () => {
    expect(vodTimestampFromId('3aaa767a-a079-4f64-b8bf-b2f783f88288')).toBeNull()
    expect(vodTimestampFromId('not-a-uuid')).toBeNull()
  })

  it('maps the link back to the video id Kick will accept', () => {
    const ms = vodTimestampFromId('019f8589-dea8-7855-9a53-38df793bd1fb')!
    expect(matchVodByStartTime(CHANNEL_VIDEOS, ms)?.video?.uuid).toBe(
      '3aaa767a-a079-4f64-b8bf-b2f783f88288'
    )
  })

  it('refuses a near miss rather than opening the wrong broadcast', () => {
    const dayEarlier = Date.parse('2026-07-21T16:37:13.000Z') - 20 * 60 * 1000
    expect(matchVodByStartTime(CHANNEL_VIDEOS, dayEarlier)).toBeNull()
  })

  it('takes the closest broadcast when two are within tolerance', () => {
    const near: KickChannelVideo[] = [
      { start_time: '2026-07-21 16:36:30', video: { uuid: 'earlier' } },
      { start_time: '2026-07-21 16:37:10', video: { uuid: 'closest' } }
    ]
    const ms = vodTimestampFromId('019f8589-dea8-7855-9a53-38df793bd1fb')!
    expect(matchVodByStartTime(near, ms)?.video?.uuid).toBe('closest')
  })
})
