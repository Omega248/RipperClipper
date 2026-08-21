import { describe, expect, it } from 'vitest'
import {
  candidateKey,
  filterDiscoveries,
  matchConfidence,
  rankDiscoveries,
  sortDiscoveries
} from '../../src/shared/discovery.js'
import type { DiscoveryCandidate } from '../../src/shared/discovery.js'

/**
 * Finding every POV of an event across platforms.
 *
 * The overlap arithmetic itself is eventStreams.test.ts's job — these tests
 * are about everything discovery adds on top: is this candidate plausibly
 * *this* event, is it the same broadcast we already found, and does the list
 * come back in an order the editor can work down.
 */

// 18:30 → 19:00 on the wall clock, the spec's own worked example.
const EVENT_START = Date.parse('2026-08-21T18:30:00Z') / 1000
const EVENT_END = Date.parse('2026-08-21T19:00:00Z') / 1000

const candidate = (over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate => ({
  url: 'https://twitch.tv/videos/1',
  title: 'just chatting',
  publishedAt: '2026-08-21T18:00:00Z',
  durationSeconds: 4 * 3600,
  platform: 'twitch',
  channelHandle: 'streamer',
  source: 'search',
  ...over
})

describe('match confidence', () => {
  const fullCoverage = { fraction: 1, certain: true }

  it('rates a NoPixel-titled stream above an unrelated one live at the same time', () => {
    const relevant = matchConfidence(
      { title: 'NoPixel 4.0 — bank job', source: 'search' },
      {},
      fullCoverage
    )
    const unrelated = matchConfidence({ title: 'sleeping stream', source: 'search' }, {}, fullCoverage)
    expect(relevant.confidence).toBeGreaterThan(unrelated.confidence)
  })

  it('credits a stream whose title says nothing but whose category places it — the "THE BIG HEIST" case', () => {
    // §1.2 explicitly calls this out: a title-only search misses it entirely.
    const heist = matchConfidence(
      { title: 'THE BIG HEIST', category: 'Grand Theft Auto V', source: 'search' },
      {},
      fullCoverage
    )
    const bare = matchConfidence({ title: 'THE BIG HEIST', source: 'search' }, {}, fullCoverage)
    expect(heist.confidence).toBeGreaterThan(bare.confidence)
    expect(heist.reasons.join(' ')).toContain('Grand Theft Auto V')
  })

  it('credits NoPixel in the tags even with an unrelated title and no category', () => {
    const tagged = matchConfidence(
      { title: 'back at it', tags: ['nopixel', 'english'], source: 'search' },
      {},
      fullCoverage
    )
    expect(tagged.confidence).toBeGreaterThan(
      matchConfidence({ title: 'back at it', source: 'search' }, {}, fullCoverage).confidence
    )
  })

  it('starts a library channel ahead of an unknown one, all else equal', () => {
    const known = matchConfidence({ title: 'stream', source: 'library' }, {}, fullCoverage)
    const unknown = matchConfidence({ title: 'stream', source: 'search' }, {}, fullCoverage)
    expect(known.confidence).toBeGreaterThan(unknown.confidence)
  })

  it('matches the event name word by word, not as a substring', () => {
    // "bank robbery" must still reward "ROBBING THE BANK", which a substring
    // test would score at zero.
    const hit = matchConfidence(
      { title: 'ROBBING THE BANK WITH THE BOYS', source: 'search' },
      { name: 'bank robbery' },
      fullCoverage
    )
    expect(hit.reasons.join(' ')).toContain('Matches the event name')
    expect(hit.confidence).toBeGreaterThan(
      matchConfidence({ title: 'fishing all day', source: 'search' }, { name: 'bank robbery' }, fullCoverage)
        .confidence
    )
  })

  it('penalises but never zeroes an overlap of unknown length', () => {
    const uncertain = matchConfidence({ title: 'stream', source: 'search' }, {}, {
      fraction: 1,
      certain: false
    })
    expect(uncertain.confidence).toBeGreaterThan(0)
    expect(uncertain.reasons.join(' ')).toContain('length unknown')
  })
})

describe('de-duplicating the same broadcast', () => {
  it('treats www, trailing slash and a ?t= offset as one VOD', () => {
    const a = candidateKey({ platform: 'twitch', url: 'https://www.twitch.tv/videos/123/' })
    const b = candidateKey({ platform: 'twitch', url: 'https://twitch.tv/videos/123?t=1h2m' })
    expect(a).toBe(b)
  })

  it('keeps the same path on different platforms apart', () => {
    expect(candidateKey({ platform: 'twitch', url: 'https://x.tv/v/1' })).not.toBe(
      candidateKey({ platform: 'kick', url: 'https://x.tv/v/1' })
    )
  })

  it('offers a broadcast found by both the library and a search only once', () => {
    const ranked = rankDiscoveries(
      [
        candidate({ url: 'https://twitch.tv/videos/9', source: 'library', streamerId: 'str_1' }),
        candidate({ url: 'https://www.twitch.tv/videos/9', source: 'search', tags: ['nopixel'] })
      ],
      { startSeconds: EVENT_START, endSeconds: EVENT_END }
    )
    expect(ranked).toHaveLength(1)
  })

  it('prefers the record that knows the broadcast length over one that does not', () => {
    const ranked = rankDiscoveries(
      [
        candidate({ url: 'https://twitch.tv/videos/9', durationSeconds: null, source: 'search' }),
        candidate({ url: 'https://twitch.tv/videos/9', durationSeconds: 4 * 3600, source: 'search' })
      ],
      { startSeconds: EVENT_START, endSeconds: EVENT_END }
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].coverage.certain).toBe(true)
  })

  it('lets an already-loaded POV win, since only it carries the project source id', () => {
    const ranked = rankDiscoveries(
      [
        candidate({ url: 'https://twitch.tv/videos/9', source: 'search', tags: ['nopixel'] }),
        candidate({ url: 'https://twitch.tv/videos/9', source: 'loaded', sourceId: 'src_7' })
      ],
      { startSeconds: EVENT_START, endSeconds: EVENT_END }
    )
    expect(ranked[0].source).toBe('loaded')
    expect(ranked[0].sourceId).toBe('src_7')
  })
})

