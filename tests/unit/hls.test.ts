import { describe, expect, it } from 'vitest'
import {
  durationFromPlaylist,
  isMasterPlaylist,
  parseAttributes,
  parseMaster,
  parseMedia,
  selectSegments,
  sortVariants
} from '../../src/main/media/hls.js'
import type { HlsVariant } from '../../src/main/media/hls.js'

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

/**
 * A live playlist, as a platform actually serves one: no ENDLIST, a
 * MEDIA-SEQUENCE that has already advanced, and a PROGRAM-DATE-TIME stamp.
 *
 * Both new fields exist for the same reason — a live playlist is a sliding
 * window, so nothing positional survives a refresh. Sequence numbers identify
 * media across polls; PROGRAM-DATE-TIME is what puts that media on the event
 * clock, which is the only clock a clip is stored against.
 */
const LIVE_MEDIA = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:4821
#EXT-X-PROGRAM-DATE-TIME:2026-08-29T14:30:00.000Z
#EXTINF:2.000,
4821.ts
#EXTINF:2.000,
4822.ts
#EXTINF:2.000,
4823.ts
`

describe('a live media playlist', () => {
  it('is live exactly when it has no ENDLIST', () => {
    expect(parseMedia(LIVE_MEDIA, 'https://x/live/').endList).toBe(false)
    expect(parseMedia(MEDIA, 'https://x/vod/').endList).toBe(true)
  })

  it('numbers segments from the media sequence, not from zero', () => {
    const p = parseMedia(LIVE_MEDIA, 'https://x/live/')
    expect(p.mediaSequence).toBe(4821)
    expect(p.segments.map((s) => s.sequence)).toEqual([4821, 4822, 4823])
  })

  it('keeps identifying the same media after the window slides', () => {
    // The window slid by one: the first segment is gone, a new one arrived,
    // and the server re-stamped PROGRAM-DATE-TIME onto the new first segment,
    // which is what a platform actually serves.
    const later = LIVE_MEDIA.replace('#EXT-X-MEDIA-SEQUENCE:4821', '#EXT-X-MEDIA-SEQUENCE:4822')
      .replace('2026-08-29T14:30:00.000Z', '2026-08-29T14:30:02.000Z')
      .replace('#EXTINF:2.000,\n4821.ts\n', '')
      .replace('4823.ts\n', '4823.ts\n#EXTINF:2.000,\n4824.ts\n')
    const first = parseMedia(LIVE_MEDIA, 'https://x/live/')
    const second = parseMedia(later, 'https://x/live/')

    // 4822 is the second segment in one poll and the first in the next. Its
    // position and its startSeconds both changed; its sequence did not.
    const a = first.segments.find((s) => s.sequence === 4822)!
    const b = second.segments.find((s) => s.sequence === 4822)!
    expect(a.startSeconds).not.toBe(b.startSeconds)
    expect(a.uri).toBe(b.uri)
    expect(a.programDateTime).toBe(b.programDateTime)
  })

  it('carries the wall clock forward across segments from one stamp', () => {
    const p = parseMedia(LIVE_MEDIA, 'https://x/live/')
    const base = Date.parse('2026-08-29T14:30:00.000Z') / 1000
    expect(p.segments.map((s) => s.programDateTime)).toEqual([base, base + 2, base + 4])
  })

  it('leaves the wall clock unset on a playlist that does not stamp one', () => {
    const p = parseMedia(MEDIA, 'https://x/vod/')
    expect(p.segments.every((s) => s.programDateTime === undefined)).toBe(true)
  })
})

describe('durationFromPlaylist', () => {
  const master: HlsVariant[] = [
    { uri: 'https://cdn.invalid/1080p60/playlist.m3u8', bandwidth: 8558474, width: 1920, height: 1080, frameRate: 60, codecs: 'avc1.64002A,mp4a.40.2' },
    { uri: 'https://cdn.invalid/480p30/playlist.m3u8', bandwidth: 1488983, width: 852, height: 480, frameRate: 30, codecs: 'avc1.4D401F,mp4a.40.2' },
    { uri: 'https://cdn.invalid/720p60/playlist.m3u8', bandwidth: 3483983, width: 1280, height: 720, frameRate: 60, codecs: 'avc1.4D401F,mp4a.40.2' }
  ]

  const media = (segments: number, endList: boolean): string =>
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:11',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      ...Array.from({ length: segments }, (_, i) => `#EXTINF:10.740,\n${i}.ts`),
      ...(endList ? ['#EXT-X-ENDLIST'] : [])
    ].join('\n')

  it('reads the length the platform would not tell us', async () => {
    // The real case: Kick answered `duration: 0` for a complete, public,
    // ENDLIST-terminated 1.11-hour recording, and a zero-length POV has no
    // span on the timeline and nothing to sync against.
    const asked: string[] = []
    const seconds = await durationFromPlaylist(master, async (url) => {
      asked.push(url)
      return media(372, true)
    })
    expect(seconds).toBeCloseTo(372 * 10.74, 1)
    expect(seconds! / 3600).toBeCloseTo(1.11, 2)
  })

  it('asks the cheapest rendition — every variant lists the same segments', async () => {
    const asked: string[] = []
    await durationFromPlaylist(master, async (url) => {
      asked.push(url)
      return media(10, true)
    })
    expect(asked).toEqual(['https://cdn.invalid/480p30/playlist.m3u8'])
  })

  it('reports what a still-growing playlist has published', async () => {
    // No ENDLIST: the sum is a floor that moves, which is what
    // `durationSeconds` already means for a live source.
    const seconds = await durationFromPlaylist(master, async () => media(50, false))
    expect(seconds).toBeCloseTo(537, 0)
  })

  it('keeps quiet rather than failing a resolve it cannot confirm', async () => {
    await expect(
      durationFromPlaylist(master, async () => {
        throw new Error('network down')
      })
    ).resolves.toBeUndefined()
    await expect(durationFromPlaylist(master, async () => '#EXTM3U\n')).resolves.toBeUndefined()
    await expect(durationFromPlaylist([], async () => media(5, true))).resolves.toBeUndefined()
  })
})
