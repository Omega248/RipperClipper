/**
 * Watermarks.
 *
 * A watermark is stored as a *transform*, never as pixels: a normalised
 * position and a width expressed as a fraction of the frame. The same
 * configuration therefore lands in the same visual place on a 720p clip and a
 * 1440p one, which is the whole point — an editor positions a logo once and it
 * stays put across every VOD and every quality.
 *
 * Precedence is deliberate and one-directional:
 *
 *     streamer default  →  VOD override  →  what gets rendered
 *
 * Editing a VOD never writes back to the streamer default. That only happens
 * when the editor explicitly asks for it, because "I nudged it on this clip"
 * and "this is where my logo lives forever" are different intentions.
 */

/** Which point of the watermark is pinned to the stored position. */
export type WatermarkAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export const WATERMARK_ANCHORS: WatermarkAnchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
]

export const ANCHOR_LABEL: Record<WatermarkAnchor, string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'center-left': 'Centre left',
  center: 'Centre',
  'center-right': 'Centre right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right'
}

/** An image in the app's own watermark library. */
export interface WatermarkImage {
  id: string
  name: string
  /** Absolute path inside the application's data folder. */
  path: string
  /** Intrinsic pixel size, used to keep the aspect ratio honest. */
  width: number
  height: number
  addedAt: string
}

export interface WatermarkConfig {
  enabled: boolean
  /** Which image from the library. Null means nothing to draw. */
  imageId: string | null
  anchor: WatermarkAnchor
  /**
   * Where the anchor point sits in the frame, 0..1 from the top-left. Stored
   * normalised so the position survives a change of resolution.
   */
  x: number
  y: number
  /** Watermark width as a fraction of frame width, 0..1. */
  width: number
  /** Degrees clockwise. */
  rotation: number
  /** 0..1. */
  opacity: number
  /** Height follows the image's own proportions while this is on. */
  lockAspect: boolean
  /**
   * Height as a fraction of frame *height*, used only when the aspect ratio has
   * been unlocked. Ignored otherwise, because a locked watermark's height is a
   * consequence of its width and the image, not an independent fact.
   */
  height?: number
}

/** The inset used by the anchor presets, as a fraction of the frame. */
export const SAFE_MARGIN = 0.025

export function defaultWatermark(imageId: string | null = null): WatermarkConfig {
  return {
    enabled: imageId !== null,
    imageId,
    ...anchorPosition('top-right'),
    width: 0.12,
    rotation: 0,
    opacity: 0.9,
    lockAspect: true
  }
}

/** Where a named anchor puts the watermark, with a safe margin off the edge. */
export function anchorPosition(anchor: WatermarkAnchor): {
  anchor: WatermarkAnchor
  x: number
  y: number
} {
  const [vertical, horizontal] = anchor.split('-') as [string, string]
  const x = horizontal === 'left' ? SAFE_MARGIN : horizontal === 'right' ? 1 - SAFE_MARGIN : 0.5
  const y = vertical === 'top' ? SAFE_MARGIN : vertical === 'bottom' ? 1 - SAFE_MARGIN : 0.5
  return { anchor, x, y }
}

/** How far the anchor point sits into the watermark box, 0..1 on each axis. */
export function anchorFractions(anchor: WatermarkAnchor): { fx: number; fy: number } {
  const [vertical, horizontal] = anchor.split('-') as [string, string]
  return {
    fx: horizontal === 'left' ? 0 : horizontal === 'right' ? 1 : 0.5,
    fy: vertical === 'top' ? 0 : vertical === 'bottom' ? 1 : 0.5
  }
}

/** The watermark's box in a frame of the given pixel size. */
export interface WatermarkBox {
  /** Top-left corner and size, in frame pixels, before rotation. */
  left: number
  top: number
  width: number
  height: number
}

/**
 * Resolve the transform against a real frame size.
 *
 * One function, used by the on-screen editor, the live preview and the export
 * filter, so what the editor drags is what FFmpeg draws. If these ever
 * disagreed, the watermark would move between preview and output — which is the
 * failure mode this exists to prevent.
 */
export function watermarkBox(
  config: WatermarkConfig,
  frame: { width: number; height: number },
  image: { width: number; height: number }
): WatermarkBox {
  const width = Math.max(1, config.width * frame.width)
  const aspect = image.height > 0 && image.width > 0 ? image.height / image.width : 1
  const height =
    config.lockAspect || config.height === undefined
      ? width * aspect
      : Math.max(1, config.height * frame.height)

  const { fx, fy } = anchorFractions(config.anchor)
  return {
    left: config.x * frame.width - width * fx,
    top: config.y * frame.height - height * fy,
    width,
    height
  }
}

/** Turn a dragged pixel position back into the stored normalised transform. */
export function positionFromBox(
  box: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number },
  anchor: WatermarkAnchor
): { x: number; y: number } {
  const { fx, fy } = anchorFractions(anchor)
  return {
    x: clamp01((box.left + box.width * fx) / Math.max(1, frame.width)),
    y: clamp01((box.top + box.height * fy) / Math.max(1, frame.height))
  }
}

/**
 * The configuration that actually applies to a VOD.
 *
 * The VOD's own settings win when it has any; otherwise the streamer's default
 * is used as-is. Returning null — rather than a disabled config — lets callers
 * skip the whole watermark path, which is what keeps a stream copy possible.
 */
export function resolveWatermark(
  vodOverride: WatermarkConfig | null | undefined,
  streamerDefault: WatermarkConfig | null | undefined
): { config: WatermarkConfig; from: 'vod' | 'streamer' } | null {
  const chosen = vodOverride ?? streamerDefault ?? null
  if (!chosen || !chosen.enabled || !chosen.imageId) return null
  return { config: chosen, from: vodOverride ? 'vod' : 'streamer' }
}

/** Everything the exporter needs to draw one, with no lookups of its own. */
export interface ResolvedWatermark {
  config: WatermarkConfig
  imagePath: string
  imageWidth: number
  imageHeight: number
}

export function sanitizeWatermark(input: unknown): WatermarkConfig | null {
  if (typeof input !== 'object' || input === null) return null
  const w = input as Record<string, unknown>
  const anchor = WATERMARK_ANCHORS.includes(w.anchor as WatermarkAnchor)
    ? (w.anchor as WatermarkAnchor)
    : 'top-right'
  return {
    enabled: Boolean(w.enabled),
    imageId: typeof w.imageId === 'string' ? w.imageId : null,
    anchor,
    x: clamp01(num(w.x, anchorPosition(anchor).x)),
    y: clamp01(num(w.y, anchorPosition(anchor).y)),
    width: Math.min(1, Math.max(0.01, num(w.width, 0.12))),
    rotation: ((num(w.rotation, 0) % 360) + 360) % 360,
    opacity: clamp01(num(w.opacity, 1)),
    lockAspect: w.lockAspect !== false,
    height: typeof w.height === 'number' ? clamp01(w.height) : undefined
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * The saved streamer a VOD belongs to, if any.
 *
 * Matching is by platform plus channel handle, falling back to the creator
 * name for sources ingested before handles were recorded. One definition so
 * the preview, the editor and the exporter can never disagree about whose
 * default applies.
 */
export function streamerFor<T extends { platform: string; handle: string; watermark?: WatermarkConfig }>(
  streamers: readonly T[],
  source: { platform: string; channelHandle?: string | null; creator: string }
): T | null {
  const handle = (source.channelHandle ?? source.creator).toLowerCase()
  return (
    streamers.find((st) => st.platform === source.platform && st.handle.toLowerCase() === handle) ??
    null
  )
}
