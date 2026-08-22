/**
 * Drawing a POV's name as a watermark image.
 *
 * The whole point of watermarking a multi-POV export is answering "whose
 * angle am I looking at", and that answer is *text* the app already knows —
 * the character name, the POV label, or the channel. Requiring an imported
 * logo per streamer to say it meant ten file pickers before a ten-POV export.
 *
 * Rendered here rather than in the main process because the renderer is
 * Chromium: text shaping, fallback fonts and antialiasing all come for free.
 * The PNG is then handed to the ordinary watermark library, so positioning,
 * opacity, rotation and the export filter graph are entirely unchanged and
 * an imported logo and a generated badge are indistinguishable downstream.
 */

/** Rendered at 2x the nominal size so it stays crisp scaled onto 1080p+. */
const SCALE = 2
const FONT_PX = 34
const PAD_X = 22
const PAD_Y = 12

export interface BadgeStyle {
  /** Text colour. */
  color?: string
  /** Pill colour behind the text. Transparent disables the pill. */
  background?: string
  /** Rounded corner radius, in nominal px. */
  radius?: number
}

/**
 * A transparent PNG of `text` on a rounded pill, as a data URL.
 *
 * Sized to the text rather than to a fixed box, so a short name does not sit
 * in a wide empty rectangle — the watermark's own width setting then scales
 * the whole badge proportionally, exactly as it does an imported logo.
 */
export function drawNameBadge(text: string, style: BadgeStyle = {}): string | null {
  const label = text.trim()
  if (label === '') return null

  const color = style.color ?? '#ffffff'
  const background = style.background ?? 'rgba(0, 0, 0, 0.55)'
  const radius = style.radius ?? 8

  // Measure first, on a throwaway context, so the real canvas can be sized to
  // the text instead of guessing and cropping.
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) return null
  const font = `600 ${FONT_PX}px "Segoe UI", system-ui, -apple-system, sans-serif`
  measure.font = font
  const width = Math.ceil(measure.measureText(label).width)

  const canvas = document.createElement('canvas')
  canvas.width = (width + PAD_X * 2) * SCALE
  canvas.height = (FONT_PX + PAD_Y * 2) * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.scale(SCALE, SCALE)
  ctx.font = font
  ctx.textBaseline = 'middle'

  const boxW = width + PAD_X * 2
  const boxH = FONT_PX + PAD_Y * 2

  if (background !== 'transparent') {
    ctx.fillStyle = background
    roundedRect(ctx, 0, 0, boxW, boxH, radius)
    ctx.fill()
  }

  ctx.fillStyle = color
  ctx.fillText(label, PAD_X, boxH / 2)

  return canvas.toDataURL('image/png')
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}
