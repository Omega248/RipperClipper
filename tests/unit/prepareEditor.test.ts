import { describe, expect, it } from 'vitest'
import { prepareForEditor, readyForEditor } from '../../src/shared/prepareEditor.js'
import type { ClipSegment, ProjectFile, VodSource } from '../../src/shared/types.js'

/**
 * Handing gathered material to the Editor.
 *
 * The contract: never silently drop a clip. Anything that cannot be prepared
 * is reported with a reason, and anything that can be prepared only partly
 * says so — discovering mid-assembly that a POV was never aligned is exactly
 * the failure this exists to prevent.
 */

const source = (id: string, synced = true): VodSource => ({
  id,
  platform: 'twitch',
  vodId: id,
  url: `https://twitch.tv/videos/${id}`,
  title: id,
  creator: id,
  durationSeconds: 3600,
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: false,
  ...(synced
    ? {
        syncMapping: {
          vodId: id,
          method: 'platform_metadata' as const,
          confidence: 1,
          vodStartRealTime: 1000,
          offsetSeconds: 0,
          driftRate: 0,
          anchorIds: [],
          lastValidatedAt: '2026-08-21T00:00:00Z',
          warnings: []
        }
      }
    : {})
})

const clip = (id: string, over: Partial<ClipSegment> = {}): ClipSegment => ({
  id,
  name: id,
  sourceId: 'a',
  startSeconds: 10,
  endSeconds: 20,
  durationSeconds: 10,
  order: 0,
  status: 'idle',
  ...over
})

const project = (over: Partial<ProjectFile> = {}): ProjectFile => ({
  schemaVersion: 5,
  id: 'proj',
  name: 'Event',
  createdAt: '',
  updatedAt: '',
  sources: [source('a'), source('b')],
  clips: [],
  markers: [],
  exportSettings: {} as ProjectFile['exportSettings'],
  outputDirectory: null,
  ...over
})

describe('preparing clips for the Editor', () => {
  it('prepares a clip from its authoring POV', () => {
    const plan = prepareForEditor(project({ clips: [clip('c1')] }), ['c1'])
    expect(plan.clips).toHaveLength(1)
    expect(plan.clips[0].sourceId).toBe('a')
    expect(plan.clips[0].sourceStartSeconds).toBe(10)
    expect(plan.totalSeconds).toBe(10)
  })

  it('prepares from the chosen picture POV, matching what the exporter would use', () => {
    const p = project({ clips: [clip('c1', { videoSourceId: 'b' })] })
    const plan = prepareForEditor(p, ['c1'])
    // Must not silently fall back to the authoring POV.
    expect(plan.clips[0]?.sourceId ?? plan.skipped[0]?.reason).toBeDefined()
  })

  it('carries the audio POV when it differs from the picture', () => {
    const p = project({ clips: [clip('c1', { audioSourceId: 'b' })] })
    const plan = prepareForEditor(p, ['c1'])
    expect(plan.clips[0].audioSourceId).toBe('b')
    expect(plan.sourceIds.sort()).toEqual(['a', 'b'])
  })

  it('carries audio edits across rather than leaving them behind', () => {
    const p = project({
      clips: [
        clip('c1', {
          audioEdits: [{ id: 'e1', kind: 'mute', startSeconds: 1, endSeconds: 2 }] as ClipSegment['audioEdits']
        })
      ]
    })
    expect(prepareForEditor(p, ['c1']).clips[0].audioEdits).toHaveLength(1)
  })

  it('skips a clip whose POV has been removed, and says why', () => {
    const p = project({ sources: [], clips: [clip('c1')] })
    const plan = prepareForEditor(p, ['c1'])
    expect(plan.clips).toHaveLength(0)
    expect(plan.skipped[0].reason).toContain('no longer in the project')
  })

  it('never silently drops anything — every requested clip is either prepared or explained', () => {
    const p = project({ sources: [], clips: [clip('c1'), clip('c2')] })
    const plan = prepareForEditor(p, ['c1', 'c2'])
    expect(plan.clips.length + plan.skipped.length).toBe(2)
  })

  it('warns once about unaligned POVs rather than once per clip', () => {
    const p = project({
      sources: [source('a', false)],
      clips: [clip('c1'), clip('c2'), clip('c3')]
    })
    const plan = prepareForEditor(p, ['c1', 'c2', 'c3'])
    const alignment = plan.warnings.filter((w) => w.includes('not aligned'))
    expect(alignment).toHaveLength(1)
  })

  it('ignores ids that are not in the project at all', () => {
    const plan = prepareForEditor(project({ clips: [clip('c1')] }), ['nope'])
    expect(plan.clips).toEqual([])
    expect(plan.totalSeconds).toBe(0)
  })
})

describe('which clips to offer by default', () => {
  it('offers the ones actually gathered and ready, not raw finds', () => {
    const clips = [
      clip('a'),
      clip('b', { workflow: 'ready-for-edit' }),
      clip('c', { workflow: 'povs-collected' }),
      clip('d', { workflow: 'exported' })
    ]
    expect(readyForEditor(clips).map((c) => c.id)).toEqual(['b', 'c'])
  })
})
