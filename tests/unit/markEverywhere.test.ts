import { describe, expect, it } from 'vitest'
import { markEverywhere } from '../../src/shared/markEverywhere.js'
import type { VodSource } from '../../src/shared/types.js'

const EPOCH = 1_700_000_000

const source = (id: string, startsAt: number | null, duration = 4 * 3600): VodSource =>
  ({
    id,
    platform: 'twitch',
    vodId: `v_${id}`,
    url: `https://example.test/${id}`,
    title: id,
    creator: id,
    durationSeconds: duration,
    playbackKind: 'hls',
    capabilities: { download: true, seek: true, metadata: true },
    ...(startsAt === null
      ? {}
      : {
          syncMapping: {
            vodId: id,
            vodStartRealTime: startsAt,
            offsetSeconds: 0,
            driftRate: 0,
            method: 'metadata',
            confidence: 0.9
          }
        })
  }) as unknown as VodSource

describe('marking one moment in every angle', () => {
  // A starts on the hour; B started 10 minutes later; C never synced.
  const a = source('a', EPOCH)
  const b = source('b', EPOCH + 600)
  const c = source('c', null)

  it('projects the instant into every synced angle', () => {
    const result = markEverywhere({
      sources: [a, b],
      fromSourceId: 'a',
      atSeconds: 900,
      label: 'Bank job'
    })

    expect(result.markers).toHaveLength(2)
    expect(result.eventSeconds).toBe(EPOCH + 900)
    // 900s into A is 300s into B, because B started ten minutes later.
    const onB = result.markers.find((m) => m.sourceId === 'b')
    expect(onB?.timeSeconds).toBe(300)
    expect(onB?.label).toBe('Bank job')
  })

  it('skips an angle with no clock rather than guessing one', () => {
    const result = markEverywhere({ sources: [a, c], fromSourceId: 'a', atSeconds: 900, label: 'x' })
    expect(result.markers.map((m) => m.sourceId)).toEqual(['a'])
    expect(result.skipped).toEqual([{ sourceId: 'c', reason: 'unsynced' }])
  })

  it('skips an angle that was not recording then, rather than clamping it', () => {
    // B started 10 minutes after A, so second 60 of A is before B exists. A
    // marker at B's frame zero would look like a real answer and be wrong.
    const result = markEverywhere({ sources: [a, b], fromSourceId: 'a', atSeconds: 60, label: 'x' })
    expect(result.markers.map((m) => m.sourceId)).toEqual(['a'])
    expect(result.skipped).toEqual([{ sourceId: 'b', reason: 'not-recording' }])
  })

  it('skips an angle whose recording had already ended', () => {
    const short = source('short', EPOCH, 600)
    const result = markEverywhere({
      sources: [a, short],
      fromSourceId: 'a',
      atSeconds: 900,
      label: 'x'
    })
    expect(result.skipped).toEqual([{ sourceId: 'short', reason: 'not-recording' }])
  })

  it('degrades to one marker when the angle you are in has no clock', () => {
    const result = markEverywhere({ sources: [c, a], fromSourceId: 'c', atSeconds: 900, label: 'x' })
    expect(result.markers).toHaveLength(1)
    expect(result.markers[0].sourceId).toBe('c')
    expect(result.eventSeconds).toBeNull()
  })

  it('carries the label and category to every copy', () => {
    const result = markEverywhere({
      sources: [a, b],
      fromSourceId: 'a',
      atSeconds: 900,
      label: 'Funny death',
      category: 'funny'
    })
    expect(result.markers.every((m) => m.label === 'Funny death')).toBe(true)
    expect(result.markers.every((m) => m.category === 'funny')).toBe(true)
  })

  it('gives every copy its own id', () => {
    const result = markEverywhere({ sources: [a, b], fromSourceId: 'a', atSeconds: 900, label: 'x' })
    expect(new Set(result.markers.map((m) => m.id)).size).toBe(result.markers.length)
  })

  it('is safe when the angle is not in the project', () => {
    expect(markEverywhere({ sources: [a], fromSourceId: 'gone', atSeconds: 1, label: 'x' }).markers).toEqual([])
  })
})
