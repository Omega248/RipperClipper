import { describe, expect, it } from 'vitest'
import { buildClipMappings, refreshClipMapping, refreshClipMappings } from '../../src/shared/povMapping.js'
import type { ClipSegment, VodSource } from '../../src/shared/types.js'

/**
 * Dragging a clip edge must not do work proportional to the whole project.
 *
 * `patchClip` runs on every pointer event of a drag. It rebuilt the POV
 * mappings for *every* clip each time — fifty clips across nine POVs is four
 * hundred and fifty projections a hundred times a second, which is what "the
 * app lags slightly when expanding and shrinking a clip" was.
 *
 * Moving one clip cannot change another clip's mapping: a mapping is a
 * function of that clip's own times and of the sources, and neither changes
 * for its neighbours. So the single-clip refresh has to produce exactly what
 * the whole-project one does for the clip that moved, and leave the rest
 * untouched — the same objects, so React can skip them too.
 */
function source(id: string, offset: number): VodSource {
  return {
    id,
    platform: 'kick',
    url: `https://kick.com/${id}`,
    title: id,
    creator: id,
    durationSeconds: 7200,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString()
  } as unknown as VodSource
}

function clip(id: string, start: number): ClipSegment {
  return {
    id,
    name: id,
    sourceId: 'a',
    startSeconds: start,
    endSeconds: start + 30,
    order: 0,
    status: 'ready',
    eventStartTime: new Date(Date.UTC(2026, 0, 1, 0, 0, start)).toISOString(),
    eventEndTime: new Date(Date.UTC(2026, 0, 1, 0, 0, start + 30)).toISOString()
  } as unknown as ClipSegment
}

describe('refreshing one clip after a drag', () => {
  const sources = [source('a', 0), source('b', 12), source('c', -30)]
  const clips = [clip('c1', 100), clip('c2', 400), clip('c3', 900)]
  const now = '2026-01-01T00:00:00.000Z'

  it('gives the moved clip exactly what a full refresh would', () => {
    const one = refreshClipMapping(clips, 'c2', sources, now)
    const all = refreshClipMappings(clips, sources, now)
    expect(one[1].povMappings).toEqual(all[1].povMappings)
    expect(one[1].povMappings).toEqual(buildClipMappings(clips[1], sources, now))
  })

  it('leaves every other clip as the same object', () => {
    const one = refreshClipMapping(clips, 'c2', sources, now)
    expect(one[0]).toBe(clips[0])
    expect(one[2]).toBe(clips[2])
    expect(one[1]).not.toBe(clips[1])
  })

  it('does no work at all when the id is not there', () => {
    const one = refreshClipMapping(clips, 'gone', sources, now)
    expect(one.every((c, i) => c === clips[i])).toBe(true)
  })
})
