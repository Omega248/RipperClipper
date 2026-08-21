import { describe, expect, it } from 'vitest'
import { tagTone } from '../../src/shared/clipTags.js'

describe('tagTone', () => {
  it('is deterministic — the same tag always gets the same colour', () => {
    expect(tagTone('Highlight')).toBe(tagTone('Highlight'))
    expect(tagTone('Needs review')).toBe(tagTone('Needs review'))
  })

  it('gives different-looking tags different colours, usually', () => {
    const tones = new Set(['Highlight', 'Needs review', 'Funny', 'B-roll', 'Draft'].map(tagTone))
    expect(tones.size).toBeGreaterThan(1)
  })

  it('never throws on empty or unusual input', () => {
    expect(() => tagTone('')).not.toThrow()
    expect(() => tagTone('🔥🔥🔥')).not.toThrow()
    expect(() => tagTone('a'.repeat(500))).not.toThrow()
  })
})
