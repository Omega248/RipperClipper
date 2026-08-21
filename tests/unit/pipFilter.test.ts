import { describe, expect, it } from 'vitest'
import { buildPipFilter } from '../../src/main/media/pipFilter.js'
import type { TimelineTransform } from '../../src/shared/types.js'

/**
 * Position/scale math verified independently against a standalone script
 * before writing these expectations — the same kind of pixel arithmetic
 * that's easy to get subtly wrong (see buildTransformFilter/watermarkFilter,
 * whose exact formula this deliberately mirrors).
 */
describe('buildPipFilter', () => {
  it('centres a half-size inset at x=0, y=0', () => {
    const transform: TimelineTransform = { x: 0, y: 0, scale: 0.5, rotation: 0 }
    const plan = buildPipFilter(transform, {
      frameWidth: 1920,
      frameHeight: 1080,
      backgroundLabel: 'bg',
      insetLabel: '1:v:0',
      outputLabel: 'pip'
    })
    expect(plan.outputLabel).toBe('pip')
    expect(plan.filterComplex).toBe(
      '[1:v:0]scale=960:540[pipimg];[bg][pipimg]overlay=480:270[pip]'
    )
  })

  it('positions an offset inset correctly', () => {
    const transform: TimelineTransform = { x: -0.5, y: -0.5, scale: 0.25, rotation: 0 }
    const plan = buildPipFilter(transform, {
      frameWidth: 1280,
      frameHeight: 720,
      backgroundLabel: 'xf',
      insetLabel: '2:v:0',
      outputLabel: 'pip'
    })
    expect(plan.filterComplex).toBe('[2:v:0]scale=320:180[pipimg];[xf][pipimg]overlay=160:90[pip]')
  })

  it('falls back to a sensible corner inset when given no transform', () => {
    const plan = buildPipFilter(undefined, {
      frameWidth: 1920,
      frameHeight: 1080,
      backgroundLabel: 'bg',
      insetLabel: '1:v:0',
      outputLabel: 'pip'
    })
    expect(plan.filterComplex).toBe('[1:v:0]scale=538:302[pipimg];[bg][pipimg]overlay=1286:724[pip]')
  })

  it('falls back to the same corner inset for an identity transform, which would otherwise cover the whole frame', () => {
    const identity: TimelineTransform = { x: 0, y: 0, scale: 1, rotation: 0 }
    const withIdentity = buildPipFilter(identity, {
      frameWidth: 1920,
      frameHeight: 1080,
      backgroundLabel: 'bg',
      insetLabel: '1:v:0',
      outputLabel: 'pip'
    })
    const withNone = buildPipFilter(undefined, {
      frameWidth: 1920,
      frameHeight: 1080,
      backgroundLabel: 'bg',
      insetLabel: '1:v:0',
      outputLabel: 'pip'
    })
    expect(withIdentity.filterComplex).toBe(withNone.filterComplex)
  })

  it('never scales to zero, even with an absurd input scale', () => {
    const transform: TimelineTransform = { x: 0, y: 0, scale: 0.001, rotation: 0 }
    const plan = buildPipFilter(transform, {
      frameWidth: 1920,
      frameHeight: 1080,
      backgroundLabel: 'bg',
      insetLabel: '1:v:0',
      outputLabel: 'pip'
    })
    // Clamped to the 0.05 floor, not 0.001 — a visible sliver, not nothing.
    expect(plan.filterComplex).toContain('scale=96:54')
  })

  it('never uses shortest=1 — a fetched window a few ms off from the background must not truncate the export', () => {
    const plan = buildPipFilter(undefined, {
      frameWidth: 1920,
      frameHeight: 1080,
      backgroundLabel: 'bg',
      insetLabel: '1:v:0',
      outputLabel: 'pip'
    })
    expect(plan.filterComplex).not.toContain('shortest')
  })
})
