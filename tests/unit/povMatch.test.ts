import { describe, expect, it } from 'vitest'
import { byMatch, matchVerdict, momentInVod } from '../../src/shared/povMatch.js'
import type { Coverage } from '../../src/shared/povMatch.js'

/**
 * Saying how good a match is, in three words.
 *
 * The matcher already knows how much of the clip a broadcast spans and whether
 * the two clocks are pinned to each other; this only has to turn that into
 * something scannable — and to be conservative at the top, because "was live
 * at roughly the same time" is not a POV of the same moment, and an editor who
 * trusts a confident label ends up adding nine strangers.
 */
const cov = (over: Partial<Coverage>): Coverage => ({
  fraction: 1,
  complete: true,
  offsetSeconds: 0,
  certain: true,
  ...over
})

describe('how well a broadcast covers the clip', () => {
  it('reserves "high" for a synchronised clock, not a coincidence', () => {
    expect(matchVerdict(cov({})).strength).toBe('high')
    expect(matchVerdict(cov({ certain: false })).strength).toBe('good')
  })

  it('says how much of it is covered when it is partial', () => {
    expect(matchVerdict(cov({ complete: false, fraction: 0.62 })).label).toBe('Covers 62%')
    expect(matchVerdict(cov({ complete: false, fraction: 0.62 })).strength).toBe('partial')
  })

  it('calls a sliver what it is', () => {
    expect(matchVerdict(cov({ complete: false, fraction: 0.05 })).strength).toBe('edge')
  })

  it('sorts the best matches to the top', () => {
    const ranked = [
      cov({ complete: false, fraction: 0.1 }),
      cov({}),
      cov({ complete: false, fraction: 0.8 }),
      cov({ certain: false })
    ].sort(byMatch)
    expect(ranked.map((c) => matchVerdict(c).strength)).toEqual(['high', 'good', 'partial', 'edge'])
  })

  it('keeps the moment inside the broadcast, never before it', () => {
    expect(momentInVod(cov({ offsetSeconds: 4210 }))).toBe(4210)
    // A negative offset would seek before the start of the recording.
    expect(momentInVod(cov({ offsetSeconds: -30 }))).toBe(0)
  })
})
