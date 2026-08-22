import { describe, expect, it } from 'vitest'
import { clipsInCollection, collectionCounts, matchScore, searchEvent } from '../../src/shared/search.js'
import type { ClipSegment, ProjectFile } from '../../src/shared/types.js'

/**
 * One search box over the whole event.
 *
 * Forgiving, but never confidently wrong: a query that genuinely matches
 * nothing must return nothing rather than the nearest thing by edit distance.
 */

const clip = (id: string, name: string, over: Partial<ClipSegment> = {}): ClipSegment => ({
  id,
  name,
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

describe('match scoring', () => {
  it('ranks exact above prefix above substring', () => {
    expect(matchScore('police', 'police')).toBeGreaterThan(matchScore('police chase', 'police'))
    expect(matchScore('police chase', 'police')).toBeGreaterThan(matchScore('the police chase', 'police'))
  })

  it('matches words in any order', () => {
    expect(matchScore('Police Chase', 'chase police')).toBeGreaterThan(0)
  })

  it('matches a short query against the start of a word', () => {
    expect(matchScore('Police Chase', 'pol')).toBeGreaterThan(0)
  })

  it('ignores punctuation and case', () => {
    expect(matchScore("Bank — Robbery!", 'bank robbery')).toBeGreaterThan(0)
  })

  it('returns zero for something genuinely absent, rather than a near miss', () => {
    expect(matchScore('Police Chase', 'submarine')).toBe(0)
  })

  it('returns zero for an empty query', () => {
    expect(matchScore('anything', '   ')).toBe(0)
  })
})

describe('searching the event', () => {
  const p = project({
    clips: [clip('c1', 'Bank Entry'), clip('c2', 'Police Chase'), clip('c3', 'Hospital')],
    event: {
      name: 'Heist',
      startSeconds: 100,
      endSeconds: 200,
      collections: [{ id: 'col1', name: 'Bank Robbery', order: 0 }],
      moments: [{ id: 'm1', timeSeconds: 150, name: 'Police arrive' }]
    }
  })

  it('finds clips, collections and moments from one query', () => {
    const kinds = new Set(searchEvent({ project: p }, 'police').map((r) => r.kind))
    expect(kinds.has('clip')).toBe(true)
    expect(kinds.has('moment')).toBe(true)
  })

  it('finds a collection by name', () => {
    const hit = searchEvent({ project: p }, 'bank robbery').find((r) => r.kind === 'collection')
    expect(hit?.title).toBe('Bank Robbery')
  })

  it('returns nothing at all for an empty query', () => {
    expect(searchEvent({ project: p }, '')).toEqual([])
  })

  it('carries the real-world time so a result can be jumped to', () => {
    const moment = searchEvent({ project: p }, 'police arrive').find((r) => r.kind === 'moment')
    expect(moment?.eventTimeSeconds).toBe(150)
  })
})

describe('collections view', () => {
  const clips = [
    clip('c1', 'A', { collectionId: 'col1', order: 1 }),
    clip('c2', 'B', { collectionId: 'col1', order: 0 }),
    clip('c3', 'C', { collectionId: null })
  ]

  it('lists a collection’s clips in their own order', () => {
    expect(clipsInCollection(clips, 'col1').map((c) => c.name)).toEqual(['B', 'A'])
  })

  it('treats an absent collection id as unfiled', () => {
    expect(clipsInCollection(clips, null).map((c) => c.name)).toEqual(['C'])
  })

  it('counts unfiled first, then each collection in order', () => {
    const counts = collectionCounts(
      {
        name: null,
        startSeconds: null,
        endSeconds: null,
        collections: [
          { id: 'col2', name: 'Second', order: 1 },
          { id: 'col1', name: 'First', order: 0 }
        ],
        moments: []
      },
      clips
    )
    expect(counts.map((c) => c.name)).toEqual(['Unfiled', 'First', 'Second'])
    expect(counts.map((c) => c.count)).toEqual([1, 2, 0])
  })
})
