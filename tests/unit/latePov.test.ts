import { describe, expect, it } from 'vitest'
import { useStore } from '../../src/renderer/src/store.js'
import { clipPovRanges, clipRangeInPov, coverageSummary, planExport } from '../../src/shared/povMapping.js'
import type { ProjectFile, VodSource } from '../../src/shared/types.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'

/**
 * THE LATE-POV ACCEPTANCE TEST.
 *
 * Two POVs, three clips, then a third POV turns up. Every existing clip must
 * map onto it with no recreation, no manual timestamps and no reload. Because
 * clips are stored in event time and POV ranges are derived, this is a property
 * of the model rather than a backfill routine that can be forgotten.
 */

function pov(id: string, startedIso: string, durationSeconds = 7200): VodSource {
  return {
    id,
    platform: 'twitch',
    vodId: id,
    url: `https://example.invalid/${id}`,
    title: id,
    creator: id,
    durationSeconds,
    createdAt: startedIso,
    playbackKind: 'progressive',
    capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
    formatsInspected: false
  }
}

function emptyProject(): ProjectFile {
  const now = new Date().toISOString()
  return {
    schemaVersion: 5,
    id: 'p',
    name: 'MRPD Shootout',
    createdAt: now,
    updatedAt: now,
    sources: [],
    clips: [],
    markers: [],
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
    outputDirectory: null
  }
}

function makeClip(name: string, start: number, end: number): void {
  useStore.setState({ inPoint: start, outPoint: end })
  useStore.getState().createClip(name)
}

describe('a POV discovered after the clips exist', () => {
  it('inherits every clip, with honest coverage, and no clip is recreated', () => {
    // Player A starts at 20:00:00, Player B thirty seconds later.
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))

    useStore.getState().setActiveSource('A')
    makeClip('MRPD Shootout', 600, 720)
    makeClip('Police Chase', 1800, 1920)
    makeClip('Dean Gets Shot', 3600, 3660)

    const before = useStore.getState().project!.clips
    expect(before).toHaveLength(3)
    expect(before.every((c) => c.eventStartTime !== null)).toBe(true)
    const idsBefore = before.map((c) => c.id)

    // Player C is discovered later: it started an hour in and is short, so it
    // covers the last clip only.
    useStore.getState().addSource(pov('C', '2026-08-17T21:00:00Z', 1800))
    const after = useStore.getState().project!
    const c = after.sources.find((s) => s.id === 'C')!

    // No clip was recreated, renamed or re-timed.
    expect(after.clips.map((x) => x.id)).toEqual(idsBefore)

    const ranges = after.clips.map((clip) => clipRangeInPov(clip, c))
    expect(ranges.map((r) => r.coverage)).toEqual(['none', 'none', 'full'])

    // 20:00:00 + 3600s = 21:00:00, which is C's own zero.
    const third = ranges[2]
    expect(third.localStart).toBeCloseTo(0, 3)
    expect(third.localEnd).toBeCloseTo(60, 3)
    expect(third.authored).toBe(false)
  })

  it('reports partial coverage rather than inventing the missing part', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Bank Robbery', 1000, 1120)

    // D starts 60s into the clip, so it has the last minute only.
    useStore.getState().addSource(pov('D', '2026-08-17T20:17:40Z', 3600))
    const project = useStore.getState().project!
    const clip = project.clips[0]
    const d = project.sources.find((s) => s.id === 'D')!
    const range = clipRangeInPov(clip, d)

    expect(range.coverage).toBe('partial')
    expect(range.localStart).toBe(0)
    expect(range.localEnd).toBeCloseTo(60, 3)
    expect(range.requestedLocalStart).toBeLessThan(0)
  })

  it('summarises coverage across every POV', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().addSource(pov('E', '2026-08-18T04:00:00Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Ballas War', 600, 720)

    const project = useStore.getState().project!
    const summary = coverageSummary(clipPovRanges(project.clips[0], project.sources))
    expect(summary.full).toBe(2) // A (authored) and B
    expect(summary.none).toBe(1) // E, a different day
    expect(summary.usable).toBe(2)
  })

  it('leaves coverage unknown when a POV has no real-world timing', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Something', 100, 200)
    useStore.getState().addSource({ ...pov('U', ''), createdAt: undefined })

    const project = useStore.getState().project!
    const u = project.sources.find((s) => s.id === 'U')!
    expect(clipRangeInPov(project.clips[0], u).coverage).toBe('unknown')
  })
})

