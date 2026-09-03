import { describe, expect, it } from 'vitest'
import {
  fitPxPerSecond,
  timelineBands,
  nearestSnap,
  rulerTicks,
  snapCandidates,
  snapSpanStart,
  tickSpacing
} from '@shared/timelineView'
import { addItem, addMarker, emptyTimeline } from '@shared/timeline'
import type { EditorTimeline } from '@shared/types'

/**
 * The editor's ruler and its magnetism. Both are things you can only really
 * *see* go wrong — a label every 7 seconds, an edge that snaps from half a
 * screen away — so they are asserted here rather than eyeballed.
 */

describe('tickSpacing', () => {
  it('labels at intervals a human reads without doing division', () => {
    // Every spacing it can ever choose comes off the ladder, at every zoom.
    const readable = new Set([0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600])
    for (let pps = 0.5; pps < 400; pps *= 1.2) {
      expect(readable.has(tickSpacing(pps).major)).toBe(true)
    }
  })

  it('gives every label room to sit', () => {
    for (let pps = 0.5; pps < 400; pps *= 1.2) {
      const { major } = tickSpacing(pps, 76)
      // Either the interval is wide enough, or it is the widest one there is.
      expect(major * pps >= 76 || major === 21600).toBe(true)
    }
  })

  it('zooms in to sub-second ticks and out to whole hours', () => {
    expect(tickSpacing(400).major).toBeLessThanOrEqual(0.5)
    expect(tickSpacing(0.02).major).toBeGreaterThanOrEqual(3600)
  })

  it('subdivides only while the subdivisions are still visible', () => {
    const fine = tickSpacing(30)
    expect(fine.minor).toBeLessThan(fine.major)
    expect(fine.minor * 30).toBeGreaterThanOrEqual(7)
    // Nothing to gain from minor ticks a pixel apart.
    const coarse = tickSpacing(0.02)
    expect(coarse.minor * 0.02).toBeGreaterThanOrEqual(7)
  })
})

describe('rulerTicks', () => {
  it('marks the whole window, labelling the major ones', () => {
    const ticks = rulerTicks(0, 60, 10, { major: 10, minor: 5 })
    expect(ticks.map((t) => t.seconds)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60])
    expect(ticks.filter((t) => t.major).map((t) => t.seconds)).toEqual([0, 10, 20, 30, 40, 50, 60])
  })

  it('does not drift on fractional spacings', () => {
    // 0.1 added three hundred times is not 30 in binary floating point; a
    // ruler that drifts puts its labels between the ticks it is labelling.
    const ticks = rulerTicks(0, 30, 200, { major: 1, minor: 0.1 })
    const majors = ticks.filter((t) => t.major).map((t) => t.seconds)
    expect(majors).toContain(7)
    expect(majors).toContain(23)
    expect(majors.every((s) => Number.isInteger(s))).toBe(true)
  })

  it('never runs away on a degenerate window', () => {
    expect(rulerTicks(0, 0, 10)).toEqual([])
    expect(rulerTicks(10, 5, 10)).toEqual([])
    expect(rulerTicks(0, 1e9, 200).length).toBeLessThanOrEqual(4000)
  })

  it('starts at a whole interval, not at whatever the window starts at', () => {
    const ticks = rulerTicks(13, 40, 10, { major: 10, minor: 10 })
    expect(ticks[0].seconds).toBe(10)
  })
})

describe('fitPxPerSecond', () => {
  it('puts the whole sequence in the space available', () => {
    expect(fitPxPerSecond(1200, 60, 1, 400)).toBe(20)
  })

  it('stays inside the editor limits', () => {
    expect(fitPxPerSecond(1200, 100000, 1, 400)).toBe(1)
    expect(fitPxPerSecond(1200, 0.5, 1, 400)).toBe(400)
  })

  it('answers something usable before anything has been measured', () => {
    expect(fitPxPerSecond(0, 60, 1, 400)).toBe(24)
    expect(fitPxPerSecond(1200, 0, 1, 400)).toBe(24)
  })
})

function withItems(): EditorTimeline {
  let t = emptyTimeline()
  const video = t.tracks[0].id
  t = addItem(t, {
    trackId: video,
    kind: 'video',
    sourceId: 'a',
    sourceStartSeconds: 0,
    sourceEndSeconds: 10,
    timelineStartSeconds: 0,
    timelineEndSeconds: 10
  }).timeline
  t = addItem(t, {
    trackId: video,
    kind: 'video',
    sourceId: 'b',
    sourceStartSeconds: 0,
    sourceEndSeconds: 5,
    timelineStartSeconds: 20,
    timelineEndSeconds: 25
  }).timeline
  return addMarker(t, { timeSeconds: 17, name: 'Here' }).timeline
}

describe('snapCandidates', () => {
  it('offers the start, the playhead, every edge and every marker', () => {
    const points = snapCandidates(withItems(), { playheadSeconds: 3.5 }).sort((a, b) => a - b)
    expect(points).toEqual([0, 3.5, 10, 17, 20, 25])
  })

  it('leaves out the item being dragged, so it cannot snap to where it already is', () => {
    const timeline = withItems()
    const first = timeline.items[0].id
    const points = snapCandidates(timeline, { excludeItemIds: [first] })
    expect(points).not.toContain(10)
    expect(points).toContain(20)
  })
})

describe('nearestSnap', () => {
  it('takes the closest candidate inside the tolerance', () => {
    expect(nearestSnap(10.2, [0, 10, 20], 0.5)).toBe(10)
    expect(nearestSnap(9.8, [0, 10, 20], 0.5)).toBe(10)
  })

  it('refuses everything outside it', () => {
    expect(nearestSnap(15, [0, 10, 20], 0.5)).toBeNull()
  })

  it('snaps to nothing at all when snapping is off', () => {
    expect(nearestSnap(10, [10], 0)).toBeNull()
  })
})

