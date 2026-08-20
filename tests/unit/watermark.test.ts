import { describe, expect, it } from 'vitest'
import {
  anchorPosition,
  defaultWatermark,
  positionFromBox,
  streamerFor,
  resolveWatermark,
  sanitizeWatermark,
  watermarkBox
} from '../../src/shared/watermark.js'
import type { WatermarkConfig } from '../../src/shared/watermark.js'

/**
 * A watermark is stored as a transform, never as pixels. These cover the two
 * promises that depends on: the same configuration lands in the same visual
 * place at any resolution, and editing a VOD never rewrites the streamer's
 * default.
 */

const LOGO = { width: 400, height: 200 }

function config(over: Partial<WatermarkConfig> = {}): WatermarkConfig {
  return { ...defaultWatermark('img'), ...over }
}

describe('placing a watermark', () => {
  it('lands in the same relative place whatever the resolution', () => {
    const c = config({ anchor: 'top-right', x: 0.95, y: 0.05, width: 0.2 })
    const hd = watermarkBox(c, { width: 1280, height: 720 }, LOGO)
    const uhd = watermarkBox(c, { width: 2560, height: 1440 }, LOGO)

    // Exactly twice the size and twice the offset — nothing drifts.
    expect(uhd.width / hd.width).toBeCloseTo(2, 5)
    expect(uhd.left / hd.left).toBeCloseTo(2, 5)
    expect(uhd.top / hd.top).toBeCloseTo(2, 5)
  })

  it('keeps the image’s proportions while the aspect ratio is locked', () => {
    const box = watermarkBox(config({ width: 0.25 }), { width: 1920, height: 1080 }, LOGO)
    expect(box.width).toBeCloseTo(480, 5)
    expect(box.height).toBeCloseTo(240, 5) // 400×200 is 2:1
  })

  it('pins the corner the anchor names', () => {
    const frame = { width: 1000, height: 1000 }
    const topRight = watermarkBox(config({ ...anchorPosition('top-right'), width: 0.1 }), frame, LOGO)
    // The right edge sits at the safe margin, not the left edge.
    expect(topRight.left + topRight.width).toBeCloseTo(975, 3)

    const bottomLeft = watermarkBox(config({ ...anchorPosition('bottom-left'), width: 0.1 }), frame, LOGO)
    expect(bottomLeft.left).toBeCloseTo(25, 3)
    expect(bottomLeft.top + bottomLeft.height).toBeCloseTo(975, 3)
  })

  it('round-trips a drag back into the stored transform', () => {
    const frame = { width: 1920, height: 1080 }
    const start = config({ anchor: 'center', x: 0.5, y: 0.5, width: 0.2 })
    const box = watermarkBox(start, frame, LOGO)
    const moved = { ...box, left: box.left + 192, top: box.top - 108 }
    const next = positionFromBox(moved, frame, 'center')

    expect(next.x).toBeCloseTo(0.6, 5)
    expect(next.y).toBeCloseTo(0.4, 5)
    // And placing it again puts it exactly where it was dragged to.
    const again = watermarkBox({ ...start, ...next }, frame, LOGO)
    expect(again.left).toBeCloseTo(moved.left, 3)
    expect(again.top).toBeCloseTo(moved.top, 3)
  })
})

describe('which watermark applies', () => {
  const streamerDefault = config({ imageId: 'logo-a', width: 0.1 })
  const vodOverride = config({ imageId: 'logo-b', width: 0.3 })

  it('uses the streamer default when the VOD has not disagreed', () => {
    const resolved = resolveWatermark(undefined, streamerDefault)
    expect(resolved?.from).toBe('streamer')
    expect(resolved?.config.imageId).toBe('logo-a')
  })

  it('prefers the VOD’s own once it has one', () => {
    const resolved = resolveWatermark(vodOverride, streamerDefault)
    expect(resolved?.from).toBe('vod')
    expect(resolved?.config.imageId).toBe('logo-b')
  })

  it('is nothing at all when disabled, so a stream copy stays possible', () => {
    expect(resolveWatermark(config({ enabled: false }), streamerDefault)).toBeNull()
    expect(resolveWatermark(undefined, undefined)).toBeNull()
    // Enabled but with no image is still nothing to draw.
    expect(resolveWatermark(config({ imageId: null }), undefined)).toBeNull()
  })
})

describe('reading a watermark off disk', () => {
  it('clamps anything out of range rather than trusting the file', () => {
    const cleaned = sanitizeWatermark({
      enabled: true,
      imageId: 'x',
      anchor: 'nonsense',
      x: 5,
      y: -2,
      width: 99,
      rotation: 725,
      opacity: 3
    })!
    expect(cleaned.anchor).toBe('top-right')
    expect(cleaned.x).toBe(1)
    expect(cleaned.y).toBe(0)
    expect(cleaned.width).toBe(1)
    expect(cleaned.rotation).toBe(5)
    expect(cleaned.opacity).toBe(1)
  })
})

describe('finding the streamer a VOD belongs to', () => {
  const saved = [
    { platform: 'twitch', handle: 'KaynLarp', watermark: undefined },
    { platform: 'kick', handle: 'kaynlarp', watermark: undefined }
  ]

  it('matches on platform and handle regardless of case', () => {
    expect(
      streamerFor(saved, { platform: 'twitch', channelHandle: 'kaynlarp', creator: 'Kayn' })
    ).toBe(saved[0])
  })

  it('falls back to the creator name when no handle was recorded', () => {
    expect(streamerFor(saved, { platform: 'kick', channelHandle: null, creator: 'KAYNLARP' })).toBe(
      saved[1]
    )
  })

  it('does not borrow another platform’s default', () => {
    expect(
      streamerFor(saved, { platform: 'youtube', channelHandle: 'kaynlarp', creator: 'Kayn' })
    ).toBeNull()
  })
})