describe('choosing which POV supplies picture and sound', () => {
  it('cuts the video from one POV and the audio from another, each in its own time', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().setActiveSource('A')
    makeClip('MRPD Shootout', 600, 720)

    const clipId = useStore.getState().project!.clips[0].id
    useStore.getState().setClipPov(clipId, 'video', 'B')
    useStore.getState().setClipPov(clipId, 'audio', 'A')

    const project = useStore.getState().project!
    const plan = planExport(project.clips[0], project.sources)!
    expect(plan.video.source.id).toBe('B')
    expect(plan.video.startSeconds).toBeCloseTo(570, 3) // B started 30s later
    expect(plan.audio!.source.id).toBe('A')
    expect(plan.audio!.startSeconds).toBeCloseTo(600, 3)
    expect(plan.warnings).toEqual([])
  })

  it('falls back to the authoring POV instead of exporting a POV that cannot cover it', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('F', '2026-08-18T09:00:00Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Police Chase', 600, 720)

    const clipId = useStore.getState().project!.clips[0].id
    useStore.getState().setClipPov(clipId, 'video', 'F')

    const project = useStore.getState().project!
    const plan = planExport(project.clips[0], project.sources)!
    expect(plan.video.source.id).toBe('A')
    expect(plan.warnings.join(' ')).toMatch(/does not cover/i)
  })
})

/**
 * Clip creation captures the whole POV set in one commit (spec §1, §2, §9).
 */
describe('creating a clip captures every loaded POV', () => {
  it('produces the clip and all POV mappings in a single state change', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    // C joined 60s into the clip, so it has the tail only.
    useStore.getState().addSource(pov('C', '2026-08-17T20:17:40Z', 600))
    useStore.getState().addSource(pov('D', '2026-08-18T09:00:00Z')) // another day
    useStore.getState().setActiveSource('A')

    // Every intermediate state the UI could observe must already have the
    // complete POV set — no clip is ever seen half-attached.
    const seen: number[] = []
    const stop = useStore.subscribe((state) => {
      for (const clip of state.project?.clips ?? []) seen.push(clip.povMappings?.length ?? 0)
    })
    makeClip('MRPD Shootout', 1000, 1120)
    stop()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((n) => n === 4)).toBe(true)

    const clip = useStore.getState().project!.clips[0]
    const byId = Object.fromEntries((clip.povMappings ?? []).map((m) => [m.sourceId, m]))

    expect(byId.A.status).toBe('available')
    expect(byId.A.authored).toBe(true)
    expect(byId.B.status).toBe('available')
    expect(byId.B.vodStartSeconds).toBeCloseTo(970, 3) // B started 30s later
    expect(byId.C.status).toBe('partial')
    expect(byId.D.status).toBe('out_of_range')

    // Coverage states carry their evidence.
    expect(byId.B.confidence).toBeGreaterThan(0.9)
    expect(byId.B.method).toBe('platform_metadata')
  })

  it('marks a POV that has no timing as needing sync, not as covering the clip', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource({ ...pov('X', ''), createdAt: undefined })
    useStore.getState().setActiveSource('A')
    makeClip('Unknown timing', 10, 40)

    const clip = useStore.getState().project!.clips[0]
    const x = clip.povMappings!.find((m) => m.sourceId === 'X')!
    expect(x.status).toBe('sync_required')
  })

  it('adds a late POV to every existing clip mapping set, without recreating clips', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)
    makeClip('Clip 2', 1800, 1860)
    const idsBefore = useStore.getState().project!.clips.map((c) => c.id)
    expect(useStore.getState().project!.clips[0].povMappings).toHaveLength(2)

    useStore.getState().addSource(pov('C', '2026-08-17T20:05:00Z'))

    const clips = useStore.getState().project!.clips
    expect(clips.map((c) => c.id)).toEqual(idsBefore)
    for (const clip of clips) {
      expect(clip.povMappings).toHaveLength(3)
      const c = clip.povMappings!.find((m) => m.sourceId === 'C')!
      expect(c.status).toBe('available')
    }
    // 600s into A is 300s into C, which started five minutes later.
    expect(clips[0].povMappings!.find((m) => m.sourceId === 'C')!.vodStartSeconds).toBeCloseTo(300, 3)
  })

  it('drops mappings for a POV removed from the event', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)

    useStore.getState().removeSource('B')
    const clip = useStore.getState().project!.clips[0]
    expect(clip.povMappings!.map((m) => m.sourceId)).toEqual(['A'])
  })

  it('re-maps every POV when the clip range is moved', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)
    const clipId = useStore.getState().project!.clips[0].id

    useStore.getState().patchClip(clipId, { startSeconds: 900, endSeconds: 1000 })
    const clip = useStore.getState().project!.clips[0]
    expect(clip.povMappings!.find((m) => m.sourceId === 'B')!.vodStartSeconds).toBeCloseTo(870, 3)
  })
})

/**
 * Per-clip corrections and the padding that covers an uncertain alignment.
 */
