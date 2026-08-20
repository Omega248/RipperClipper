import type { ResolvedWatermark } from '../../shared/watermark.js'
import { watermarkBox } from '../../shared/watermark.js'

/**
 * The watermark, as an FFmpeg filter graph.
 *
 * The transform stored on the VOD is normalised — a fraction of the frame — and
 * it is resolved here against the frame size FFprobe actually reported for this
 * export. That is what resolution independence means in practice: the numbers
 * on disk never change, and the same configuration lands in the same visual
 * place whether the clip comes out at 720p or 1440p.
 *
 * The geometry comes from `watermarkBox`, the same function the on-screen
 * editor and the live preview use, so the three cannot drift apart. If they
 * did, the logo would move between where it was positioned and where it was
 * written, which is the one failure this path exists to prevent.
 *
 * (Expressing the size as `main_w * fraction` inside `scale` looks tempting and
 * does not work: `main_w` is an overlay variable, and `scale` rejects it with
 * "Expressions with scale2ref variables are not valid in scale filter".)
 */

export interface WatermarkFilterPlan {
  filterComplex: string
  outputLabel: string
}

export function buildWatermarkFilter(
  watermark: ResolvedWatermark,
  opts: {
    /** The real frame size for this export, from ffprobe. */
    frameWidth: number
    frameHeight: number
    videoLabel: string
    imageLabel: string
    outputLabel: string
  }
): WatermarkFilterPlan {
  const { config, imageWidth, imageHeight } = watermark
  const frame = { width: opts.frameWidth, height: opts.frameHeight }
  const box = watermarkBox(config, frame, {
    width: imageWidth || 1,
    height: imageHeight || 1
  })

  // Even dimensions: odd sizes break some encoders and chroma subsampling.
  const width = Math.max(2, Math.round(box.width / 2) * 2)
  const height = Math.max(2, Math.round(box.height / 2) * 2)

  const chain: string[] = [
    // rgba first, so opacity and rotation both have an alpha channel to work on.
    'format=rgba',
    `scale=${width}:${height}`
  ]

  if (config.opacity < 1) {
    chain.push(`colorchannelmixer=aa=${clamp01(config.opacity).toFixed(4)}`)
  }

  let left = Math.round(box.left)
  let top = Math.round(box.top)

  if (config.rotation % 360 !== 0) {
    const radians = (config.rotation * Math.PI) / 180
    // Rotating about the centre onto a transparent canvas big enough for the
    // corners, so nothing is clipped at an angle.
    chain.push(
      `rotate=${radians.toFixed(6)}:ow=rotw(${radians.toFixed(6)}):oh=roth(${radians.toFixed(6)}):c=none`
    )
    // The canvas grew around the centre, so the top-left moves out by half the
    // growth. Without this the logo drifts as it is rotated.
    const grownWidth = Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))
    const grownHeight = Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))
    left -= Math.round((grownWidth - width) / 2)
    top -= Math.round((grownHeight - height) / 2)
  }

  const filterComplex =
    `[${opts.imageLabel}]${chain.join(',')}[wmimg];` +
    // `shortest` matters: the image is a still looped for the clip's length and
    // would otherwise extend the output past the video.
    `[${opts.videoLabel}][wmimg]overlay=${left}:${top}:shortest=1[${opts.outputLabel}]`

  return { filterComplex, outputLabel: opts.outputLabel }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
