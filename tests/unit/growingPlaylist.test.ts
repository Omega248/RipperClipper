import { describe, expect, it } from 'vitest'
import { rewritePlaylist } from '../../src/main/mediaProxy.js'
import { mediaProxyUrl } from '../../src/shared/mediaProxyUrl.js'

/**
 * A recording that is still being written must not advertise its own end.
 *
 * A player stops re-reading a media playlist the moment it sees
 * `#EXT-X-ENDLIST`: the list is final, so there is nothing to fetch. Kick's
 * in-progress recordings carry it anyway — verified against a live channel,
 * `#EXT-X-PLAYLIST-TYPE:EVENT` and `#EXT-X-MEDIA-SEQUENCE:0` *and*
 * `#EXT-X-ENDLIST`, while the broadcast was plainly still running. So playback
 * ran to whatever the recording held when the angle was loaded and stopped
 * dead: the buffer ended and nothing ever asked for more.
 *
 * Dropping the marker while the broadcast is on air is what lets hls.js do its
 * own job — re-read the playlist, append what has appeared, keep playing —
 * with no seeking, no reloading and no re-creating the player.
 */
const BASE = 'http://127.0.0.1:9000'
const MEDIA = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-PLAYLIST-TYPE:EVENT',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXTINF:10.0,',
  '0.ts',
  '#EXTINF:10.0,',
  '1.ts',
  '#EXT-X-ENDLIST'
].join('\n')

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=9356760,RESOLUTION=1920x1080,FRAME-RATE=60.000',
  '1080p60/playlist.m3u8'
].join('\n')

const url = 'https://cdn.invalid/media/hls/1080p60/playlist.m3u8'

describe('a playlist for a recording that is still growing', () => {
  it('keeps the end marker for a finished recording', () => {
    expect(rewritePlaylist(MEDIA, url, BASE)).toContain('#EXT-X-ENDLIST')
  })

  it('drops the end marker while the broadcast is on air', () => {
    const out = rewritePlaylist(MEDIA, url, BASE, true)
    expect(out).not.toContain('#EXT-X-ENDLIST')
    // Everything else survives: this removes one line, it does not rebuild.
    expect(out).toContain('#EXT-X-PLAYLIST-TYPE:EVENT')
    expect(out).toContain('#EXT-X-TARGETDURATION:10')
    expect(out.match(/\/media\/segment\?/g)).toHaveLength(2)
  })

  it('carries "still growing" down to the variant playlists of a master', () => {
    const out = rewritePlaylist(MASTER, 'https://cdn.invalid/media/hls/master.m3u8', BASE, true)
    expect(out).toContain('growing=1')
  })

  it('does not mark variants of a finished recording as growing', () => {
    const out = rewritePlaylist(MASTER, 'https://cdn.invalid/media/hls/master.m3u8', BASE)
    expect(out).not.toContain('growing=1')
  })

  it('only says so in the URL when asked', () => {
    expect(mediaProxyUrl(BASE, 'tok', 'manifest', url)).not.toContain('growing')
    expect(mediaProxyUrl(BASE, 'tok', 'manifest', url, true)).toContain('&growing=1')
  })
})
