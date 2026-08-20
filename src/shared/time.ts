/**
 * Timecode parsing and formatting.
 *
 * Internal representation is always a number of seconds (float, ms precision).
 */

const TIMECODE_RE = /^(?:(\d+):)?(?:([0-5]?\d):)?([0-5]?\d)(?:[.,](\d{1,3}))?$/

/**
 * Parse a human timecode into seconds.
 *
 * Accepts: "12", "1:23", "01:23:45", "01:23:45.500", "1:23:45,5"
 * Returns null when the input is not a valid timecode.
 */
export function parseTimecode(input: string): number | null {
  const raw = input.trim()
  if (raw === '') return null

  // Bare number of seconds, possibly fractional.
  if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
    const n = Number(raw.replace(',', '.'))
    return Number.isFinite(n) ? roundMs(n) : null
  }

  const m = TIMECODE_RE.exec(raw)
  if (!m) return null

  const [, g1, g2, g3, frac] = m
  let hours = 0
  let minutes = 0
  const seconds = Number(g3)

  if (g1 !== undefined && g2 !== undefined) {
    hours = Number(g1)
    minutes = Number(g2)
  } else if (g1 !== undefined) {
    // "M:SS"
    minutes = Number(g1)
  }

  if (minutes > 59 || seconds > 59) return null

  let total = hours * 3600 + minutes * 60 + seconds
  if (frac !== undefined) total += Number(frac.padEnd(3, '0')) / 1000
  return roundMs(total)
}

/** Format seconds as HH:MM:SS.mmm (millisecond precision). */
export function formatTimecode(seconds: number, opts: { millis?: boolean } = {}): string {
  const withMillis = opts.millis !== false
  if (!Number.isFinite(seconds)) return withMillis ? '00:00:00.000' : '00:00:00'
  const negative = seconds < 0
  const total = Math.abs(roundMs(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const ms = Math.round((total - Math.floor(total)) * 1000)
  const base = `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`
  const out = withMillis ? `${base}.${pad(ms, 3)}` : base
  return negative ? `-${out}` : out
}

/** Compact duration for lists: "02:40" or "1:02:40". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${pad(m, 2)}:${pad(s, 2)}`
}

/** ffmpeg accepts plain seconds; emit fixed precision to avoid locale/exponent issues. */
export function toFfmpegTime(seconds: number): string {
  return Math.max(0, roundMs(seconds)).toFixed(3)
}

export function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

export interface RangeValidationResult {
  ok: boolean
  errors: string[]
}

/** Validate a clip range against its source duration. */
export function validateRange(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number,
  opts: { minDurationSeconds?: number } = {}
): RangeValidationResult {
  const min = opts.minDurationSeconds ?? 0.05
  const errors: string[] = []

  if (!Number.isFinite(startSeconds)) errors.push('Start is not a valid time.')
  if (!Number.isFinite(endSeconds)) errors.push('End is not a valid time.')
  if (errors.length > 0) return { ok: false, errors }

  if (startSeconds < 0) errors.push('Start must be at or after 00:00:00.000.')
  if (endSeconds <= startSeconds) errors.push('End must be later than Start.')
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    if (endSeconds > durationSeconds + 0.001) {
      errors.push(`End must be at or before the VOD duration (${formatTimecode(durationSeconds)}).`)
    }
    if (startSeconds >= durationSeconds) {
      errors.push('Start must be inside the VOD.')
    }
  }
  if (endSeconds - startSeconds < min && errors.length === 0) {
    errors.push(`Selection must be at least ${min.toFixed(2)}s long.`)
  }

  return { ok: errors.length === 0, errors }
}

/** Clamp a range into [0, duration] preserving its length where possible. */
export function clampRange(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number
): { startSeconds: number; endSeconds: number } {
  const length = Math.max(0.05, endSeconds - startSeconds)
  let start = Math.max(0, startSeconds)
  let end = start + length
  if (Number.isFinite(durationSeconds) && durationSeconds > 0 && end > durationSeconds) {
    end = durationSeconds
    start = Math.max(0, end - length)
  }
  return { startSeconds: roundMs(start), endSeconds: roundMs(end) }
}

/** Merge overlapping/adjacent ranges — used to avoid downloading the same media twice. */
export function mergeRanges(
  ranges: Array<{ startSeconds: number; endSeconds: number }>,
  gapToleranceSeconds = 0
): Array<{ startSeconds: number; endSeconds: number }> {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.startSeconds - b.startSeconds)
  const out: Array<{ startSeconds: number; endSeconds: number }> = [
    { startSeconds: sorted[0].startSeconds, endSeconds: sorted[0].endSeconds }
  ]
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]
    const next = sorted[i]
    if (next.startSeconds <= last.endSeconds + gapToleranceSeconds) {
      last.endSeconds = Math.max(last.endSeconds, next.endSeconds)
    } else {
      out.push({ startSeconds: next.startSeconds, endSeconds: next.endSeconds })
    }
  }
  return out
}