describe('correcting one clip without disturbing the others', () => {
  it('shifts only the clip it was applied to', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)
    makeClip('Clip 2', 1800, 1860)

    const [first, second] = useStore.getState().project!.clips
    const bBefore = second.povMappings!.find((m) => m.sourceId === 'B')!.vodStartSeconds

    useStore.getState().setClipPovOffset(first.id, 'B', 1.5)

    const clips = useStore.getState().project!.clips
    expect(clips[0].povMappings!.find((m) => m.sourceId === 'B')!.vodStartSeconds).toBeCloseTo(571.5, 3)
    // The other clip is untouched.
    expect(clips[1].povMappings!.find((m) => m.sourceId === 'B')!.vodStartSeconds).toBe(bBefore)
    // And the POV's own mapping was not rewritten.
    expect(useStore.getState().project!.sources.find((s) => s.id === 'B')!.syncMapping!.method).toBe(
      'platform_metadata'
    )
  })

  it('clears the correction when it is set back to zero', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)
    const id = useStore.getState().project!.clips[0].id

    useStore.getState().setClipPovOffset(id, 'B', 2)
    expect(useStore.getState().project!.clips[0].povOffsets).toEqual({ B: 2 })
    useStore.getState().setClipPovOffset(id, 'B', 0)
    expect(useStore.getState().project!.clips[0].povOffsets).toEqual({})
  })

  it('is undoable like any other edit', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)
    const id = useStore.getState().project!.clips[0].id

    useStore.getState().setClipPovOffset(id, 'B', 3)
    useStore.getState().undo()
    expect(useStore.getState().project!.clips[0].povOffsets ?? {}).toEqual({})
  })
})

describe('padding an uncertain export', () => {
  /**
   * Add a POV whose timing came from something weaker than platform metadata —
   * a transcript match, say. `addSource` re-solves from metadata, so the weak
   * mapping is applied afterwards, exactly as a solver result would be.
   */
  function addWeak(id: string, startedIso: string, confidence: number): void {
    useStore.getState().addSource(pov(id, startedIso))
    const project = useStore.getState().project!
    useStore.setState({
      project: {
        ...project,
        sources: project.sources.map((s) =>
          s.id === id
            ? {
                ...s,
                syncMapping: {
                  vodId: id,
                  vodStartRealTime: Date.parse(startedIso) / 1000,
                  offsetSeconds: 0,
                  driftRate: 0,
                  confidence,
                  method: 'transcript_anchor' as const,
                  anchorIds: [],
                  lastValidatedAt: null,
                  warnings: []
                }
              }
            : s
        )
      }
    })
  }

  it('adds head and tail when the alignment is a guess', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)
    addWeak('B', '2026-08-17T20:00:30Z', 0.6)

    const project = useStore.getState().project!
    const clip = { ...project.clips[0], videoSourceId: 'B' }
    const plan = planExport(clip, project.sources, { paddingSeconds: 2 })!

    expect(plan.video.source.id).toBe('B')
    expect(plan.video.startSeconds).toBeCloseTo(568, 3) // 570 - 2
    expect(plan.video.endSeconds).toBeCloseTo(692, 3) // 690 + 2
    expect(plan.video.paddingSeconds).toBe(2)
    expect(plan.warnings.join(' ')).toMatch(/padded/i)
  })

  it('cuts tight when the POV was aligned by hand', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)
    addWeak('B', '2026-08-17T20:00:30Z', 0.6)
    useStore.getState().nudgeSync('B', 0.25) // the editor lined it up

    const project = useStore.getState().project!
    const clip = { ...project.clips[0], videoSourceId: 'B' }
    const plan = planExport(clip, project.sources, { paddingSeconds: 2 })!
    expect(plan.video.paddingSeconds).toBe(0)
  })

  it('never pads past the start of a VOD', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 660)
    addWeak('B', '2026-08-17T20:09:59Z', 0.5)

    const project = useStore.getState().project!
    const clip = { ...project.clips[0], videoSourceId: 'B' }
    const plan = planExport(clip, project.sources, { paddingSeconds: 5 })!
    expect(plan.video.startSeconds).toBeGreaterThanOrEqual(0)
  })

  it('leaves a confident POV alone', () => {
    useStore.getState().setProject(emptyProject(), null)
    useStore.getState().addSource(pov('A', '2026-08-17T20:00:00Z'))
    useStore.getState().addSource(pov('B', '2026-08-17T20:00:30Z')) // 0.95 from metadata
    useStore.getState().setActiveSource('A')
    makeClip('Clip 1', 600, 720)

    const project = useStore.getState().project!
    const clip = { ...project.clips[0], videoSourceId: 'B' }
    const plan = planExport(clip, project.sources, { paddingSeconds: 2 })!
    expect(plan.video.paddingSeconds).toBe(0)
    expect(plan.video.startSeconds).toBeCloseTo(570, 3)
  })
})
