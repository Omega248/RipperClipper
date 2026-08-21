import { describe, expect, it } from 'vitest'
import { useStore } from '../../src/renderer/src/store.js'
import type { ProjectFile, VodSource } from '../../src/shared/types.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'

/**
 * Switching POV must land on the same real-world moment, not on zero — that is
 * the whole point of storing the event timeline rather than VOD timelines.
 */

function pov(id: string, startedIso: string): VodSource {
  return {
    id,
    platform: 'twitch',
    vodId: id,
    url: `https://example.invalid/${id}`,
    title: id,
    creator: id,
    durationSeconds: 3600,
    createdAt: startedIso,
    playbackKind: 'progressive',
    capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
    formatsInspected: false
  }
}

function project(): ProjectFile {
  const now = new Date().toISOString()
  return {
    schemaVersion: 5,
    id: 'p',
    name: 'p',
    createdAt: now,
    updatedAt: now,
    sources: [],
    clips: [],
    markers: [],
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
    outputDirectory: null
  }
}

function load(sources: VodSource[]): void {
  const store = useStore.getState()
  store.setProject(project(), null)
  for (const source of sources) useStore.getState().addSource(source)
}

describe('POV switching', () => {
  it('derives a real-world mapping from platform metadata', () => {
    load([pov('a', '2026-08-17T20:00:00Z')])
    const mapping = useStore.getState().project!.sources[0].syncMapping!
    expect(mapping.method).toBe('platform_metadata')
    expect(mapping.vodStartRealTime).toBe(Date.parse('2026-08-17T20:00:00Z') / 1000)
  })

  it('lands on the same instant in the other POV', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), pov('b', '2026-08-17T20:00:30Z')])
    useStore.getState().setActiveSource('a')
    useStore.setState({ currentTime: 38.946 })

    useStore.getState().setActiveSource('b')
    expect(useStore.getState().currentTime).toBeCloseTo(8.946, 3)

    useStore.getState().setActiveSource('a')
    expect(useStore.getState().currentTime).toBeCloseTo(38.946, 3)
  })

  it('starts at zero when a POV has no known real-world timing', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), { ...pov('b', ''), createdAt: undefined }])
    useStore.getState().setActiveSource('a')
    useStore.setState({ currentTime: 100 })
    useStore.getState().setActiveSource('b')
    expect(useStore.getState().currentTime).toBe(0)
  })

  it('clamps to the other POV when the moment falls outside it', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), pov('b', '2026-08-17T21:00:00Z')])
    useStore.getState().setActiveSource('a')
    useStore.setState({ currentTime: 10 })
    useStore.getState().setActiveSource('b')
    // b had not started recording yet: clamped to its first frame, never negative.
    expect(useStore.getState().currentTime).toBe(0)
  })
})

describe('removing a POV', () => {
  it('takes its clips and markers with it, and is undoable', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), pov('b', '2026-08-17T20:00:30Z')])
    useStore.getState().setActiveSource('a')
    useStore.setState({ inPoint: 10, outPoint: 20 })
    useStore.getState().createClip('From A')
    useStore.getState().setActiveSource('b')
    useStore.setState({ inPoint: 5, outPoint: 15 })
    useStore.getState().createClip('From B')
    expect(useStore.getState().project!.clips).toHaveLength(2)

    useStore.getState().removeSource('b')
    const after = useStore.getState()
    expect(after.project!.sources.map((s) => s.id)).toEqual(['a'])
    expect(after.project!.clips.map((c) => c.name)).toEqual(['From A'])
    expect(after.activeSourceId).toBe('a')

    useStore.getState().undo()
    const restored = useStore.getState()
    expect(restored.project!.sources.map((s) => s.id)).toEqual(['a', 'b'])
    expect(restored.project!.clips).toHaveLength(2)
  })

  it('never leaves the editor pointed at a POV that is gone', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), pov('b', '2026-08-17T20:00:30Z')])
    useStore.getState().setActiveSource('b')
    useStore.getState().removeSource('b')
    expect(useStore.getState().activeSourceId).toBe('a')

    useStore.getState().undo()
    useStore.getState().redo()
    const ids = useStore.getState().project!.sources.map((s) => s.id)
    expect(ids).toEqual(['a'])
    expect(ids).toContain(useStore.getState().activeSourceId)
  })
})
