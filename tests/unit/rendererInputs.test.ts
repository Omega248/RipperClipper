import { describe, expect, it } from 'vitest'
import { assertHttpUrl, headerArgs, isValidHttpUrl } from '../../src/main/media/http.js'
import { resolveFailure } from '../../src/main/media/resolver.js'

/**
 * What reaches ffmpeg's command line from the renderer.
 *
 * Stream URLs and their headers arrive on a source object the renderer hands
 * over. ffmpeg's `-headers` value is one CRLF-delimited blob, so a newline
 * inside a value *is* a header separator — and a URL after `-i` does not have
 * to be http at all: `file:///` and `concat:` both read local files, and the
 * frame server would then stream the result straight back out.
 */

describe('headerArgs', () => {
  it('sends nothing when there is nothing to send', () => {
    expect(headerArgs(undefined)).toEqual([])
    expect(headerArgs({})).toEqual([])
  })

  it('builds the blob ffmpeg expects', () => {
    expect(headerArgs({ referer: 'https://kick.com/' })).toEqual([
      '-headers',
      'referer: https://kick.com/\r\n'
    ])
  })

  it('drops a value carrying its own headers', () => {
    const smuggled = headerArgs({
      referer: 'https://ok.invalid/\r\nAuthorization: Bearer stolen',
      'user-agent': 'Mozilla/5.0'
    })
    expect(smuggled.join('')).not.toContain('Authorization')
    expect(smuggled.join('')).toContain('user-agent: Mozilla/5.0')
  })

  it('drops a name that is not a header name', () => {
    expect(headerArgs({ 'x\r\nInjected': 'v' })).toEqual([])
    expect(headerArgs({ 'has space': 'v' })).toEqual([])
    expect(headerArgs({ 'quote"': 'v' })).toEqual([])
  })

  it('keeps the ordinary ones intact', () => {
    const [, blob] = headerArgs({ referer: 'https://a/', origin: 'https://b' })
    expect(blob).toBe('referer: https://a/\r\norigin: https://b\r\n')
  })
})

describe('assertHttpUrl', () => {
  it('refuses everything that is not a fetch over http(s)', () => {
    for (const bad of [
      'file:///etc/passwd',
      'file://C:/Windows/win.ini',
      'concat:a.ts|b.ts',
      'data:text/plain,hi',
      'pipe:0',
      'not-a-url',
      ''
    ]) {
      expect(isValidHttpUrl(bad), bad).toBe(false)
      expect(() => assertHttpUrl(bad), bad).toThrow()
    }
  })

  it('passes a real media URL through unchanged', () => {
    const url = 'https://cdn.invalid/hls/index.m3u8?sig=abc'
    expect(assertHttpUrl(url)).toBe(url)
  })
})

describe('the errors a resolve can end in', () => {
  /*
   * Order matters here. yt-dlp's DRM message mentions signing in, so DRM used
   * to land in the sign-in branch and tell people to configure browser cookies
   * — for a video no cookie will ever unlock. An actionable error that sends
   * you round a loop is worse than a vague one.
   */
  it('calls DRM DRM, even when the message also says sign in', () => {
    expect(
      resolveFailure('ERROR: This video is DRM protected. Sign in if you have access.', 'YouTube', 1)
        .code
    ).toBe('drm-protected')
    expect(resolveFailure('ERROR: not available: widevine license', 'YouTube', 1).code).toBe(
      'drm-protected'
    )
  })

  it('still routes a genuine sign-in wall to the sign-in error', () => {
    const err = resolveFailure('ERROR: This video is private. Sign in to view it.', 'Twitch', 1)
    expect(err.code).toBe('auth-required')
    // And the way out it names has to be a real one.
    expect(err.message).toContain('Settings → Setup → Restricted VODs')
  })

  it('still routes a deleted VOD to unavailable', () => {
    expect(
      resolveFailure('ERROR: Video unavailable. This video has been removed.', 'Kick', 1).code
    ).toBe('vod-unavailable')
  })

  it('falls back to the exit code when yt-dlp said nothing', () => {
    const err = resolveFailure('', 'Kick', 2)
    expect(err.code).toBe('resolver-failed')
    expect(err.detail).toContain('2')
  })
})
