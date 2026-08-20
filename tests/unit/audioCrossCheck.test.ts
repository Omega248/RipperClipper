import { describe, expect, it } from 'vitest'
import { hasAudioAnchor, strongestSyncedSibling } from '../../src/renderer/src/sync/audioCrossCheck.js'
import type { SyncAnchor, VodTimeMapping } from '../../src/shared/sync.js'
import type { VodSource } from '../../src/shared/types.js'

function mapping(confidence: number, method: VodTimeMapping['method'] = 'platform_metadata'): VodTimeMapping {
  return {
    vodId: 'x',
    vodStartRealTime: 1_700_000_000,
    offsetSeconds: 0,
    driftRate: 0,
    confidence,
    method,
    anchorIds: [],
    lastValidatedAt: null,
    warnings: []
  }
}

function pov(id: string, syncMapping?: VodTimeMapping): VodSource {
  return {
    id,
    platform: 'twitch',
    vodId: id,
    url: `https://example.invalid/${id}`,
    title: id,
    creator: id,
    durationSeconds: 3600,
    playbackKind: 'progressive',
    capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
    formatsInspected: false,
    syncMapping
  }
}

describe('strongestSyncedSibling', () => {
  it('skips the excluded POV and anything unsynced', () => {
    const sources = [pov('a', mapping(0.9)), pov('b'), pov('c', mapping(0.6))]
    expect(strongestSyncedSibling(sources, 'a')?.id).toBe('c')
  })

  it('picks the highest-confidence synced POV', () => {
    const sources = [pov('a', mapping(0.7)), pov('b', mapping(0.95)), pov('c', mapping(0.8))]
    expect(strongestSyncedSibling(sources, 'a')?.id).toBe('b')
  })

  it('returns null when nothing else is synced', () => {
    const sources = [pov('a', mapping(0.9)), pov('b')]
    expect(strongestSyncedSibling(sources, 'a')).toBeNull()
  })
})

describe('hasAudioAnchor', () => {
  const base: Omit<SyncAnchor, 'vodId' | 'source'> = {
    id: 'anchor_1',
    eventTime: 0,
    localTime: 0,
    weight: 1,
    createdAt: new Date().toISOString()
  }

  it('is false with no matching anchor', () => {
    const anchors: SyncAnchor[] = [{ ...base, vodId: 'a', source: 'platform_metadata' }]
    expect(hasAudioAnchor(anchors, 'a')).toBe(false)
  })

  it('is true once an audio_anchor exists for that vodId', () => {
    const anchors: SyncAnchor[] = [
      { ...base, vodId: 'a', source: 'event_anchor' },
      { ...base, vodId: 'a', source: 'audio_anchor' }
    ]
    expect(hasAudioAnchor(anchors, 'a')).toBe(true)
  })

  it("does not credit one POV's audio anchor to another", () => {
    const anchors: SyncAnchor[] = [{ ...base, vodId: 'b', source: 'audio_anchor' }]
    expect(hasAudioAnchor(anchors, 'a')).toBe(false)
  })
})
