import type { EditorTimeline } from './types.js'

/**
 * The arithmetic behind what the editor's timeline *looks* like — ticks,
 * snapping, zoom-to-fit.
 *
 * None of it touches React, so all of it is testable on its own. A ruler that
 * labels every 7 seconds, or an edge that snaps to a point 40px away, is a bug
 * you can only see; keeping the maths here is how it gets asserted instead.
 */

/**
 * Tick spacings a human reads without doing division: sub-second, seconds,
 * the quarter/half minute, minutes, then the quarter/half hour. Deliberately
 * not powers of ten — nobody thinks in 100-second intervals.
 */
const LADDER = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600
]

export interface TickSpacing {
  /** Seconds between labelled ticks. */
  major: number
  /** Seconds between unlabelled ticks. Equal to `major` when there is no room for more. */
  minor: number
}

/**
 * How far apart to put ticks at this zoom: the first ladder step wide enough
 * that its label has room, subdivided while the subdivisions stay legible.
 */
export function tickSpacing(pxPerSecond: number, minLabelPx = 76, minTickPx = 7): TickSpacing {
  if (!(pxPerSecond > 0)) return { major: LADDER[LADDER.length - 1], minor: LADDER[LADDER.length - 1] }
  const major = LADDER.find((s) => s * pxPerSecond >= minLabelPx) ?? LADDER[LADDER.length - 1]
  const minor = [5, 4, 2].map((d) => major / d).find((s) => s * pxPerSecond >= minTickPx) ?? major
  return { major, minor }
}

export interface Tick {
  seconds: number
  /** Labelled. Minor ticks are just a line. */
  major: boolean
}

/**
 * Every tick in a visible window. Bounded at 4000 marks so a nonsense zoom
 * (or a duration of zero) can never spin here — past that the ruler is a solid
 * bar anyway.
 */
export function rulerTicks(
  fromSeconds: number,
  toSeconds: number,
  pxPerSecond: number,
  spacing: TickSpacing = tickSpacing(pxPerSecond)
): Tick[] {
  const out: Tick[] = []
  if (!(toSeconds > fromSeconds) || !(spacing.minor > 0)) return out
  const first = Math.floor(Math.max(0, fromSeconds) / spacing.minor) * spacing.minor
  for (let t = first, guard = 0; t <= toSeconds && guard < 4000; t += spacing.minor, guard++) {
    if (t < 0) continue
    // Float error accumulates over thousands of additions: 0.1 * 3 is not 0.3.
    // Rounding to the millisecond is finer than anything the ruler can draw and
    // makes the major test exact.
    const seconds = Math.round(t * 1000) / 1000
    const ratio = seconds / spacing.major
    out.push({ seconds, major: Math.abs(ratio - Math.round(ratio)) < 1e-6 })
  }
  return out
}

/** Zoom that puts `durationSeconds` in `laneWidthPx`, within the editor's limits. */
export function fitPxPerSecond(
  laneWidthPx: number,
  durationSeconds: number,
  min: number,
  max: number
): number {
  if (!(durationSeconds > 0) || !(laneWidthPx > 0)) return Math.min(max, Math.max(min, 24))
  return Math.max(min, Math.min(max, laneWidthPx / durationSeconds))
}

/**
 * Everything an edge can land exactly on: the sequence start, the playhead,
 * every marker, and every other item's own start and end — so two clips
 * dragged near each other land flush, with no sliver of a gap, the way a
 * magnetic timeline behaves. Items being dragged are excluded so they never
 * snap to where they already are.
 */
export function snapCandidates(
  timeline: EditorTimeline,
  opts: { playheadSeconds?: number; excludeItemIds?: Iterable<string> } = {}
): number[] {
  const exclude = new Set(opts.excludeItemIds ?? [])
  const points = new Set<number>([0])
  if (opts.playheadSeconds !== undefined) points.add(opts.playheadSeconds)
  for (const item of timeline.items) {
    if (exclude.has(item.id)) continue
    points.add(item.timelineStartSeconds)
    points.add(item.timelineEndSeconds)
  }
  for (const marker of timeline.markers) points.add(marker.timeSeconds)
  return [...points]
}

/** The closest candidate within `tolerance`, or null when nothing is near enough. */
export function nearestSnap(value: number, points: number[], tolerance: number): number | null {
  if (!(tolerance > 0)) return null
  let best: number | null = null
  let bestDistance = tolerance
  for (const point of points) {
    const distance = Math.abs(point - value)
    // `<=` so an exact tie prefers the later candidate deterministically; the
    // distance is what matters, not which of two equals wins.
    if (distance <= bestDistance) {
      bestDistance = distance
      best = point
    }
  }
  return best
}

