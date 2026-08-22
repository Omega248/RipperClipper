import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFANITY,
  effectiveWordList,
  findProfanity,
  mergeHits,
  wordMatches
} from '../../src/shared/profanity.js'
import type { TranscriptLine } from '../../src/shared/transcription.js'

/**
 * Finding words to censor.
 *
 * The asymmetry that drives every case here: a missed word is a re-upload, but
 * a word silenced that was never said is a hole punched in someone's dialogue.
 * So the false-positive cases matter more than the recall ones.
 */

const line = (startSeconds: number, endSeconds: number, text: string): TranscriptLine => ({
  startSeconds,
  endSeconds,
  text
})

describe('matching a word against a list entry', () => {
  it('matches the word itself', () => {
    expect(wordMatches('fuck', 'fuck')).toBe(true)
  })

  it('matches ordinary inflections from one entry', () => {
    for (const form of ['fucks', 'fucking', 'fucked', 'fucker', 'fuckers', 'fuckin']) {
      expect(wordMatches(form, 'fuck')).toBe(true)
    }
  })

  it('is case insensitive', () => {
    expect(wordMatches('SHIT', 'shit')).toBe(true)
  })

  it('sees through common obfuscation', () => {
    expect(wordMatches('f*ck', 'fuck')).toBe(true)
    expect(wordMatches('sh1t', 'shit')).toBe(true)
    expect(wordMatches('a$$hole', 'asshole')).toBe(true)
  })

  it('never matches an entry buried inside an innocent word', () => {
    // The whole reason substring matching is not used.
    expect(wordMatches('assassin', 'ass')).toBe(false)
    expect(wordMatches('classic', 'ass')).toBe(false)
    expect(wordMatches('Scunthorpe', 'cunt')).toBe(false)
    expect(wordMatches('shitake', 'shit')).toBe(false)
    expect(wordMatches('dictionary', 'dick')).toBe(false)
    expect(wordMatches('cocktail', 'cock')).toBe(false)
  })

  it('still catches a compound that genuinely ends in the entry', () => {
    expect(wordMatches('clusterfuck', 'fuck')).toBe(true)
  })

  it('ignores empty entries rather than matching everything', () => {
    expect(wordMatches('hello', '')).toBe(false)
    expect(wordMatches('', 'fuck')).toBe(false)
  })
})

describe('finding hits in a transcript', () => {
  it('finds a word and reports the line it was in', () => {
    const hits = findProfanity([line(0, 2, 'what the fuck was that')], 'pov_a')
    expect(hits).toHaveLength(1)
    expect(hits[0].word.toLowerCase()).toBe('fuck')
    expect(hits[0].context).toBe('what the fuck was that')
    expect(hits[0].sourceId).toBe('pov_a')
  })

  it('places the word inside the line rather than covering the whole line', () => {
    const hits = findProfanity([line(10, 12, 'okay so anyway shit happens')], 'pov_a')
    expect(hits[0].startSeconds).toBeGreaterThan(10)
    expect(hits[0].endSeconds).toBeLessThan(12)
  })

  it('never runs the range outside the line it came from', () => {
    const hits = findProfanity([line(5, 6, 'fuck')], 'pov_a')
    expect(hits[0].startSeconds).toBeGreaterThanOrEqual(5)
    expect(hits[0].endSeconds).toBeLessThanOrEqual(6)
  })

  it('calls timing tight on a short line and estimated on a long one', () => {
    expect(findProfanity([line(0, 2, 'oh shit')], 'a')[0].timingConfidence).toBe('tight')
    const long = findProfanity(
      [line(0, 20, 'so I was driving down the road and then shit happened and we all ran away')],
      'a'
    )
    expect(long[0].timingConfidence).toBe('estimated')
  })

  it('returns nothing for clean speech', () => {
    expect(findProfanity([line(0, 3, 'good evening officer how are you')], 'a')).toEqual([])
  })

  it('finds several words in one line, in order', () => {
    const hits = findProfanity([line(0, 4, 'shit that is a bitch of a problem')], 'a')
    expect(hits).toHaveLength(2)
    expect(hits[0].startSeconds).toBeLessThan(hits[1].startSeconds)
  })

  it('honours a custom list instead of the default', () => {
    const hits = findProfanity([line(0, 2, 'that is a banana')], 'a', ['banana'])
    expect(hits).toHaveLength(1)
    // …and stops matching the default list once one is given.
    expect(findProfanity([line(0, 2, 'oh fuck')], 'a', ['banana'])).toEqual([])
  })

  it('does nothing at all with an empty list', () => {
    expect(findProfanity([line(0, 2, 'oh fuck')], 'a', [])).toEqual([])
  })
})

describe('merging adjacent hits', () => {
  it('joins two words said back to back into one range', () => {
    // Separate edits would leave an audible sliver between them.
    const hits = findProfanity([line(0, 2, 'fucking bitch')], 'a')
    expect(hits).toHaveLength(2)
    const merged = mergeHits(hits)
    expect(merged).toHaveLength(1)
    expect(merged[0].startSeconds).toBeCloseTo(hits[0].startSeconds, 5)
    expect(merged[0].endSeconds).toBeCloseTo(hits[1].endSeconds, 5)
  })

  it('leaves words far apart alone', () => {
    const hits = findProfanity([line(0, 2, 'shit'), line(30, 32, 'shit')], 'a')
    expect(mergeHits(hits)).toHaveLength(2)
  })

  it('never merges across POVs — each POV is censored on its own', () => {
    const a = findProfanity([line(0, 2, 'shit')], 'pov_a')
    const b = findProfanity([line(0, 2, 'shit')], 'pov_b')
    expect(mergeHits([...a, ...b])).toHaveLength(2)
  })

  it('downgrades confidence when merging an estimated range in', () => {
    const merged = mergeHits([
      { sourceId: 'a', word: 'x', matched: 'x', startSeconds: 0, endSeconds: 1, context: '', timingConfidence: 'tight' },
      { sourceId: 'a', word: 'y', matched: 'y', startSeconds: 1.1, endSeconds: 2, context: '', timingConfidence: 'estimated' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].timingConfidence).toBe('estimated')
  })
})

describe('the effective word list', () => {
  it('falls back to the default when none is set', () => {
    expect(effectiveWordList(undefined)).toBe(DEFAULT_PROFANITY)
  })

  it('falls back when a custom list is empty or blank', () => {
    expect(effectiveWordList([])).toBe(DEFAULT_PROFANITY)
    expect(effectiveWordList(['   ', ''])).toBe(DEFAULT_PROFANITY)
  })

  it('uses a real custom list and trims it', () => {
    expect(effectiveWordList([' banana ', ''])).toEqual(['banana'])
  })
})
