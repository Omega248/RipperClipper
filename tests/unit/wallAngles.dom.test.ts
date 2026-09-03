import { describe, expect, it } from 'vitest'
import { useStore } from '../../src/renderer/src/store.js'
import { firstScreenful, wallSelection } from '../../src/shared/multiPov.js'
import { DEFAULT_ANGLE_CEILING, DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { ProjectFile, VodSource } from '../../src/shared/types.js'

/**
 * Ticking an angle off has to reach the wall, survive a save, and touch
 * nothing else.
 *
 * `wallSelection` is unit-tested on its own; this covers the wiring around it,
 * which is where the same feature has gone wrong before — a pure function that
 * is right, called with the wrong thing, or a view choice quietly deleting a
 * clip.
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
    createdAt: '2026-08-17T20:00:00Z',
    playbackKind: 'progressive',
    capabilities: { notes: [] },
    formatsInspected: false
  }
}

function load(count: number): void {
  const now = new Date().toISOString()
  const empty: ProjectFile = {
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
  useStore.getState().setProject(empty, null)
  for (let i = 0; i < count; i++) useStore.getState().addSource(pov(`p${i}`))
}

const sources = (): VodSource[] => useStore.getState().project!.sources

describe('the wall angle picker', () => {
  it('reaches the wall: unticking removes the tile and frees a decode slot', () => {
    load(10)
    useStore.getState().setActiveSource('p0')

    const before = wallSelection(sources(), 'p0', 8)
    expect(before.shown).toHaveLength(10)
    expect(before.decoding.has('p9')).toBe(false)

    useStore.getState().setWallAngles(['p1', 'p2', 'p3'])
    const after = wallSelection(sources(), 'p0', 8)
    expect(after.shown).toHaveLength(7)
    expect(after.decoding.has('p9')).toBe(true)
    expect(after.hiddenCount).toBe(3)
  })

  it('is a view choice — the POV keeps everything else about it', () => {
    load(3)
    const before = sources()[1]
    useStore.getState().setWallAngles(['p1'])
    const after = sources()[1]
    expect(after.id).toBe(before.id)
    expect(after.syncMapping).toEqual(before.syncMapping)
    expect(after.durationSeconds).toBe(before.durationSeconds)
    expect(sources()).toHaveLength(3)
  })

  it('writes nothing on an angle nobody has unticked', () => {
    load(3)
    useStore.getState().setWallAngles([])
    // Absent, not `false`: a project file should not record a non-choice.
    expect('hiddenInWall' in sources()[0]).toBe(false)
  })

  it('clears the flag again when the angle is ticked back on', () => {
    load(3)
    useStore.getState().setWallAngles(['p2'])
    expect(sources()[2].hiddenInWall).toBe(true)
    useStore.getState().setWallAngles([])
    expect('hiddenInWall' in sources()[2]).toBe(false)
  })

  it('marks the project dirty so the choice is actually saved', () => {
    load(3)
    useStore.setState({ dirty: false })
    useStore.getState().setWallAngles(['p1'])
    expect(useStore.getState().dirty).toBe(true)
  })

  it('does not touch the project when nothing changed', () => {
    load(3)
    useStore.getState().setWallAngles(['p1'])
    const project = useStore.getState().project
    useStore.getState().setWallAngles(['p1'])
    expect(useStore.getState().project).toBe(project)
  })

  it('"First N" lands on a wall that fully decodes', () => {
    // More angles than the ceiling, whatever the ceiling currently is — the
    // shortcut only has anything to do when there are angles over it.
    const focused = `p${DEFAULT_ANGLE_CEILING - 2}`
    load(DEFAULT_ANGLE_CEILING + 6)
    useStore.getState().setActiveSource(focused)
    useStore.getState().setWallAngles(firstScreenful(sources(), focused, DEFAULT_ANGLE_CEILING))

    const { shown, decoding } = wallSelection(sources(), focused, DEFAULT_ANGLE_CEILING)
    expect(shown).toHaveLength(DEFAULT_ANGLE_CEILING)
    expect(decoding.size).toBe(DEFAULT_ANGLE_CEILING)
    expect(shown.map((s) => s.id)).toContain(focused)
  })
})
