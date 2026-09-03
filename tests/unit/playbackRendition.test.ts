import { describe, expect, it } from 'vitest'
import { KickAdapter } from '../../src/main/platforms/kick.js'
import { TwitchAdapter } from '../../src/main/platforms/twitch.js'
import { isMasterPlaylist } from '../../src/main/media/hls.js'
import { masterPlaylistFor } from '../../src/shared/mediaProxyUrl.js'
import { normalizeProject } from '../../src/main/services/projects.js'

/**
 * Playback must be handed the master playlist, not the biggest rung.
 *
 * `playbackUrl` used to be the highest variant's URL — a *media* playlist with
 * exactly one rendition in it. Every mechanism that exists to pick a smaller
 * one then had nothing to pick from: hls.js's `capLevelToPlayerSize` saw a
 * single level, and the native tile decoder's `variantForTile` never ran at
 * all, because the playlist it was handed was not a master. Every angle
 * decoded 1080p60 whatever size it was drawn at, on every wall.
 *
 * That is what "the wall is not smooth" was, and nothing in the suite could
 * see it, because every test fed the adapters a master and asked about
 * `formats`.
 */

const MASTER_URL = 'https://cdn.invalid/vod/master.m3u8'
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8558474,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002A,mp4a.40.2",VIDEO="1080p60"
1080p60/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3483983,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60"
720p60/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1488983,RESOLUTION=852x480,FRAME-RATE=30.000,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="480p30"
480p30/playlist.m3u8
`

describe('what the player is handed', () => {
  it('is a master playlist for Kick, not the 1080p60 rung', () => {
    const adapter = new KickAdapter()
    const match = adapter.match('https://kick.com/someone/videos/06803c68-bf07-46cc-855c-bf02f1f7d593')!
    const raw = adapter.fromApi(
      { uuid: '06803c68-bf07-46cc-855c-bf02f1f7d593', source: MASTER_URL, livestream: {} } as never,
      { text: MASTER, url: MASTER_URL }
    )
    const source = adapter.buildSource(match, raw)

    expect(source.playbackUrl).toBe(MASTER_URL)
    expect(source.playbackUrl).not.toContain('1080p60/playlist.m3u8')
    // Every rung still reachable for export and for the tile decoder.
    expect(raw.formats?.map((f) => f.height).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      480, 720, 1080
    ])
  })

  it('is a master playlist for Twitch too', () => {
    const adapter = new TwitchAdapter()
    const raw = adapter.fromApi(
      { id: '123', lengthSeconds: 60 } as never,
      { text: MASTER, url: MASTER_URL },
      'https://www.twitch.tv/videos/123'
    )
    const source = adapter.buildSource(
      adapter.match('https://www.twitch.tv/videos/123')!,
      raw
    )
    expect(source.playbackUrl).toBe(MASTER_URL)
  })

  it('and it really is a master, so a rendition can be chosen from it', () => {
    // The property that actually matters: `variantForTile` only runs when the
    // playlist is a master, and a media playlist silently skips it.
    expect(isMasterPlaylist(MASTER)).toBe(true)
  })
})

describe('projects saved before the fix', () => {
  /*
   * `playbackUrl` is derived data cached in the project file, and nothing
   * re-resolves on open — so a project written while the resolver was wrong
   * keeps a single-rendition URL forever, and keeps every angle pinned to
   * 1080p60 with it. Reece's nine-POV event was exactly this: every angle
   * `.../media/hls/1080p60/playlist.m3u8`.
   */
  it('repairs a Kick rendition URL back to its master', () => {
    expect(
      masterPlaylistFor(
        'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/iejf5NtImR5J/2026/8/14/18/24/teb4xcZSHemJ/media/hls/1080p60/playlist.m3u8'
      )
    ).toBe(
      'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/iejf5NtImR5J/2026/8/14/18/24/teb4xcZSHemJ/media/hls/master.m3u8'
    )
  })

  it('repairs whichever rendition was stored, not just 1080p60', () => {
    for (const rung of ['1080p60', '720p60', '480p30', '160p30']) {
      expect(masterPlaylistFor(`https://stream.kick.com/a/media/hls/${rung}/playlist.m3u8`)).toBe(
        'https://stream.kick.com/a/media/hls/master.m3u8'
      )
    }
  })

  it('leaves a master alone', () => {
    expect(masterPlaylistFor('https://stream.kick.com/a/media/hls/master.m3u8')).toBeNull()
  })

  it('does not guess at platforms whose master cannot be derived', () => {
    // Twitch's master lives on usher behind a signed token; a storage URL says
    // nothing about it. Inventing one would break playback that works today.
    expect(
      masterPlaylistFor('https://d2vi6trrdongqn.cloudfront.net/abc_123/chunked/index-dvr.m3u8')
    ).toBeNull()
    expect(masterPlaylistFor('https://example.invalid/whatever.m3u8')).toBeNull()
    expect(masterPlaylistFor('not a url')).toBeNull()
  })

  it('reaches a real project through normalizeProject', () => {
    const normalized = normalizeProject(
      {
        sources: [
          {
            id: 'kick:1',
            platform: 'kick',
            vodId: '1',
            url: 'https://kick.com/a/videos/1',
            title: 't',
            creator: 'c',
            durationSeconds: 60,
            playbackUrl: 'https://stream.kick.com/a/media/hls/1080p60/playlist.m3u8',
            playbackKind: 'hls',
            capabilities: { notes: [] },
            formatsInspected: false
          }
        ],
        clips: [],
        markers: []
      },
      'x.cookieclip'
    )
    expect(normalized.sources[0].playbackUrl).toBe(
      'https://stream.kick.com/a/media/hls/master.m3u8'
    )
  })
})
