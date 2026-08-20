import { describe, expect, it } from 'vitest'
import {
  isMasterPlaylist,
  parseAttributes,
  parseMaster,
  parseMedia,
  selectSegments,
  sortVariants
} from '../../src/main/media/hls.js'

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=6500000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.4d402a,mp4a.40.2",VIDEO="chunked",AUDIO="aac"
chunked/index-dvr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d401f,mp4a.40.2",VIDEO="720p60"
720p60/index-dvr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,FRAME-RATE=30.000,VIDEO="720p30"
720p30/index-dvr.m3u8
`

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.000,
0.ts
#EXTINF:10.000,
1.ts
#EXTINF:10.000,
2.ts
#EXT-X-DISCONTINUITY
#EXTINF:4.500,
3.ts
#EXTINF:10.000,
4.ts
#EXT-X-ENDLIST
`

const FMP4 = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
#EXT-X-BYTERANGE:100000@0
media.mp4
#EXTINF:6.000,
#EXT-X-BYTERANGE:120000
media.mp4
#EXT-X-ENDLIST
`

describe('playlist detection', () => {
  it('distinguishes master from media playlists', () => {
    expect(isMasterPlaylist(MASTER)).toBe(true)
    expect(isMasterPlaylist(MEDIA)).toBe(false)
  })
})

describe('parseAttributes', () => {
  it('handles quoted values containing commas', () => {
    const attrs = parseAttributes('BANDWIDTH=100,CODECS="avc1.4d402a,mp4a.40.2",NAME="a,b"')
    expect(attrs.BANDWIDTH).toBe('100')
    expect(attrs.CODECS).toBe('avc1.4d402a,mp4a.40.2')
    expect(attrs.NAME).toBe('a,b')
  })
})

describe('parseMaster', () => {
  const master = parseMaster(MASTER, 'https://cdn.invalid/vod/master.m3u8')

  it('resolves variant URIs against the playlist URL', () => {
    expect(master.variants[0].uri).toBe('https://cdn.invalid/vod/chunked/index-dvr.m3u8')
  })

  it('captures resolution, frame rate and bandwidth', () => {
    expect(master.variants[0]).toMatchObject({
      width: 1920,
      height: 1080,
      frameRate: 60,
      bandwidth: 8000000,
      averageBandwidth: 6500000
    })
  })

  it('captures alternate audio renditions', () => {
    expect(master.media[0]).toMatchObject({ type: 'AUDIO', groupId: 'aac', isDefault: true })
  })

  it('ranks variants best first, breaking ties on frame rate', () => {
    const ranked = sortVariants(master.variants)
    expect(ranked.map((v) => `${v.height}p${v.frameRate}`)).toEqual(['1080p60', '720p60', '720p30'])
  })
})

describe('parseMedia', () => {
  const media = parseMedia(MEDIA, 'https://cdn.invalid/vod/chunked/index-dvr.m3u8')

  it('builds a cumulative timeline from EXTINF', () => {
    expect(media.segments.map((s) => [s.startSeconds, s.endSeconds])).toEqual([
      [0, 10],
      [10, 20],
      [20, 30],
      [30, 34.5],
      [34.5, 44.5]
    ])
    expect(media.totalDurationSeconds).toBe(44.5)
    expect(media.endList).toBe(true)
  })

  it('records discontinuities', () => {
    expect(media.segments[3].discontinuity).toBe(true)
    expect(media.segments[0].discontinuity).toBe(false)
  })

  it('resolves segment URIs', () => {
    expect(media.segments[0].uri).toBe('https://cdn.invalid/vod/chunked/0.ts')
  })

  it('handles fMP4 init segments and implicit byte ranges', () => {
    const fmp4 = parseMedia(FMP4, 'https://cdn.invalid/vod/x.m3u8')
    expect(fmp4.segments[0].mapUri).toBe('https://cdn.invalid/vod/init.mp4')
    expect(fmp4.segments[0].byteRange).toEqual({ length: 100000, offset: 0 })
    expect(fmp4.segments[1].byteRange).toEqual({ length: 120000, offset: 100000 })
  })
})

describe('selectSegments — only the covering media is chosen', () => {
  const media = parseMedia(MEDIA, 'https://cdn.invalid/vod/chunked/index-dvr.m3u8')

  it('selects just the segments overlapping the range', () => {
    const selection = selectSegments(media, 12, 22)
    expect(selection.segments.map((s) => s.uri.split('/').pop())).toEqual(['1.ts', '2.ts'])
    expect(selection.windowStartSeconds).toBe(10)
    expect(selection.windowEndSeconds).toBe(30)
    expect(selection.offsetSeconds).toBe(2)
  })

  it('never selects the whole playlist for a short range', () => {
    const selection = selectSegments(media, 0.5, 1.5)
    expect(selection.segments).toHaveLength(1)
    expect(selection.totalDurationSeconds).toBe(10)
  })

  it('selects a single segment when the range sits inside one', () => {
    const selection = selectSegments(media, 31, 33)
    expect(selection.segments.map((s) => s.uri.split('/').pop())).toEqual(['3.ts'])
    expect(selection.offsetSeconds).toBe(1)
  })

  it('extends the window when padding is requested', () => {
    const selection = selectSegments(media, 12, 22, 5)
    expect(selection.segments).toHaveLength(3)
    expect(selection.windowStartSeconds).toBe(0)
  })

  it('does not fall off the end of the playlist', () => {
    const selection = selectSegments(media, 100, 110)
    expect(selection.segments).toHaveLength(1)
    expect(selection.segments[0].uri).toContain('4.ts')
  })

  it('returns nothing meaningful for an empty playlist rather than throwing', () => {
    const empty = parseMedia('#EXTM3U\n#EXT-X-ENDLIST\n', 'https://cdn.invalid/x.m3u8')
    expect(selectSegments(empty, 0, 10).segments).toHaveLength(0)
  })
})
