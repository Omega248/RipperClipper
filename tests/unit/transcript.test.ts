import { describe, expect, it } from 'vitest'
import {
  parseTimestamp,
  parseVtt,
  searchTranscripts,
  transcriptsAtEventTime
} from '../../src/shared/transcript.js'
import type { Transcript } from '../../src/shared/transcript.js'
import type { VodTimeMapping } from '../../src/shared/sync.js'

/**
 * Searching what was said.
 *
 * The point of all of it is the projection onto the wall clock: a line spoken
 * at 01:12:30 in one VOD and a line spoken at 00:41:02 in another can be the
 * same instant of the same event, and only the sync mapping knows it.
 */

const T0 = Date.parse('2026-08-21T18:00:00Z') / 1000

const mapping = (startsAt: number): VodTimeMapping => ({
  vodId: 'v',
  method: 'platform_metadata',
  confidence: 1,
  vodStartRealTime: startsAt,
  offsetSeconds: 0,
  driftRate: 0,
  anchorIds: [],
  lastValidatedAt: '2026-08-21T00:00:00Z',
  warnings: []
})

const transcript = (sourceId: string, lines: Array<[number, string]>): Transcript => ({
  sourceId,
  language: 'en',
  origin: 'auto-captions',
  fetchedAt: '2026-08-21T00:00:00Z',
  lines: lines.map(([startSeconds, text]) => ({ startSeconds, endSeconds: startSeconds + 2, text }))
})

describe('parsing WebVTT', () => {
  it('reads plain cues', () => {
    const lines = parseVtt(
      ['WEBVTT', '', '00:00:01.000 --> 00:00:03.000', 'hello there', '', '00:00:04.000 --> 00:00:06.000', 'general kenobi'].join(
        '\n'
      )
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({ startSeconds: 1, endSeconds: 3, text: 'hello there' })
    expect(lines[1].text).toBe('general kenobi')
  })

  it('strips the inline word timings and cue tags YouTube emits', () => {
    const lines = parseVtt(
      ['WEBVTT', '', '00:00:01.000 --> 00:00:03.000', '<00:00:01.100><c>you are</c> <00:00:02.000><c>under arrest</c>'].join('\n')
    )
    expect(lines[0].text).toBe('you are under arrest')
  })

  it('collapses rolling captions into one line, keeping the complete version', () => {
    // YouTube emits the same phrase repeatedly as it grows; without this one
    // spoken sentence would look like three separate moments.
    const lines = parseVtt(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.000',
        'you are',
        '',
        '00:00:02.000 --> 00:00:03.000',
        'you are under',
        '',
        '00:00:03.000 --> 00:00:04.000',
        'you are under arrest'
      ].join('\n')
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('you are under arrest')
    expect(lines[0].endSeconds).toBe(4)
  })

  it('accepts mm:ss cues as well as hh:mm:ss', () => {
    expect(parseTimestamp('02:03.500')).toBeCloseTo(123.5, 3)
    expect(parseTimestamp('01:02:03.000')).toBe(3723)
    expect(parseTimestamp('nonsense')).toBeNull()
  })

  it('ignores headers and empty blocks rather than emitting blank lines', () => {
    const lines = parseVtt(['WEBVTT', 'Kind: captions', 'Language: en', '', '', 'NOTE something', ''].join('\n'))
    expect(lines).toEqual([])
  })
})

describe('searching across POVs', () => {
  // Two POVs of the same event, started 10 minutes apart.
  const a = transcript('pov_a', [[60, "you're under arrest"], [120, 'get in the car']])
  const b = transcript('pov_b', [[0, 'what was that noise'], [660, "he said you're under arrest"]])
  const mappings: Record<string, VodTimeMapping> = {
    pov_a: mapping(T0),
    pov_b: mapping(T0 - 600)
  }
  const mappingFor = (id: string): VodTimeMapping | undefined => mappings[id]

  it('finds a phrase in every POV that said it', () => {
    const hits = searchTranscripts([a, b], 'under arrest', mappingFor)
    expect(hits.map((h) => h.sourceId).sort()).toEqual(['pov_a', 'pov_b'])
  })

  it('maps each hit onto the real-world clock, not the VOD clock', () => {
    const hits = searchTranscripts([a, b], 'under arrest', mappingFor)
    // pov_a local 60 → T0+60. pov_b local 660, started 600s earlier → T0+60.
    // Different VOD timestamps, same real instant — the whole point.
        for (const hit of hits) expect(hit.eventTimeSeconds).toBe(T0 + 60)
  })

  it('orders results by when they actually happened', () => {
    const hits = searchTranscripts([a, b], 'the', mappingFor)
    const times = hits.map((h) => h.eventTimeSeconds!)
    expect([...times].sort((x, y) => x - y)).toEqual(times)
  })

  it('keeps hits from an unsynced POV, but after the placeable ones', () => {
    const orphan = transcript('pov_c', [[5, 'get in the car']])
    const hits = searchTranscripts([a, orphan], 'car', (id) => mappings[id])
    expect(hits).toHaveLength(2)
    expect(hits[hits.length - 1].sourceId).toBe('pov_c')
    expect(hits[hits.length - 1].eventTimeSeconds).toBeNull()
  })

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchTranscripts([a, b], '   ', mappingFor)).toEqual([])
  })
})

describe('what everyone was saying at one instant', () => {
  const a = transcript('pov_a', [[60, "you're under arrest"]])
  const b = transcript('pov_b', [[660, 'he ran that way']])
  const mappings: Record<string, VodTimeMapping> = { pov_a: mapping(T0), pov_b: mapping(T0 - 600) }

  it('gathers lines from every POV around the same real-world moment', () => {
    const hits = transcriptsAtEventTime([a, b], T0 + 60, (id) => mappings[id])
    expect(hits.map((h) => h.sourceId).sort()).toEqual(['pov_a', 'pov_b'])
  })

  it('excludes lines outside the window', () => {
    const hits = transcriptsAtEventTime([a, b], T0 + 600, (id) => mappings[id])
    expect(hits).toEqual([])
  })

  it('skips POVs that are not on the event clock, rather than guessing', () => {
    const hits = transcriptsAtEventTime([a, b], T0 + 60, (id) => (id === 'pov_a' ? mappings.pov_a : undefined))
    expect(hits.map((h) => h.sourceId)).toEqual(['pov_a'])
  })
})