describe('snapSpanStart', () => {
  it('lands a clip flush against the one before it', () => {
    expect(snapSpanStart(10.3, 5, [0, 10, 20], 0.5)).toBe(10)
  })

  it('back-times a clip when it is the *end* that is near a point', () => {
    // Dragged so its tail is just past the playhead at 20: the tail lands on
    // 20 and the head follows, which is how you make a cut end on a beat.
    expect(snapSpanStart(15.2, 5, [0, 10, 20], 0.5)).toBe(15)
  })

  it('prefers whichever edge is actually closer', () => {
    // Head is 0.4 from 10, tail is 0.1 from 20 — the tail wins.
    expect(snapSpanStart(9.6, 10.5, [10, 20], 0.5)).toBeCloseTo(9.5, 6)
  })

  it('leaves the drag alone when nothing is near', () => {
    expect(snapSpanStart(13.7, 2, [0, 40], 0.5)).toBe(13.7)
  })
})

describe('the filmstrip band', () => {
  const opts = { rulerHeight: 20, markerHeight: 16, minClipHeight: 84, maxLaneHeight: 15 }

  it('sits under the ruler and pushes everything below it down', () => {
    const bare = timelineBands(300, 0, opts)
    const withFilm = timelineBands(300, 0, { ...opts, filmHeight: 64 })

    expect(withFilm.filmTop).toBe(20)
    expect(withFilm.filmHeight).toBe(64)
    expect(withFilm.clipTop).toBe(bare.clipTop + 64)
    expect(withFilm.clipHeight).toBe(bare.clipHeight - 64)
  })

  it('is dropped whole rather than squeezing the clips lane', () => {
    // 20 ruler + 6 pad + 84 clips + 16 markers + 6 pad = 132 before any film.
    const tight = timelineBands(150, 0, { ...opts, filmHeight: 64 })
    expect(tight.filmHeight).toBe(0)
    expect(tight.clipHeight).toBeGreaterThanOrEqual(84)
  })

  it('keeps the clips lane at its floor once it does fit', () => {
    const b = timelineBands(196, 0, { ...opts, filmHeight: 64 })
    expect(b.filmHeight).toBe(64)
    expect(b.clipHeight).toBeGreaterThanOrEqual(84)
  })

  it('leaves room for the angle rows as well', () => {
    const b = timelineBands(400, 6, { ...opts, filmHeight: 64 })
    expect(b.filmHeight).toBe(64)
    expect(b.povTop).toBeGreaterThanOrEqual(b.filmTop + b.filmHeight)
    expect(b.clipTop).toBeGreaterThanOrEqual(b.povTop + b.povLaneHeight * 6)
    expect(b.clipHeight).toBeGreaterThanOrEqual(84)
  })
})

describe('timelineBands', () => {
  const opts = { rulerHeight: 20, markerHeight: 16, minClipHeight: 56, maxLaneHeight: 15 }

  it('is the timeline it always was when there are no angle rows', () => {
    const b = timelineBands(104, 0, opts)
    expect(b).toMatchObject({ povLaneHeight: 0, povTotal: 0, clipTop: 26 })
    expect(b.clipHeight).toBe(104 - 26 - 16 - 6)
  })

  it('never squeezes the clips lane below its floor, however many angles load', () => {
    for (const count of [1, 3, 9, 20, 40]) {
      const b = timelineBands(236, count, opts)
      expect(b.clipHeight).toBeGreaterThanOrEqual(opts.minClipHeight)
    }
  })

  it('keeps angle rows readable rather than growing them to fill the space', () => {
    // Two angles in a tall timeline: rows stay 15px, they do not become 60px bars.
    expect(timelineBands(400, 2, opts).povLaneHeight).toBe(15)
  })

  it('thins the rows rather than overflowing when there are many angles', () => {
    const b = timelineBands(236, 12, opts)
    expect(b.povLaneHeight).toBeLessThan(15)
    expect(b.povLaneHeight).toBeGreaterThanOrEqual(7)
  })

  it('drops the band entirely rather than drawing unreadable hairlines', () => {
    // The real case: nine angles in a 124px canvas (the all-POVs strip) works
    // out at under 2px a row — a coloured hairline with no label, costing the
    // clips lane the height it needs. Better to show none and say so.
    const b = timelineBands(124, 9, opts)
    expect(b.povLaneHeight).toBe(0)
    expect(b.povTotal).toBe(0)
    // And the clips lane gets that height back.
    expect(b.clipHeight).toBe(124 - 26 - 16 - 6)
  })

  it('keeps the rows the moment there is room for readable ones', () => {
    expect(timelineBands(236, 9, opts).povLaneHeight).toBeGreaterThanOrEqual(7)
  })

  it('honours a caller that wants hairlines anyway', () => {
    expect(timelineBands(124, 9, { ...opts, minReadableLaneHeight: 1 }).povLaneHeight).toBeGreaterThan(0)
  })

  it('stacks the bands without gaps or overlap', () => {
    const b = timelineBands(236, 9, opts)
    expect(b.povTop).toBe(22)
    // Every row fits above where the clips lane starts.
    expect(b.povTop + b.povLaneHeight * 9).toBeLessThanOrEqual(b.clipTop)
    // And the clips lane ends exactly where the marker lane begins.
    expect(b.clipTop + b.clipHeight).toBe(236 - 16 - 6)
  })

  it('degrades without going negative in a timeline too short to hold anything', () => {
    const b = timelineBands(30, 9, opts)
    expect(b.clipHeight).toBeGreaterThanOrEqual(0)
    // No room for anything means no angle rows, not nine hairlines.
    expect(b.povLaneHeight).toBe(0)
  })
})
