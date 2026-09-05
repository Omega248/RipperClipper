import { describe, expect, it } from 'vitest'
import { buildWatermarkFilter } from '../../src/main/media/watermarkFilter.js'
import { defaultWatermark } from '../../src/shared/watermark.js'

/**
 * Watermarking is meant to be a preprocessing step, not an export.
 *
 * On the CPU path every frame is copied out of the GPU, composited, and
 * copied back — which is what made a watermarked cut run at 2x realtime while
 * an unwatermarked one finished at download speed. The GPU path keeps the
 * frames in VRAM from NVDEC to NVENC, and these are the three things that
 * have to be true of the graph for that to happen.
 */
describe('the GPU watermark chain', () => {
  const watermark = {
    config: { ...defaultWatermark('img_1'), width: 0.16 },
    imagePath: 'C:/badges/name.png',
    imageWidth: 400,
    imageHeight: 100
  }
  const opts = {
    frameWidth: 1920,
    frameHeight: 1080,
    videoLabel: '0:v:0',
    imageLabel: '1:v',
    outputLabel: 'wm'
  }

  it('uploads the badge once and composites on the device', () => {
    const plan = buildWatermarkFilter(watermark, { ...opts, cuda: true })

    // The still is prepared on the CPU — one image, once — then handed to the
    // GPU. Anything else per frame would defeat the point.
    expect(plan.filterComplex).toContain('hwupload[wmimg]')
    expect(plan.filterComplex).toContain('overlay_cuda=')
    expect(plan.filterComplex).not.toContain('hwdownload')
  })

  it('carries the badge alpha onto the device', () => {
    // Without an alpha-bearing format the badge lands as an opaque rectangle
    // and the picture behind it is gone.
    expect(buildWatermarkFilter(watermark, { ...opts, cuda: true }).filterComplex).toContain(
      'format=yuva420p,hwupload'
    )
  })

  it('is the same geometry as the CPU graph', () => {
    const cpu = buildWatermarkFilter(watermark, opts)
    const gpu = buildWatermarkFilter(watermark, { ...opts, cuda: true })

    // Everything after the overlay filter's '=' up to the output label: the
    // x:y the badge is drawn at, whichever filter drew it.
    const at = (graph: string): string =>
      (graph.split(/overlay(?:_cuda)?=/)[1] ?? 'none').split('[')[0].replace(':shortest=1', '')

    // The badge must land in the same place either way, or turning the GPU
    // path on would silently move somebody's logo.
    expect(at(gpu.filterComplex)).toBe(at(cpu.filterComplex))
    expect(at(gpu.filterComplex)).not.toBe('none')
  })

  it('leaves the CPU graph exactly as it was', () => {
    const cpu = buildWatermarkFilter(watermark, opts)
    expect(cpu.filterComplex).toContain('shortest=1')
    expect(cpu.filterComplex).not.toContain('cuda')
  })
})
