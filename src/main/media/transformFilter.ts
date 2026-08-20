import type { TimelineTransform } from '../../shared/types.js'

/**
 * A timeline item's transform (position/scale/rotation) and opacity, as an
 * FFmpeg filter graph.
 *
 * There is no independent "project resolution" yet — the frame is always
 * the clip's own native size (see `frameWidth`/`frameHeight` in the caller,
 * read straight from ffprobe), so `scale: 1` means "native size, centred"
 * and needs no filter at all. Only a transform that actually departs from
 * that identity costs a re-render, which is why `buildTransformFilter`
 * returns null rather than a no-op graph for the common case of an
 * untouched clip.
 *
 * The technique mirrors `watermarkFilter.ts`: format to rgba so rotation and
 * opacity both have an alpha channel to work with, then composite onto a
 * frame-sized background so scaling down or moving the clip reveals black
 * rather than nothing.
 */

export interface TransformFilterPlan {
  filterComplex: string
  outputLabel: string
}

const IDENTITY: TimelineTransform = { x: 0, y: 0, scale: 1, rotation: 0 }

export function isIdentityTransform(transform: TimelineTransform | undefined | null): boolean {
  const t = transform ?? IDENTITY
  return t.x === 0 && t.y === 0 && t.scale === 1 && t.rotation % 360 === 0
}

export function buildTransformFilter(
  transform: TimelineTransform | undefined | null,
  opacity: number | undefined,
  opts: {
    /** The real frame size for this export, from ffprobe. */
    frameWidth: number
    frameHeight: number
    videoLabel: string
    outputLabel: string
  }
): TransformFilterPlan | null {
  const t = transform ?? IDENTITY
  const alpha = clamp01(opacity ?? 1)
  if (isIdentityTransform(t) && alpha >= 1) return null

  // Even dimensions: odd sizes break some encoders and chroma subsampling.
  const scaledWidth = Math.max(2, Math.round((opts.frameWidth * Math.max(0.02, t.scale)) / 2) * 2)
  const scaledHeight = Math.max(2, Math.round((opts.frameHeight * Math.max(0.02, t.scale)) / 2) * 2)

  const chain: string[] = ['format=rgba', `scale=${scaledWidth}:${scaledHeight}`]
  if (alpha < 1) chain.push(`colorchannelmixer=aa=${alpha.toFixed(4)}`)

  // Centred at scale 1 / x=0 / y=0; x and y are -1..1 fractions of a half
  // frame, the same convention `TimelineTransform` documents.
  let left = Math.round((opts.frameWidth - scaledWidth) / 2 + (t.x * opts.frameWidth) / 2)
  let top = Math.round((opts.frameHeight - scaledHeight) / 2 + (t.y * opts.frameHeight) / 2)

  if (t.rotation % 360 !== 0) {
    const radians = (t.rotation * Math.PI) / 180
    // Rotating about the centre onto a transparent canvas big enough for the
    // corners, so nothing is clipped at an angle — same trick as the watermark.
    chain.push(
      `rotate=${radians.toFixed(6)}:ow=rotw(${radians.toFixed(6)}):oh=roth(${radians.toFixed(6)}):c=none`
    )
    const grownWidth = Math.abs(scaledWidth * Math.cos(radians)) + Math.abs(scaledHeight * Math.sin(radians))
    const grownHeight = Math.abs(scaledWidth * Math.sin(radians)) + Math.abs(scaledHeight * Math.cos(radians))
    left -= Math.round((grownWidth - scaledWidth) / 2)
    top -= Math.round((grownHeight - scaledHeight) / 2)
  }

  const filterComplex =
    `color=c=black:s=${opts.frameWidth}x${opts.frameHeight}[bg];` +
    `[${opts.videoLabel}]${chain.join(',')}[fg];` +
    `[bg][fg]overlay=${left}:${top}:shortest=1[${opts.outputLabel}]`

  return { filterComplex, outputLabel: opts.outputLabel }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
