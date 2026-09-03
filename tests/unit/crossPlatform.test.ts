import { describe, expect, it } from 'vitest'
import { bestOf } from '../../src/main/services/crossPlatform.js'
import type { PlatformQuality } from '../../src/shared/ipc.js'

function option(
  platform: PlatformQuality['platform'],
  video?: PlatformQuality['video']
): PlatformQuality {
  return {
    platform,
    handle: 'someone',
    channelUrl: `https://example.invalid/${platform}`,
    found: true,
    ...(video ? { video } : {})
  }
}

describe('bestOf', () => {
  it('picks the platform with the most pixels', () => {
    expect(
      bestOf([
        option('twitch', { label: '720p60', width: 1280, height: 720, fps: 60 }),
        option('kick', { label: '1080p60', width: 1920, height: 1080, fps: 60 }),
        option('youtube', { label: '1080p30', width: 1920, height: 1080, fps: 30 })
      ])
    ).toBe('kick')
  })

  it('breaks a resolution tie on frame rate, then bitrate', () => {
    expect(
      bestOf([
        option('twitch', { label: '1080p30', width: 1920, height: 1080, fps: 30 }),
        option('kick', { label: '1080p60', width: 1920, height: 1080, fps: 60 })
      ])
    ).toBe('kick')

    expect(
      bestOf([
        option('twitch', { label: '1080p60', width: 1920, height: 1080, fps: 60, bitrate: 6_000_000 }),
        option('kick', { label: '1080p60', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 })
      ])
    ).toBe('kick')
  })

  it('ignores platforms with nothing readable, and says so when none are', () => {
    expect(
      bestOf([option('twitch'), option('kick', { label: '720p', width: 1280, height: 720 })])
    ).toBe('kick')
    expect(bestOf([option('twitch'), option('kick')])).toBeNull()
    expect(bestOf([])).toBeNull()
  })
})
