import { describe, expect, it } from 'vitest'
import { useStore } from '../../src/renderer/src/store.js'
import type { ProjectFile, VodSource } from '../../src/shared/types.js'
import type { SyncAnchor } from '../../src/shared/sync.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'

/**
 * addSyncAnchors is the store-level landing point for audio cross-check
 * evidence: it must fold into the same weighted solver every other kind of
 * anchor already goes through, touch only the POVs the new anchors actually
 * reference, and never override a manual correction.
 */

function pov(id: string, startedIso: string | undefined): VodSource {
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
    schemaVersion: 4,
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
  useStore.getState().setProject(project(), null)
  for (const source of sources) useStore.getState().addSource(source)
}

function anchor(vodId: string, localTime: number, eventTime: number): SyncAnchor {
  return {
    id: `anchor_${vodId}_${localTime}`,
    vodId,
    eventTime,
    localTime,
    source: 'audio_anchor',
    weight: 0.8,
    createdAt: new Date().toISOString()
  }
}

describe('addSyncAnchors', () => {
  it('refines an existing mapping and records the anchor', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), pov('b', '2026-08-17T20:00:30Z')])
    const eventTime = Date.parse('2026-08-17T20:01:00Z') / 1000

    useStore.getState().addSyncAnchors([anchor('a', 60, eventTime), anchor('b', 32, eventTime)])

    const after = useStore.getState().project!
    expect(after.syncAnchors?.map((a) => a.source)).toEqual(['audio_anchor', 'audio_anchor'])
    const b = after.sources.find((s) => s.id === 'b')!.syncMapping!
    expect(b.anchorIds).toContain('anchor_b_32')
  })

  it('only touches the POVs the new anchors reference', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), pov('b', '2026-08-17T20:00:30Z')])
    const before = useStore.getState().project!.sources.find((s) => s.id === 'a')!.syncMapping

    useStore.getState().addSyncAnchors([anchor('b', 32, Date.parse('2026-08-17T20:01:00Z') / 1000)])

    const after = useStore.getState().project!.sources.find((s) => s.id === 'a')!.syncMapping
    expect(after).toEqual(before)
  })

  it('never overrides a manual mapping', () => {
    load([pov('a', '2026-08-17T20:00:00Z'), pov('b', '2026-08-17T20:00:30Z')])
    useStore.getState().nudgeSync('b', 5)
    const manual = useStore.getState().project!.sources.find((s) => s.id === 'b')!.syncMapping!
    expect(manual.method).toBe('manual')

    useStore.getState().addSyncAnchors([anchor('b', 32, Date.parse('2026-08-17T20:05:00Z') / 1000)])

    const after = useStore.getState().project!.sources.find((s) => s.id === 'b')!.syncMapping!
    expect(after.method).toBe('manual')
    expect(after.offsetSeconds).toBe(manual.offsetSeconds)
  })

  it('does nothing on an empty anchor list', () => {
    load([pov('a', '2026-08-17T20:00:00Z')])
    const before = useStore.getState().project
    useStore.getState().addSyncAnchors([])
    expect(useStore.getState().project).toBe(before)
  })
})
