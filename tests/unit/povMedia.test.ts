import { describe, expect, it } from 'vitest'
import {
  audioCapablePovs,
  buildClipMappings,
  expandClipsForExport,
  refreshClipMappings,
  videoCapablePovs
} from '../../src/shared/povMapping.js'
import type { PovExportMode } from '../../src/shared/povMapping.js'
import type { ClipSegment, StreamInfo, VodSource } from '../../src/shared/types.js'

/**
 * A clip is a multi-POV object: every angle that covers the moment carries its
 * own picture and its own sound, with its own range and its own availability.
 */

function pov(id: string, startRealTime: number, formats?: StreamInfo[]): VodSource {
  return {
    id,
    platform: 'twitch',
    vodId: id,
    url: `https://twitch.tv/videos/${id}`,
    title: `${id} stream`,
    creator: id,
    durationSeconds: 7200,
    playbackKind: 'hls',
    capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
    formatsInspected: Boolean(formats),
    formats,
    syncMapping: {
      vodId: id,
      vodStartRealTime: startRealTime,
      offsetSeconds: 0,
      driftRate: 0,
      confidence: 0.95,
      method: 'platform_metadata',
      anchorIds: [],
      lastValidatedAt: null,
      warnings: []
    }
  }
}

const stream = (over: Partial<StreamInfo>): StreamInfo => ({
  id: 's',
  container: 'mp4',
  protocol: 'http-range',
  label: 'x',
  url: 'https://example.invalid/x',
  hasVideo: true,
  hasAudio: true,
  ...over
})

const clip = (over: Partial<ClipSegment> = {}): ClipSegment => ({
  id: 'c1',
  name: 'Bank job',
  sourceId: 'a',
  startSeconds: 600,
  endSeconds: 660,
  durationSeconds: 60,
  order: 0,
  status: 'idle',
  eventStartTime: 1_000_600,
  eventEndTime: 1_000_660,
  ...over
})

const A = pov('a', 1_000_000)
const B = pov('b', 1_000_060) // started a minute later

describe('a clip covers every POV that was recording', () => {
  it('gives each POV its own picture and sound, on its own clock', () => {
    const mappings = buildClipMappings(clip(), [A, B], 'now')
    expect(mappings).toHaveLength(2)

    const a = mappings.find((m) => m.sourceId === 'a')!
    const b = mappings.find((m) => m.sourceId === 'b')!

    expect(a.media.video.available).toBe(true)
    expect(a.media.audio.available).toBe(true)
    expect(a.media.video.startSeconds).toBe(600)

    // B started 60s later, so the same real-world moment is 60s earlier in it.
    expect(b.media.video.startSeconds).toBe(540)
    expect(b.media.audio.startSeconds).toBe(540)
  })

  it('gives picture and sound the same range, because they are the same seconds', () => {
    const [a] = buildClipMappings(clip(), [A], 'now')
    expect(a.media.video).toEqual(a.media.audio)
  })

  it('says so when a source has no sound to give', () => {
    const silent = pov('c', 1_000_000, [stream({ hasVideo: true, hasAudio: false })])
    const [c] = buildClipMappings(clip(), [silent], 'now')
    expect(c.media.video.available).toBe(true)
    expect(c.media.audio.available).toBe(false)
    expect(audioCapablePovs(clip({ povMappings: [c] }), [silent])).toEqual([])
    expect(videoCapablePovs(clip({ povMappings: [c] }), [silent]).map((s) => s.id)).toEqual(['c'])
  })

  it('offers nothing from a POV that was not recording', () => {
    const late = pov('d', 1_000_900) // started after the clip ended
    const [d] = buildClipMappings(clip(), [late], 'now')
    expect(d.media.video.available).toBe(false)
    expect(d.media.audio.available).toBe(false)
  })
})

describe('a POV loaded after the clip was made', () => {
  it('joins every existing clip without anything being recreated', () => {
    const clips = [clip({ id: 'c1' }), clip({ id: 'c2', startSeconds: 1000, endSeconds: 1060, eventStartTime: 1_001_000, eventEndTime: 1_001_060 })]
    const before = refreshClipMappings(clips, [A], 'now')
    expect(before.every((c) => c.povMappings!.length === 1)).toBe(true)

    // Day 3: another angle turns up.
    const after = refreshClipMappings(before, [A, B], 'later')
    for (const c of after) {
      expect(c.povMappings).toHaveLength(2)
      const added = c.povMappings!.find((m) => m.sourceId === 'b')!
      expect(added.media.video.available).toBe(true)
      expect(added.media.audio.available).toBe(true)
      // Derived from the event clock, not copied from the POV it was made in.
      expect(added.media.video.startSeconds).toBe(c.povMappings![0].media.video.startSeconds - 60)
    }
  })
})

describe('expandClipsForExport', () => {
  const mappings = buildClipMappings(clip(), [A, B], 'now')
  const covered = clip({ povMappings: mappings })

  it('leaves a "main POV" clip untouched', () => {
    const out = expandClipsForExport([covered], [A, B], () => ({ kind: 'main' }))
    expect(out).toEqual([covered])
  })

  it('expands "all POVs" into one variant per covering source, ids kept distinct', () => {
    const out = expandClipsForExport([covered], [A, B], () => ({ kind: 'all' }))
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id).sort()).toEqual([`${covered.id}-a`, `${covered.id}-b`])
    for (const variant of out) {
      expect(variant.audioSourceId).toBeUndefined()
      expect(['a', 'b']).toContain(variant.videoSourceId)
    }
  })

  it('"certain" only expands into the chosen sources', () => {
    const mode: PovExportMode = { kind: 'certain', sourceIds: new Set(['b']) }
    const out = expandClipsForExport([covered], [A, B], () => mode)
    expect(out).toHaveLength(1)
    expect(out[0].videoSourceId).toBe('b')
    expect(out[0].id).toBe(`${covered.id}-b`)
  })

  it('falls back to the original clip when "certain" picks nothing that covers it', () => {
    const mode: PovExportMode = { kind: 'certain', sourceIds: new Set(['does-not-exist']) }
    const out = expandClipsForExport([covered], [A, B], () => mode)
    expect(out).toEqual([covered])
  })

  it('resolves each clip independently by id', () => {
    const other = clip({ id: 'c2', povMappings: mappings })
    const out = expandClipsForExport(
      [covered, other],
      [A, B],
      (id): PovExportMode => (id === covered.id ? { kind: 'all' } : { kind: 'main' })
    )
    expect(out.filter((c) => c.id.startsWith(`${covered.id}-`))).toHaveLength(2)
    expect(out.some((c) => c.id === other.id)).toBe(true)
  })
})
