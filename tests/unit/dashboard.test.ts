import { describe, expect, it } from 'vitest'
import { attentionLine, summariseProject } from '../../src/shared/dashboard.js'
import type { ClipPovMapping, ClipSegment, ProjectFile } from '../../src/shared/types.js'

/**
 * What a project needs from you right now.
 *
 * The summary exists to answer "which project do I open next", so the
 * attention line must always surface the *most* pressing thing, and must not
 * claim everything is fine while work remains.
 */

const mapping = (sourceId: string): ClipPovMapping => ({
  sourceId,
  vodStartSeconds: 0,
  vodEndSeconds: 10,
  requestedStartSeconds: 0,
  requestedEndSeconds: 10,
  status: 'available',
  confidence: 1,
  method: 'platform_metadata',
  authored: false,
  updatedAt: '2026-08-21T00:00:00Z',
  media: {
    video: { available: true, startSeconds: 0, endSeconds: 10 },
    audio: { available: true, startSeconds: 0, endSeconds: 10 }
  }
})

const clip = (id: string, over: Partial<ClipSegment> = {}): ClipSegment => ({
  id,
  name: id,
  sourceId: 'pov_a',
  startSeconds: 0,
  endSeconds: 10,
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
  sources: [],
  clips: [],
  markers: [],
  exportSettings: {} as ProjectFile['exportSettings'],
  outputDirectory: null,
  ...over
})

describe('summarising a project', () => {
  it('counts clips by what stage they are at', () => {
    const s = summariseProject(
      project({
        clips: [
          clip('a'),
          clip('b', { workflow: 'ready-for-edit' }),
          clip('c', { workflow: 'exported' })
        ]
      })
    )
    expect(s.needReview).toBe(1)
    expect(s.readyForExport).toBe(1)
    expect(s.exported).toBe(1)
  })

  it('treats a clip with no stored stage as needing review', () => {
    expect(summariseProject(project({ clips: [clip('a')] })).needReview).toBe(1)
  })

  it('counts clips carrying footage nobody looked at', () => {
    const withUnused = clip('a', {
      sourceId: 'pov_a',
      povMappings: [mapping('pov_a'), mapping('pov_b')]
    })
    expect(summariseProject(project({ clips: [withUnused] })).clipsWithUnusedPovs).toBe(1)
  })
})

describe('the attention line', () => {
  it('says so when a project is empty', () => {
    expect(attentionLine(summariseProject(project()))).toContain('Empty')
  })

  it('leads with unaligned POVs above everything else', () => {
    const s = summariseProject(
      project({
        sources: [{ id: 'pov_a' } as ProjectFile['sources'][number]],
        clips: [clip('a')]
      })
    )
    // Both are outstanding; alignment blocks the most, so it wins.
    expect(s.needReview).toBe(1)
    expect(attentionLine(s)).toContain('not aligned')
  })

  it('falls through to review once alignment is done', () => {
    expect(attentionLine({ ...summariseProject(project({ clips: [clip('a')] })), unalignedPovs: 0 })).toContain(
      'need review'
    )
  })

  it('never claims everything is fine while work remains', () => {
    const s = { ...summariseProject(project({ clips: [clip('a')] })), unalignedPovs: 0 }
    expect(attentionLine(s)).not.toBe('Nothing outstanding.')
  })

  it('reports a finished project as finished', () => {
    const s = summariseProject(project({ clips: [clip('a', { workflow: 'exported' })] }))
    expect(attentionLine(s)).toContain('exported')
  })

  it('uses singular wording for one item', () => {
    const s = { ...summariseProject(project({ clips: [clip('a')] })), unalignedPovs: 0 }
    expect(attentionLine(s)).toContain('1 clip still need review')
  })
})
