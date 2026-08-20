import { describe, expect, it } from 'vitest'
import { proxyUrl, rewritePlaylist } from '../../src/main/mediaProxy.js'

const BASE = 'http://127.0.0.1:5000'

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.4d402a,mp4a.40.2"
chunked/index-dvr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
https://other.cdn.invalid/720p/index.m3u8
`

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.invalid/k1",IV=0x00
#EXTINF:10.000,
0.ts
#EXTINF:10.000,
../shared/1.ts
#EXT-X-ENDLIST
`

/** searchParams already percent-decodes, so this must not decode a second time. */
function decode(url: string): string {
  return new URL(url).searchParams.get('u') ?? ''
}

describe('proxyUrl', () => {
  it('encodes the target so query strings survive intact', () => {
    const target = 'https://cdn.invalid/x.m3u8?sig=a&b=c%20d'
    expect(decode(proxyUrl(BASE, 'manifest', target))).toBe(target)
  })

  it('routes manifests and segments to different endpoints', () => {
    expect(proxyUrl(BASE, 'manifest', 'https://x.invalid/a')).toContain('/media/manifest?')
    expect(proxyUrl(BASE, 'segment', 'https://x.invalid/a')).toContain('/media/segment?')
  })

  it('tolerates a base with a trailing slash', () => {
    expect(proxyUrl(`${BASE}/`, 'segment', 'https://x.invalid/a').startsWith(`${BASE}/media`)).toBe(
      true
    )
  })
})

describe('rewritePlaylist — master', () => {
  const out = rewritePlaylist(MASTER, 'https://cdn.invalid/vod/master.m3u8', BASE)
  const lines = out.split('\n')

  it('sends variant playlists back through the manifest endpoint', () => {
    const variants = lines.filter((l) => l.includes('/media/manifest?'))
    expect(variants).toHaveLength(3) // audio rendition + two variants
  })

  it('resolves relative variant URIs against the playlist URL', () => {
    const variant = lines.find((l) => l.startsWith(`${BASE}/media/manifest?`))!
    expect(decode(variant)).toBe('https://cdn.invalid/vod/chunked/index-dvr.m3u8')
  })

  it('leaves absolute variant URIs pointing at the right host', () => {
    const absolute = lines.filter((l) => l.startsWith(`${BASE}/media/manifest?`)).map(decode)
    expect(absolute).toContain('https://other.cdn.invalid/720p/index.m3u8')
  })

  it('rewrites the audio rendition URI in place, keeping its attributes', () => {
    const media = lines.find((l) => l.startsWith('#EXT-X-MEDIA:'))!
    expect(media).toContain('TYPE=AUDIO')
    expect(media).toContain('GROUP-ID="aac"')
    expect(media).toContain('/media/manifest?')
  })

  it('preserves every tag line', () => {
    expect(out).toContain('#EXT-X-STREAM-INF:BANDWIDTH=8000000')
    expect(out.startsWith('#EXTM3U')).toBe(true)
  })
})

describe('rewritePlaylist — media', () => {
  const out = rewritePlaylist(MEDIA, 'https://cdn.invalid/vod/chunked/index.m3u8', BASE)
  const lines = out.split('\n')

  it('sends segments through the segment endpoint', () => {
    const segments = lines.filter((l) => l.startsWith(`${BASE}/media/segment?`))
    expect(segments.map(decode)).toEqual([
      'https://cdn.invalid/vod/chunked/0.ts',
      'https://cdn.invalid/vod/shared/1.ts'
    ])
  })

  it('rewrites the init segment', () => {
    const map = lines.find((l) => l.startsWith('#EXT-X-MAP:'))!
    expect(map).toContain('/media/segment?')
    expect(decode(/URI="([^"]+)"/.exec(map)![1])).toBe('https://cdn.invalid/vod/chunked/init.mp4')
  })

  it('rewrites encryption key URIs without touching the other attributes', () => {
    const key = lines.find((l) => l.startsWith('#EXT-X-KEY:'))!
    expect(key).toContain('METHOD=AES-128')
    expect(key).toContain('IV=0x00')
    expect(decode(/URI="([^"]+)"/.exec(key)![1])).toBe('https://keys.invalid/k1')
  })

  it('keeps durations and the end marker', () => {
    expect(out).toContain('#EXTINF:10.000,')
    expect(out).toContain('#EXT-X-ENDLIST')
  })

  it('leaves unknown tags and CRLF playlists untouched', () => {
    const crlf = '#EXTM3U\r\n#EXT-X-CUSTOM-TAG:hello\r\n#EXTINF:4.0,\r\nseg.ts\r\n'
    const rewritten = rewritePlaylist(crlf, 'https://cdn.invalid/v/i.m3u8', BASE)
    expect(rewritten).toContain('#EXT-X-CUSTOM-TAG:hello')
    expect(rewritten).toContain('#EXTINF:4.0,')
    const segment = rewritten.split('\n').find((l) => l.startsWith(`${BASE}/media/segment?`))!
    expect(decode(segment)).toBe('https://cdn.invalid/v/seg.ts')
  })
})
