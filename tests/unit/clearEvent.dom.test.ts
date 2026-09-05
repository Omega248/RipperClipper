import { describe, expect, it } from 'vitest'
import { useStore } from '../../src/renderer/src/store.js'
import type { ProjectFile, VodSource } from '../../src/shared/types.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'

/**
 * Emptying an event in place.
 *
 * The point of `clearEvent` is that it is not "New project": the file, its
 * name and its output folder survive, and the whole thing is one undo step
 * rather than one per POV. Both halves are load-bearing — a clear that
 * silently kept a stale playhead, or that undo could only half restore, would
 * be worse than removing the POVs by hand.
 */

function pov(id: string): VodSource {
  return {
    id,
    platform: 'twitch',
    vodId: id,
    url: `https://example.invalid/${id}`,
    title: id,
    creator: id,
    durationSeconds: 3600,
    playbackKind: 'progressive',
    capabilities: { notes: [] },
    formatsInspected: false
  }
}

function project(): ProjectFile {
  const now = new Date().toISOString()
  return {
    schemaVersion: 5,
    id: 'p',
    name: 'Nightclub robbery',
    createdAt: now,
    updatedAt: now,
    sources: [],
    clips: [],
    markers: [],
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
    outputDirectory: 'D:\\clips'
  }
}

function loaded(): void {
  const store = useStore.getState()
  store.setProject(project(), 'D:\\projects\\night.cookieclip')
  store.addSource(pov('a'))
  store.addSource(pov('b'))
  useStore.getState().setActiveSource('a')
  useStore.getState().setCurrentTime(120)
  useStore.getState().setInPoint(100)
  useStore.getState().setOutPoint(140)
  useStore.getState().createClip('A clip')
  useStore.getState().addMarker('A marker')
  useStore.getState().setEventInfo({ name: 'Nightclub robbery' })
}

describe('clearEvent', () => {
  it('empties the POVs, clips, markers and event block', () => {
    loaded()
    expect(useStore.getState().project?.sources).toHaveLength(2)
    expect(useStore.getState().project?.clips.length).toBeGreaterThan(0)

    useStore.getState().clearEvent()

    const after = useStore.getState().project
    expect(after?.sources).toEqual([])
    expect(after?.clips).toEqual([])
    expect(after?.markers).toEqual([])
    expect(after?.event).toBeUndefined()
  })

  it('keeps the project itself — this is not New project', () => {
    loaded()
    useStore.getState().clearEvent()

    const state = useStore.getState()
    expect(state.project?.name).toBe('Nightclub robbery')
    expect(state.project?.id).toBe('p')
    expect(state.project?.outputDirectory).toBe('D:\\clips')
    expect(state.projectPath).toBe('D:\\projects\\night.cookieclip')
    expect(state.dirty).toBe(true)
  })

  it('resets the transport and every selection that pointed at something gone', () => {
    loaded()
    useStore.getState().clearEvent()

    const state = useStore.getState()
    expect(state.activeSourceId).toBeNull()
    expect(state.selectedClipId).toBeNull()
    expect(state.inPoint).toBeNull()
    expect(state.outPoint).toBeNull()
    expect(state.currentTime).toBe(0)
    expect(state.duration).toBe(0)
    expect(state.playing).toBe(false)
    expect(state.reviewRun).toEqual([])
  })

  it('is a single undo step that puts all of it back', () => {
    loaded()
    const before = useStore.getState().project
    const clipCount = before?.clips.length ?? 0
    const markerCount = before?.markers.length ?? 0

    useStore.getState().clearEvent()
    useStore.getState().undo()

    const after = useStore.getState().project
    expect(after?.sources).toHaveLength(2)
    expect(after?.clips).toHaveLength(clipCount)
    expect(after?.markers).toHaveLength(markerCount)
    // The event block is restored too — it is in the history entry.
    expect(after?.event?.name).toBe('Nightclub robbery')
  })

  it('redo clears it again', () => {
    loaded()
    useStore.getState().clearEvent()
    useStore.getState().undo()
    useStore.getState().redo()

    expect(useStore.getState().project?.sources).toEqual([])
    expect(useStore.getState().project?.event).toBeUndefined()
  })
})

/*
 * Renaming an event pushed a history entry that did not carry the event, so
 * undo restored the other four fields and left the new name sitting there.
 * This is the regression test for that, not for clearEvent.
 */
describe('undo covers the event block', () => {
  it('puts back the previous event name', () => {
    loaded()
    expect(useStore.getState().project?.event?.name).toBe('Nightclub robbery')

    useStore.getState().setEventInfo({ name: 'Something else entirely' })
    expect(useStore.getState().project?.event?.name).toBe('Something else entirely')

    useStore.getState().undo()
    expect(useStore.getState().project?.event?.name).toBe('Nightclub robbery')
  })
})