/**
 * Snaps whichever end of a `[start, start + duration)` span is nearer a
 * candidate, and returns the start that puts it there. Snapping the leading
 * edge and the trailing edge are both useful — dropping a clip so its *end*
 * lands on the playhead is how you back-time a cut.
 */
export function snapSpanStart(
  rawStart: number,
  duration: number,
  points: number[],
  tolerance: number
): number {
  const snappedStart = nearestSnap(rawStart, points, tolerance)
  const snappedEnd = nearestSnap(rawStart + duration, points, tolerance)
  if (snappedStart !== null && snappedEnd !== null) {
    return Math.abs(snappedStart - rawStart) <= Math.abs(snappedEnd - duration - rawStart)
      ? snappedStart
      : snappedEnd - duration
  }
  if (snappedStart !== null) return snappedStart
  if (snappedEnd !== null) return snappedEnd - duration
  return rawStart
}

/** The broadcast timeline's vertical layout, in canvas pixels. */
export interface TimelineBands {
  /** The filmstrip's top edge. */
  filmTop: number
  /** Height of the filmstrip band. Zero when there is no room for one. */
  filmHeight: number
  /** First angle row's top edge. */
  povTop: number
  /** Height of one angle row. Zero when there are no angle rows. */
  povLaneHeight: number
  /** Total height the angle rows occupy, including their separator. */
  povTotal: number
  /** The clips lane. */
  clipTop: number
  clipHeight: number
}

/**
 * Where each band of the broadcast timeline sits.
 *
 * Shared because the canvas draws from it and the pointer hit-tests against
 * it: two copies of this arithmetic is how you get a timeline where clicking
 * an angle row selects the clip underneath it, or where the marked region is
 * drawn a few pixels above the edge you can actually grab.
 */
export function timelineBands(
  height: number,
  povCount: number,
  opts: {
    rulerHeight: number
    markerHeight: number
    minClipHeight: number
    maxLaneHeight: number
    /**
     * Thinner than this and an angle row is a coloured hairline: no label
     * fits, two adjacent colours are hard to tell apart, and it is costing
     * the clips lane height it could use. Below the threshold the whole band
     * is dropped rather than drawn uselessly — the caller says so in words
     * instead. Default 7px.
     */
    minReadableLaneHeight?: number
    /**
     * The filmstrip under the ruler. Requested rather than guaranteed: it is
     * the first thing dropped when the strip is short, because a picture of
     * the broadcast is worth less than being able to grab a clip's edge.
     */
    filmHeight?: number
  }
): TimelineBands {
  const { rulerHeight, markerHeight, minClipHeight, maxLaneHeight } = opts
  const minReadable = opts.minReadableLaneHeight ?? 7
  /** Breathing room above the clips lane, below it, and under the angle rows. */
  const TOP_PAD = 6
  const BOTTOM_PAD = 6
  const POV_TOP_PAD = 2
  const POV_GAP = 4

  /*
   * The filmstrip is fitted first and dropped whole.
   *
   * Everything below it keeps its floor, so on a short strip the frames are
   * what goes rather than the clips lane thinning to a hairline — half a
   * filmstrip is not worth a clip edge you cannot grab.
   */
  const wantsFilm = Math.max(0, opts.filmHeight ?? 0)
  const spare =
    height - (rulerHeight + TOP_PAD + markerHeight + BOTTOM_PAD + minClipHeight + wantsFilm)
  const filmHeight = wantsFilm > 0 && spare >= 0 ? wantsFilm : 0
  const afterFilm = rulerHeight + filmHeight

  const withoutBand = (): TimelineBands => {
    const clipTop = afterFilm + TOP_PAD
    return {
      filmTop: rulerHeight,
      filmHeight,
      povTop: afterFilm,
      povLaneHeight: 0,
      povTotal: 0,
      clipTop,
      clipHeight: Math.max(0, height - clipTop - markerHeight - BOTTOM_PAD)
    }
  }
  if (povCount <= 0) return withoutBand()

  // Everything that is neither an angle row nor the clips lane. Counting it
  // here is what makes `minClipHeight` an actual floor: leaving it out of the
  // budget quietly overspent by the padding and the clips lane came up short.
  const chrome = afterFilm + TOP_PAD + POV_GAP + markerHeight + BOTTOM_PAD
  const budget = Math.max(0, height - chrome - minClipHeight)
  const povLaneHeight = Math.min(maxLaneHeight, budget / povCount)
  if (povLaneHeight < minReadable) return withoutBand()
  const povTotal = povLaneHeight * povCount + POV_GAP
  const clipTop = afterFilm + TOP_PAD + povTotal
  return {
    filmTop: rulerHeight,
    filmHeight,
    povTop: afterFilm + POV_TOP_PAD,
    povLaneHeight,
    povTotal,
    clipTop,
    clipHeight: Math.max(0, height - clipTop - markerHeight - BOTTOM_PAD)
  }
}
