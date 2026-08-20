import { describe, expect, it } from 'vitest'
import { AdapterRegistry } from '../../src/main/platforms/registry.js'
import { TwitchAdapter } from '../../src/main/platforms/twitch.js'
import { KickAdapter } from '../../src/main/platforms/kick.js'
import { YouTubeAdapter } from '../../src/main/platforms/youtube.js'
import type { RawInfo } from '../../src/main/media/resolver.js'

const registry = new AdapterRegistry()

describe('Twitch URL recognition', () => {
  const adapter = new TwitchAdapter()

  it('accepts the canonical VOD form', () => {
    const match = adapter.match('https://www.twitch.tv/videos/1234567890')
    expect(match).toMatchObject({ platform: 'twitch', vodId: '1234567890' })
    expect(match!.canonicalUrl).toBe('https://www.twitch.tv/videos/1234567890')
  })

  it('accepts the legacy channel form and a time offset', () => {
    const match = adapter.match('https://twitch.tv/somechannel/video/999?t=1h2m3s')
    expect(match!.vodId).toBe('999')
    expect(match!.startSeconds).toBe(3723)
  })

  it('rejects channels, clips and other platforms', () => {
    expect(adapter.match('https://www.twitch.tv/somechannel')).toBeNull()
    expect(adapter.match('https://clips.twitch.tv/SomeClipSlug')).toBeNull()
    expect(adapter.match('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull()
  })
})

describe('Kick URL recognition', () => {
  const adapter = new KickAdapter()

  it('accepts /video/<uuid>', () => {
    const id = 'b4f1b0f0-1a2b-4c3d-9e8f-0123456789ab'
    const match = adapter.match(`https://kick.com/video/${id}`)
    expect(match).toMatchObject({ platform: 'kick', vodId: id })
  })

  it('accepts /<channel>/videos/<uuid>', () => {
    const id = 'b4f1b0f0-1a2b-4c3d-9e8f-0123456789ab'
    const match = adapter.match(`https://kick.com/somechannel/videos/${id}`)
    expect(match!.vodId).toBe(id)
    expect(match!.canonicalUrl).toBe(`https://kick.com/somechannel/videos/${id}`)
  })

  it('rejects a bare channel page', () => {
    expect(adapter.match('https://kick.com/somechannel')).toBeNull()
  })
})

describe('YouTube URL recognition', () => {
  const adapter = new YouTubeAdapter()

  it('accepts every common watch form', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ'
    ]) {
      expect(adapter.match(url), url).toMatchObject({ vodId: 'dQw4w9WgXcQ' })
    }
  })

  it('parses the t offset', () => {
    expect(adapter.match('https://youtu.be/dQw4w9WgXcQ?t=90')!.startSeconds).toBe(90)
    expect(adapter.match('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h1m1s')!.startSeconds).toBe(3661)
  })

  it('rejects malformed ids and channel pages', () => {
    expect(adapter.match('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(adapter.match('https://www.youtube.com/@somechannel')).toBeNull()
  })

  it('previews through the application player, never an embedded platform UI', () => {
    // A muxed progressive stream is what the native <video> element can show.
    const withProgressive: RawInfo = {
      formats: [
        { format_id: '22', url: 'https://x.invalid/v', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a', height: 720 },
        { format_id: '137', url: 'https://x.invalid/vo', protocol: 'https', vcodec: 'avc1', acodec: 'none', height: 1080 }
      ]
    }
    expect(adapter.playbackKind(withProgressive)).toBe('progressive')
    const source = adapter.buildSource(
      adapter.match('https://www.youtube.com/watch?v=dQw4w9WgXcQ')!,
      withProgressive
    )
    // The 1080p video-only stream has no audio, so it is not a preview candidate.
    expect(source.playbackUrl).toBe('https://x.invalid/v')
    expect(source.playbackKind).toBe('progressive')
  })

  it('reports honestly when no stream the player can show exists', () => {
    const adaptiveOnly: RawInfo = {
      formats: [
        { format_id: '137', url: 'https://x.invalid/vo', protocol: 'https', vcodec: 'avc1', acodec: 'none' },
        { format_id: '251', url: 'https://x.invalid/ao', protocol: 'https', vcodec: 'none', acodec: 'opus' }
      ]
    }
    expect(adapter.playbackKind(adaptiveOnly)).toBe('none')
  })
})

describe('AdapterRegistry', () => {
  it('routes each platform to its adapter', () => {
    expect(registry.detect('https://www.twitch.tv/videos/1').adapter.id).toBe('twitch')
    expect(registry.detect('https://kick.com/video/abcdefgh').adapter.id).toBe('kick')
    expect(registry.detect('https://youtu.be/dQw4w9WgXcQ').adapter.id).toBe('youtube')
  })

  it('reports an invalid URL distinctly from an unsupported one', () => {
    expect(() => registry.detect('not a url at all !!')).toThrowError(/valid web address/)
    expect(() => registry.detect('https://vimeo.com/12345')).toThrowError(/not a Twitch, Kick or YouTube/)
  })
})

describe('source construction', () => {
  const raw: RawInfo = {
    id: '1234567890',
    title: 'Escape From Tarkov — Ranked Session',
    uploader: 'StreamerName',
    duration: 20538,
    timestamp: Math.floor(Date.UTC(2026, 7, 17) / 1000),
    thumbnail: 'https://example.invalid/thumb.jpg',
    formats: [
      {
        format_id: '1080p60',
        url: 'https://example.invalid/1080p60/index.m3u8',
        protocol: 'm3u8_native',
        vcodec: 'avc1.4d402a',
        acodec: 'mp4a.40.2',
        height: 1080,
        width: 1920,
        fps: 60
      },
      {
        format_id: '720p60',
        url: 'https://example.invalid/720p60/index.m3u8',
        protocol: 'm3u8_native',
        vcodec: 'avc1.4d401f',
        acodec: 'mp4a.40.2',
        height: 720,
        width: 1280,
        fps: 60
      }
    ]
  }

  it('builds a Twitch source with the best playback URL and real metadata', () => {
    const adapter = new TwitchAdapter()
    const match = adapter.match('https://www.twitch.tv/videos/1234567890')!
    const source = adapter.buildSource(match, raw)

    expect(source.id).toBe('twitch:1234567890')
    expect(source.title).toBe('Escape From Tarkov — Ranked Session')
    expect(source.creator).toBe('StreamerName')
    expect(source.durationSeconds).toBe(20538)
    expect(source.createdAt?.slice(0, 10)).toBe('2026-08-17')
    expect(source.playbackKind).toBe('hls')
    expect(source.playbackUrl).toContain('1080p60')
    // Formats must not be claimed until they have actually been inspected.
    expect(source.formatsInspected).toBe(false)
  })
})
