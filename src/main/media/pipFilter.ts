import type { TimelineTransform } from '../../shared/types.js'
import { DEFAULT_PIP_TRANSFORM, isIdentityTransform } from '../../shared/timeline.js'

/**
 * A second POV composited as an inset over the first — an FFmpeg filter
 * graph, same technique as `watermarkFilter.ts` (scale the overlay, then
 * `overlay` it at a computed pixel position) but overlaying a real video
 * input instead of a looped still image.
 *
 * The inset's own audio is never mapped anywhere in the caller's args, so
 * it's silently excluded without needing anything here to mute it.
 */

export interface PipFilterPlan {
  filterComplex: string
  outputLabel: string
}

export function buildPipFilter(
  transform: TimelineTransform | undefined | null,
  opts: {
    /** The real frame size for this export, from ffprobe. */
    frameWidth: number
    frameHeight: number
    backgroundLabel: string
    insetLabel: string
    outputLabel: string
  }
): PipFilterPlan {
  const t = transform && !isIdentityTransform(transform) ? transform : DEFAULT_PIP_TRANSFORM

  // Even dimensions: odd sizes break some encoders and chroma subsampling.
  const scaledWidth = Math.max(2, Math.round((opts.frameWidth * Math.max(0.05, Math.min(1, t.scale))) / 2) * 2)
  const scaledHeight = Math.max(2, Math.round((opts.frameHeight * Math.max(0.05, Math.min(1, t.scale))) / 2) * 2)

  // Same -1..1-fraction-of-a-half-frame convention as buildTransformFilter.
  const left = Math.round((opts.frameWidth - scaledWidth) / 2 + (t.x * opts.frameWidth) / 2)
  const top = Math.round((opts.frameHeight - scaledHeight) / 2 + (t.y * opts.frameHeight) / 2)

  // Deliberately no `shortest=1` here, unlike the watermark/transform
  // filters: those need it because their second input is either an
  // infinitely-looped still image or a synthetic same-length background —
  // this one is a genuinely separate fetched window that can come back a
  // few milliseconds shorter or longer than the main video by nothing more
  // than segment-boundary rounding. `shortest=1` would truncate the whole
  // composited output to whichever happened to be shorter; the default
  // `eof_action=repeat` instead just holds the inset's last frame if it
  // runs out first, and the real length is still enforced by `-t` below.
  const filterComplex =
    `[${opts.insetLabel}]scale=${scaledWidth}:${scaledHeight}[pipimg];` +
    `[${opts.backgroundLabel}][pipimg]overlay=${left}:${top}[${opts.outputLabel}]`

  return { filterComplex, outputLabel: opts.outputLabel }
}
