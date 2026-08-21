import { describe, expect, it } from 'vitest'
import {
  clipSpan,
  eventCoverageFraction,
  eventWindow,
  participantSummary,
  povCoverage,
  sourceWindow
} from '../../src/shared/event.js'
import type { ProjectFile, VodSource } from '../../src/shared/types.js'

/**
 * The event as the central object.
 *
 * Everything here is on the wall clock. A POV "covers" part of an event only
 * because its own broadcast window, projected through its sync mapping,
 * overlaps the event's — never because two VOD timestamps happen to match.
 */

const T0 = Date.parse('2026-08-21T18:00:00Z') / 1000

const source = (id: string, startsAt: number, durationSeconds: number): VodSource => ({
  id,
  platform: 'twitch',
  vodId: id,
  url: `https://twitch.tv/videos/${id}`,
  title: id,
  creator: id,
  durationSeconds,
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: false,
  syncMapping: {
    vodId: id,
    method: 'platform_metadata',
    confidence: 1,
    // Local second 0 of this VOD is `startsAt` on the wall clock.
    vodStartRealTime: startsAt,
    offsetSeconds: 0,
    driftRate: 0,
    anchorIds: [],
    lastValidatedAt: '2026-08-21T00:00:00Z',
    warnings: []
  }
})

const project = (over: Partial<ProjectFile> = {}): ProjectFile => ({
  schemaVersion: 5,
  id: 'proj',
  name: 'Event',
  createdAt: '',
  updatedAt: '',
  sources: [],
  clips: [],
  markers: [],
  exportSettings: {} as ProjectFile['exportSettings'],
  outputDirectory: null,
  ...over
})

describe('the event window', () => {
  it('uses the declared window when there is one', () => {
    const p = project({
      event: { name: 'Heist', startSeconds: T0, endSeconds: T0 + 1800, collections: [], moments: [] }
    })
    expect(eventWindow(p)).toEqual({ startSeconds: T0, endSeconds: T0 + 1800 })
  })

  it('gives an open-ended event a finite default, so coverage stays meaningful', () => {
    const p = project({
      event: { name: null, startSeconds: T0, endSeconds: null, collections: [], moments: [] }
    })
    expect(eventWindow(p)!.endSeconds).toBe(T0 + 30 * 60)
  })

  it('falls back to the span the clips themselves occupy', () => {
    // So the timeline and coverage map work before anyone fills in a form.
    const p = project({
      clips: [
        { eventStartTime: T0 + 60, eventEndTime: T0 + 120 } as ProjectFile['clips'][number],
        { eventStartTime: T0 + 600, eventEndTime: T0 + 700 } as ProjectFile['clips'][number]
      ]
    })
    expect(eventWindow(p)).toEqual({ startSeconds: T0 + 60, endSeconds: T0 + 700 })
  })

  it('has no window at all when nothing knows its real-world time', () => {
    expect(eventWindow(project())).toBeNull()
  })
})

describe('a POV’s own broadcast window', () => {
  it('projects local 0 and local end onto the wall clock', () => {
    const w = sourceWindow(source('a', T0 - 1800, 7200))!
    expect(w.startSeconds).toBe(T0 - 1800)
    expect(w.endSeconds).toBe(T0 - 1800 + 7200)
  })

  it('returns nothing for a POV that was never synced', () => {
    const bare = { ...source('a', T0, 60) }
    delete bare.syncMapping
    expect(sourceWindow(bare)).toBeNull()
  })
})

describe('per-POV coverage of the event', () => {
  const window = { name: null, startSeconds: T0, endSeconds: T0 + 3600, collections: [], moments: [] }

  it('reports a POV spanning the whole event as fully available', () => {
    const p = project({ sources: [source('a', T0 - 600, 7200)], event: window })
    const [c] = povCoverage(p)
    expect(c.state).toBe('available')
    expect(c.fraction).toBeCloseTo(1, 3)
  })

  it('reports a POV that joined late as partial, with the right span', () => {
    // Starts 30 min into a 60 min event → covers the back half.
    const p = project({ sources: [source('b', T0 + 1800, 7200)], event: window })
    const [c] = povCoverage(p)
    expect(c.state).toBe('partial')
    expect(c.fraction).toBeCloseTo(0.5, 3)
    expect(c.spans[0].from).toBeCloseTo(0.5, 3)
    expect(c.spans[0].to).toBeCloseTo(1, 3)
  })

  it('reports a POV that had stopped before the event as missing', () => {
    const p = project({ sources: [source('c', T0 - 7200, 3600)], event: window })
    expect(povCoverage(p)[0].state).toBe('missing')
  })

  it('distinguishes "not synced yet" from "was not recording"', () => {
    const unsynced = { ...source('d', T0, 3600) }
    delete unsynced.syncMapping
    const p = project({ sources: [unsynced], event: window })
    expect(povCoverage(p)[0].state).toBe('unknown')
  })
})

describe('overall event coverage', () => {
  const window = { name: null, startSeconds: T0, endSeconds: T0 + 3600, collections: [], moments: [] }

  it('unions overlapping POVs rather than summing them', () => {
    // Three POVs all covering the same whole hour is 100% covered, not 300%.
    const p = project({
      sources: [source('a', T0, 3600), source('b', T0, 3600), source('c', T0, 3600)],
      event: window
    })
    expect(eventCoverageFraction(p)).toBeCloseTo(1, 3)
  })

  it('adds genuinely disjoint stretches together', () => {
    // First half from one POV, second half from another → full coverage.
    const p = project({
      sources: [source('a', T0, 1800), source('b', T0 + 1800, 1800)],
      event: window
    })
    expect(eventCoverageFraction(p)).toBeCloseTo(1, 2)
  })

  it('reports a genuine gap as a gap', () => {
    const p = project({ sources: [source('a', T0, 1800)], event: window })
    expect(eventCoverageFraction(p)).toBeCloseTo(0.5, 2)
  })
})

describe('participants', () => {
  it('counts full, partial, missing and unknown separately', () => {
    const unsynced = { ...source('d', T0, 3600) }
    delete unsynced.syncMapping
    const p = project({
      sources: [
        source('a', T0 - 600, 7200), // full
        source('b', T0 + 1800, 7200), // partial
        source('c', T0 - 7200, 3600), // missing
        unsynced // unknown
      ],
      event: { name: null, startSeconds: T0, endSeconds: T0 + 3600, collections: [], moments: [] }
    })
    expect(participantSummary(p)).toEqual({
      loaded: 4,
      fullCoverage: 1,
      partialCoverage: 1,
      missing: 1,
      unknown: 1
    })
  })
})

describe('placing a clip on the event timeline', () => {
  const window = { startSeconds: T0, endSeconds: T0 + 3600 }

  it('maps a clip to its fraction of the window', () => {
    const span = clipSpan(
      { eventStartTime: T0 + 1800, eventEndTime: T0 + 2700 } as ProjectFile['clips'][number],
      window
    )!
    expect(span.from).toBeCloseTo(0.5, 3)
    expect(span.to).toBeCloseTo(0.75, 3)
  })

  it('clamps a clip that overruns the window rather than dropping it', () => {
    const span = clipSpan(
      { eventStartTime: T0 - 600, eventEndTime: T0 + 600 } as ProjectFile['clips'][number],
      window
    )!
    expect(span.from).toBe(0)
  })

  it('ignores a clip with no real-world time', () => {
    expect(clipSpan({} as ProjectFile['clips'][number], window)).toBeNull()
  })
})
