import { describe, expect, it } from 'vitest'
import { classifyPreview } from '../../src/shared/compat.js'

/**
 * The YouTube preview failure ("HTTP 206, video/mp4, cannot decode") was the
 * app assuming a file it had never inspected would play. These are the rules
 * that replace the assumption.
 */
describe('deciding how a source can be previewed', () => {
  it('plays H.264 in MP4 directly', () => {
    expect(
      classifyPreview({ container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264', audioCodec: 'aac' }).plan
    ).toBe('native')
  })

  it('plays VP9 and AV1 in WebM directly — Chromium decodes both', () => {
    expect(classifyPreview({ container: 'matroska,webm', videoCodec: 'vp9', audioCodec: 'opus' }).plan).toBe(
      'native'
    )
    expect(classifyPreview({ container: 'mp4', videoCodec: 'av01.0.05M.08', audioCodec: 'opus' }).plan).toBe(
      'native'
    )
  })

  it('re-encodes HEVC rather than pretending it will play', () => {
    const result = classifyPreview({ container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' })
    expect(result.plan).toBe('transcode')
    expect(result.reason).toMatch(/hevc/i)
  })

  it('re-encodes when the sound is a codec the player cannot take', () => {
    expect(classifyPreview({ container: 'mp4', videoCodec: 'h264', audioCodec: 'ac3' }).plan).toBe('transcode')
  })

  it('only repackages when the streams are fine but the wrapper is not', () => {
    const result = classifyPreview({ container: 'mpegts', videoCodec: 'h264', audioCodec: 'aac' })
    expect(result.plan).toBe('remux')
    expect(result.reason).toMatch(/copied into MP4/i)
  })

  it('says so when there is no picture at all', () => {
    expect(classifyPreview({ container: 'mp4', hasVideo: false }).plan).toBe('unsupported')
  })
})
