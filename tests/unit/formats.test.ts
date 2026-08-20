import { describe, expect, it } from 'vitest'
import { describeStreams, planContainer, selectStreams } from '../../src/main/media/formats.js'
import { mapProtocol, shortCodec, toStreamInfos } from '../../src/main/media/resolver.js'
import type { StreamInfo } from '../../src/shared/types.js'

function video(partial: Partial<StreamInfo>): StreamInfo {
  return {
    id: partial.id ?? 'v',
    protocol: partial.protocol ?? 'http-range',
    label: partial.label ?? 'video',
    url: partial.url ?? 'https://example.invalid/v',
    hasVideo: true,
    hasAudio: false,
    ...partial
  } as StreamInfo
}

function audio(partial: Partial<StreamInfo>): StreamInfo {
  return {
    id: partial.id ?? 'a',
    protocol: partial.protocol ?? 'http-range',
    label: partial.label ?? 'audio',
    url: partial.url ?? 'https://example.invalid/a',
    hasVideo: false,
    hasAudio: true,
    ...partial
  } as StreamInfo
}

const YOUTUBE_LIKE: StreamInfo[] = [
  video({ id: '271', width: 2560, height: 1440, fps: 60, codec: 'vp09.00.50.08', bitrate: 18_000_000 }),
  video({ id: '399', width: 1920, height: 1080, fps: 60, codec: 'av01.0.08M.08', bitrate: 8_000_000 }),
  video({ id: '136', width: 1280, height: 720, fps: 30, codec: 'avc1.4d401f', bitrate: 2_500_000 }),
  audio({ id: '251', codec: 'opus', bitrate: 160_000, sampleRate: 48000, channels: 2 }),
  audio({ id: '140', codec: 'mp4a.40.2', bitrate: 128_000, sampleRate: 44100, channels: 2 })
]

const TWITCH_LIKE: StreamInfo[] = [
  video({
    id: 'chunked',
    width: 1920,
    height: 1080,
    fps: 60,
    codec: 'avc1.4d402a',
    protocol: 'hls',
    hasAudio: true,
    bitrate: 6_000_000
  }),
  video({
    id: '720p60',
    width: 1280,
    height: 720,
    fps: 60,
    codec: 'avc1.4d401f',
    protocol: 'hls',
    hasAudio: true,
    bitrate: 3_000_000
  })
]

describe('selectStreams', () => {
  it('picks the highest resolution/frame rate and the best separate audio', () => {
    const selected = selectStreams(YOUTUBE_LIKE, 'best')
    expect(selected.video?.id).toBe('271')
    expect(selected.audio?.id).toBe('251')
    expect(selected.muxed).toBe(false)
  })

  it('uses an already-muxed stream without pairing extra audio', () => {
    const selected = selectStreams(TWITCH_LIKE, 'best')
    expect(selected.video?.id).toBe('chunked')
    expect(selected.audio).toBeNull()
    expect(selected.muxed).toBe(true)
  })

  it('honours a capped quality preference', () => {
    expect(selectStreams(YOUTUBE_LIKE, '1080').video?.id).toBe('399')
    expect(selectStreams(YOUTUBE_LIKE, '720').video?.id).toBe('136')
  })

  it('explains itself when the requested quality is not offered', () => {
    const selected = selectStreams(YOUTUBE_LIKE, '1440')
    expect(selected.video?.height).toBe(1440)
    const capped = selectStreams(TWITCH_LIKE, '1440')
    expect(capped.notes.join(' ')).toMatch(/1440p is not available/)
  })

  it('supports audio-only exports', () => {
    const selected = selectStreams(YOUTUBE_LIKE, 'audio-only')
    expect(selected.video).toBeNull()
    expect(selected.audio?.id).toBe('251')
  })

  it('never silently produces a silent clip when audio exists elsewhere', () => {
    const videoOnly = [video({ id: 'v1', height: 1080 })]
    const selected = selectStreams(videoOnly, 'best')
    expect(selected.notes.join(' ')).toMatch(/does not provide an audio track/)
  })

  it('throws a specific error when nothing is downloadable', () => {
    expect(() => selectStreams([], 'best')).toThrowError(/downloadable stream/)
  })
})

