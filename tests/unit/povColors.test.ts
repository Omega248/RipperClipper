import { describe, expect, it } from 'vitest'
import { POV_COLORS, povColor, povColorMap, povTint } from '../../src/shared/povColors.js'

/**
 * A POV's colour.
 *
 * The property that matters most: it must not move. A POV that changed colour
 * when another was added would make the timeline, the pips and the avatars
 * all disagree with what the editor saw a moment ago.
 */

describe('per-POV colour', () => {
  it('is stable for the same id', () => {
    expect(povColor('src_abc')).toBe(povColor('src_abc'))
  })

  it('always comes from the palette', () => {
    for (const id of ['a', 'src_1', 'src_999', 'titem_x', '']) {
      expect(POV_COLORS).toContain(povColor(id))
    }
  })

  it('separates ids that differ only in their last character', () => {
    // src_1 and src_2 landing on neighbouring colours would make a POV list
    // look like a gradient rather than distinct angles.
    const a = povColor('src_1')
    const b = povColor('src_2')
    const c = povColor('src_3')
    expect(new Set([a, b, c]).size).toBeGreaterThan(1)
  })
})

describe('tints', () => {
  it('mixes against the ground rather than baking in an alpha', () => {
    // A fixed rgba over a light ground reads nothing like it does over a dark
    // one; color-mix keeps a tint correct when the theme flips.
    expect(povTint('src_a', 28)).toContain('color-mix')
    expect(povTint('src_a', 28)).toContain(povColor('src_a'))
  })
})

describe('colouring a whole set', () => {
  it('gives every POV a colour', () => {
    const ids = ['a', 'b', 'c', 'd']
    const map = povColorMap(ids)
    expect([...map.keys()].sort()).toEqual(ids)
  })

  it('avoids collisions while colours remain', () => {
    const ids = Array.from({ length: POV_COLORS.length }, (_, i) => `src_${i}`)
    const map = povColorMap(ids)
    expect(new Set(map.values()).size).toBe(POV_COLORS.length)
  })

  it('keeps a colour once claimed, so adding a POV never recolours the others', () => {
    const first = povColorMap(['a', 'b', 'c'])
    const after = povColorMap(['a', 'b', 'c', 'd'])
    for (const id of ['a', 'b', 'c']) {
      expect(after.get(id)).toBe(first.get(id))
    }
  })

  it('still colours everything past the end of the palette', () => {
    const ids = Array.from({ length: POV_COLORS.length + 4 }, (_, i) => `p${i}`)
    const map = povColorMap(ids)
    expect(map.size).toBe(ids.length)
    expect([...map.values()].every((c) => POV_COLORS.includes(c as never))).toBe(true)
  })
})
