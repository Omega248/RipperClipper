import { describe, expect, it } from 'vitest'
import { TwitchAdapter } from '../../src/main/platforms/twitch.js'
import { firstCodec } from '../../src/main/media/hls.js'
import { toStreamInfos } from '../../src/main/media/resolver.js'

/**
 * Twitch resolved from Twitch's own API rather than yt-dlp. The mapping has to
 * produce exactly what the rest of the pipeline already expects, or replacing
 * the resolver quietly breaks export and playback instead of loudly failing.
 *
 * The fixture is a real usher response, trimmed: `chunked` is genuinely what
 * Twitch calls the source rendition, and the audio-only variant with no
 * RESOLUTION is genuinely present.
 */

const META = {
  id: '2860187156',
  title: '??? | NoPixel WL | 5.0 Invitee',
  lengthSeconds: 8702,
  publishedAt: '2026-08-29T23:54:43.000Z',
  previewThumbnailURL: 'https://static-cdn.jtvnw.net/cf_vods/abc/thumb.jpg',
  owner: { login: 'skorbnut', displayName: 'Skorbnut' }
}

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8438000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://cdn.example/chunked/index-dvr.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3422000,RESOLUTION=1280x720,CODECS="avc1.4D4020,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://cdn.example/720p60/index-dvr.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="Audio Only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://cdn.example/audio_only/index-dvr.m3u8
`

const master = { text: MASTER, url: 'https://usher.ttvnw.net/vod/2860187156.m3u8' }

describe('Twitch direct resolution', () => {
  it('maps the video document onto the resolver shape', () => {
    const raw = new TwitchAdapter().fromApi(META, master, 'https://www.twitch.tv/videos/2860187156')
    expect(raw.title).toBe('??? | NoPixel WL | 5.0 Invitee')
    expect(raw.uploader).toBe('Skorbnut')
    expect(raw.channel).toBe('skorbnut')
    expect(raw.duration).toBe(8702)
    expect(raw.extractor_key).toBe('TwitchVod')
    expect(raw.is_live).toBe(false)
    expect(raw.webpage_url).toBe('https://www.twitch.tv/videos/2860187156')
  })

  it('turns the publish time into the epoch seconds the source model wants', () => {
    const raw = new TwitchAdapter().fromApi(META, master)
    expect(raw.timestamp).toBe(Math.floor(Date.parse('2026-08-29T23:54:43.000Z') / 1000))
  })

  it('puts the source rendition first, whatever Twitch calls it', () => {
    // "chunked" sorts nowhere useful alphabetically; height is what decides.
    const raw = new TwitchAdapter().fromApi(META, master)
    expect(raw.formats?.[0]?.format_id).toBe('1080p60')
    expect(raw.formats?.[0]?.height).toBe(1080)
    expect(raw.formats?.[0]?.fps).toBe(60)
  })

  it('splits the codec string the way the export pipeline reads it', () => {
    const raw = new TwitchAdapter().fromApi(META, master)
    expect(raw.formats?.[0]?.vcodec).toBe('avc1.64002A')
    expect(raw.formats?.[0]?.acodec).toBe('mp4a.40.2')
  })

  it('keeps the audio-only variant rather than dropping it for having no size', () => {
    const raw = new TwitchAdapter().fromApi(META, master)
    const audioOnly = raw.formats?.find((f) => f.vcodec === 'unknown')
    expect(audioOnly).toBeDefined()
    expect(audioOnly?.acodec).toBe('mp4a.40.2')
  })

  it('produces formats the existing pipeline actually accepts', () => {
    // The whole point: the rest of the app must not be able to tell that
    // yt-dlp was not involved.
    const raw = new TwitchAdapter().fromApi(META, master)
    const streams = toStreamInfos(raw)
    expect(streams.length).toBeGreaterThan(0)
    expect(streams.every((s) => s.protocol === 'hls')).toBe(true)
    expect(streams.some((s) => s.height === 1080)).toBe(true)
  })

  it('builds a source the app can open', () => {
    const raw = new TwitchAdapter().fromApi(META, master)
    const source = new TwitchAdapter().buildSource(
      { vodId: '2860187156', canonicalUrl: 'https://www.twitch.tv/videos/2860187156' } as never,
      raw
    )
    expect(source.id).toBe('twitch:2860187156')
    expect(source.platform).toBe('twitch')
    expect(source.creator).toBe('Skorbnut')
    expect(source.durationSeconds).toBe(8702)
    // The *master* is what gets played — see the note in kickDirect.test.ts.
    // Asserting the highest rendition here is what kept every angle pinned to
    // 1080p60 no matter how small it was drawn.
    expect(source.playbackUrl).not.toContain('/chunked/')
    expect(source.playbackUrl).toBe(master.url)
  })

  it('survives a video document Twitch would not describe', () => {
    // Metadata and playback come from two different calls; the second can
    // succeed when the first does not, and a nameless VOD still plays.
    const raw = new TwitchAdapter().fromApi({ id: '123' }, master)
    expect(raw.title).toBeUndefined()
    expect(raw.formats?.length).toBe(3)
  })
})

describe('firstCodec', () => {
  it('separates the video codec from the audio one', () => {
    expect(firstCodec('avc1.64002A,mp4a.40.2', 'video')).toBe('avc1.64002A')
    expect(firstCodec('avc1.64002A,mp4a.40.2', 'audio')).toBe('mp4a.40.2')
  })

  it('handles a stream that has only one of them', () => {
    expect(firstCodec('mp4a.40.2', 'video')).toBeUndefined()
    expect(firstCodec('mp4a.40.2', 'audio')).toBe('mp4a.40.2')
    expect(firstCodec('av01.0.08M.08', 'video')).toBe('av01.0.08M.08')
  })

  it('says nothing rather than guessing when there is no codec string', () => {
    expect(firstCodec(undefined, 'video')).toBeUndefined()
    expect(firstCodec('', 'audio')).toBeUndefined()
  })
})