describe('planContainer', () => {
  it('copies straight into MP4 when the codecs allow it', () => {
    const selected = selectStreams(TWITCH_LIKE, 'best')
    const plan = planContainer(selected, 'mp4', 'switch-to-mkv')
    expect(plan).toMatchObject({ container: 'mp4', copyVideo: true, copyAudio: true })
    expect(plan.notes).toHaveLength(0)
  })

  it('switches to MKV rather than re-encoding Opus audio', () => {
    // 1080p here is AV1, which MP4 accepts — so the incompatibility is the Opus audio.
    const selected = selectStreams(YOUTUBE_LIKE, '1080')
    const plan = planContainer(selected, 'mp4', 'switch-to-mkv')
    expect(plan.container).toBe('mkv')
    expect(plan.notes.join(' ')).toMatch(/written as MKV/)
  })

  it('switches to MKV when the video codec itself cannot go into MP4', () => {
    const selected = selectStreams(YOUTUBE_LIKE, 'best') // VP9
    const plan = planContainer(selected, 'mp4', 'convert-audio')
    expect(plan.container).toBe('mkv')
    expect(plan.notes.join(' ')).toMatch(/source video codec/)
  })

  it('can instead convert only the audio, keeping video untouched', () => {
    const selected = selectStreams(YOUTUBE_LIKE, '1080')
    const plan = planContainer(selected, 'mp4', 'convert-audio')
    expect(plan).toMatchObject({ container: 'mp4', copyVideo: true, copyAudio: false, audioEncoder: 'aac' })
    expect(plan.notes.join(' ')).toMatch(/Video was copied untouched/)
  })

  it('never rejects MKV', () => {
    const selected = selectStreams(YOUTUBE_LIKE, 'best')
    expect(planContainer(selected, 'mkv', 'switch-to-mkv').container).toBe('mkv')
  })
})

describe('describeStreams', () => {
  it('summarises what was actually detected', () => {
    const selected = selectStreams(YOUTUBE_LIKE, 'best')
    const described = describeStreams(selected)
    expect(described.video).toContain('2560 × 1440')
    expect(described.video).toContain('60 FPS')
    expect(described.audio).toContain('48 kHz')
    expect(described.audio).toContain('Stereo')
  })
})

describe('resolver mapping', () => {
  it('maps yt-dlp protocols to fetch strategies', () => {
    expect(mapProtocol('m3u8_native')).toBe('hls')
    expect(mapProtocol('m3u8')).toBe('hls')
    expect(mapProtocol('http_dash_segments')).toBe('fragmented')
    expect(mapProtocol('https')).toBe('http-range')
    expect(mapProtocol('rtmp')).toBeNull()
    expect(mapProtocol(undefined)).toBeNull()
  })

  it('drops formats that cannot be range-fetched', () => {
    const streams = toStreamInfos({
      formats: [
        { format_id: 'ok', url: 'https://x.invalid/a', protocol: 'https', vcodec: 'avc1', acodec: 'none' },
        { format_id: 'rtmp', url: 'rtmp://x.invalid/a', protocol: 'rtmp', vcodec: 'avc1', acodec: 'none' },
        { format_id: 'nourl', protocol: 'https', vcodec: 'avc1', acodec: 'none' },
        { format_id: 'nostreams', url: 'https://x.invalid/c', protocol: 'https', vcodec: 'none', acodec: 'none' }
      ]
    })
    expect(streams.map((s) => s.id)).toEqual(['ok'])
  })

  it('converts bitrates from kbps to bps and labels formats readably', () => {
    const streams = toStreamInfos({
      formats: [
        {
          format_id: '271',
          url: 'https://x.invalid/v',
          protocol: 'https',
          vcodec: 'vp09.00.50.08',
          acodec: 'none',
          height: 1440,
          fps: 60,
          vbr: 18000
        }
      ]
    })
    expect(streams[0].bitrate).toBe(18_000_000)
    expect(streams[0].label).toBe('1440p60 VP9')
  })

  it('shortens codec strings for display', () => {
    expect(shortCodec('avc1.4d402a')).toBe('H.264')
    expect(shortCodec('hvc1.1.6.L93')).toBe('HEVC')
    expect(shortCodec('av01.0.08M.08')).toBe('AV1')
    expect(shortCodec('mp4a.40.2')).toBe('AAC')
    expect(shortCodec('opus')).toBe('Opus')
    expect(shortCodec('none')).toBe('')
  })
})