describe('ranking a discovery run', () => {
  it('drops a broadcast that had already ended before the event began', () => {
    const ranked = rankDiscoveries(
      [
        candidate({
          url: 'https://twitch.tv/videos/early',
          title: 'NoPixel NoPixel NoPixel',
          publishedAt: '2026-08-21T10:00:00Z',
          durationSeconds: 3600
        })
      ],
      { startSeconds: EVENT_START, endSeconds: EVENT_END }
    )
    // Perfect title, wrong time — overlap is not negotiable.
    expect(ranked).toEqual([])
  })

  it('reports the spec’s worked coverage example per streamer', () => {
    // A: 18:00-20:00 = 100%, B: 18:45-20:00 = 50%, C: 17:00-18:40 = 33%.
    const ranked = rankDiscoveries(
      [
        candidate({
          url: 'https://twitch.tv/a',
          channelHandle: 'a',
          publishedAt: '2026-08-21T18:00:00Z',
          durationSeconds: 2 * 3600
        }),
        candidate({
          url: 'https://twitch.tv/b',
          channelHandle: 'b',
          publishedAt: '2026-08-21T18:45:00Z',
          durationSeconds: 75 * 60
        }),
        candidate({
          url: 'https://twitch.tv/c',
          channelHandle: 'c',
          publishedAt: '2026-08-21T17:00:00Z',
          durationSeconds: 100 * 60
        })
      ],
      { startSeconds: EVENT_START, endSeconds: EVENT_END }
    )
    const byHandle = new Map(ranked.map((r) => [r.channelHandle, r]))
    expect(byHandle.get('a')!.coverage.fraction).toBeCloseTo(1, 3)
    expect(byHandle.get('b')!.coverage.fraction).toBeCloseTo(0.5, 3)
    expect(byHandle.get('c')!.coverage.fraction).toBeCloseTo(1 / 3, 2)
  })

  it('restricts to one platform when asked', () => {
    const ranked = rankDiscoveries(
      [
        candidate({ url: 'https://twitch.tv/1', platform: 'twitch' }),
        candidate({ url: 'https://kick.com/1', platform: 'kick' })
      ],
      { startSeconds: EVENT_START, endSeconds: EVENT_END, platform: 'kick' }
    )
    expect(ranked.map((r) => r.platform)).toEqual(['kick'])
  })
})

describe('sorting and filtering results', () => {
  const streams = rankDiscoveries(
    [
      candidate({
        url: 'https://twitch.tv/z',
        channelHandle: 'zoe',
        publishedAt: '2026-08-21T18:45:00Z',
        durationSeconds: 3600
      }),
      candidate({
        url: 'https://kick.com/a',
        platform: 'kick',
        channelHandle: 'abe',
        title: 'NoPixel heist',
        publishedAt: '2026-08-21T18:00:00Z',
        durationSeconds: 4 * 3600
      })
    ],
    { startSeconds: EVENT_START, endSeconds: EVENT_END }
  )

  it('sorts by coverage, best first', () => {
    expect(sortDiscoveries(streams, 'coverage')[0].channelHandle).toBe('abe')
  })

  it('sorts by start time, earliest first', () => {
    expect(sortDiscoveries(streams, 'start')[0].channelHandle).toBe('abe')
  })

  it('sorts by name', () => {
    expect(sortDiscoveries(streams, 'name').map((s) => s.channelHandle)).toEqual(['abe', 'zoe'])
  })

  it('filters by platform, coverage and free text independently', () => {
    expect(filterDiscoveries(streams, { platform: 'kick' })).toHaveLength(1)
    expect(filterDiscoveries(streams, { minCoverage: 0.9 }).map((s) => s.channelHandle)).toEqual(['abe'])
    expect(filterDiscoveries(streams, { search: 'ZOE' }).map((s) => s.channelHandle)).toEqual(['zoe'])
  })

  it('treats an empty filter as no filter at all', () => {
    expect(filterDiscoveries(streams, { platform: 'all', search: '' })).toHaveLength(streams.length)
  })
})
