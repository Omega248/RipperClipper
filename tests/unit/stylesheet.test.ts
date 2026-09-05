import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Rules about the stylesheet that a person cannot be trusted to keep.
 *
 * Both of these are here because they already went wrong once, and neither
 * failure looked like a stylesheet problem from the outside.
 */

const css = readFileSync(
  fileURLToPath(new URL('../../src/renderer/src/app.css', import.meta.url)),
  'utf8'
)
/** Comments hold braces and prose that would otherwise read as selectors. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('app.css', () => {
  it('balances its braces', () => {
    // Deleting a rule from the middle of a selector list once left the list
    // dangling, and the next rule's declarations were inherited by the
    // orphaned selector — every settings table turned into a grid.
    expect((bare.match(/\{/g) ?? []).length).toBe((bare.match(/\}/g) ?? []).length)
  })

  it('has no selector without a body', () => {
    for (const chunk of bare.split('}')) {
      if (chunk.trim() && !chunk.includes('{')) {
        throw new Error(`selector with no body: ${chunk.trim().slice(0, 120)}`)
      }
    }
  })

  it('has no empty rule', () => {
    expect(/\{\s*\}/.test(bare)).toBe(false)
  })

  it('lets a rail row fill its tooltip anchor', () => {
    /*
     * Collapsed, every rail row is wrapped in a tooltip — that is where its
     * name comes from with the labels gone. `.ui-tooltip-anchor` is
     * `inline-flex`, so it shrank to the icon and the row's `width: 100%`
     * resolved against 16px: the whole icon column sat against the left edge
     * instead of down the middle of the rail. Twice now this has been "fixed"
     * by centring things that were already centred, because a test harness
     * without the wrapper cannot reproduce it.
     */
    expect(bare).toMatch(/\.app-rail-items \.ui-tooltip-anchor\s*\{[^}]*width:\s*100%/)
  })

  it('gives a device-pixel-scaled canvas an explicit CSS width and height', () => {
    /*
     * A canvas drawn for high-DPI screens sets its `width`/`height`
     * *attributes* in device pixels — CSS pixels × devicePixelRatio. With no
     * CSS size the element then lays out at those numbers, so at 250% display
     * scaling it renders 2.5× too big. The timeline shipped like that: it drew
     * across 40% of the strip, and clicking to seek landed 2.5× along the wrong
     * part of the broadcast. On the 100%-scaling machine it was written on,
     * nothing looked wrong.
     *
     * The list is the components allowed to scale a canvas that way, each
     * paired with the rule that has to pin it back. A new one fails this test
     * until it is added — which is the point: the trap is invisible until
     * someone runs the app on a scaled display.
     */
    const scaled = [
      { component: 'src/renderer/src/components/Timeline.tsx', rule: '.timeline-canvas-wrap canvas' }
    ]

    const src = fileURLToPath(new URL('../../', import.meta.url))
    const users = scaled
      .filter((entry) => readFileSync(src + entry.component, 'utf8').includes('devicePixelRatio'))
      .map((entry) => entry.rule)
    expect(users).toEqual(scaled.map((e) => e.rule))

    for (const rule of users) {
      const body = new RegExp(
        `${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
      ).exec(bare)?.[1]
      expect(body, `no rule for ${rule}`).toBeDefined()
      expect(body, `${rule} must pin its CSS width`).toMatch(/(^|[;{\s])width\s*:/)
      expect(body, `${rule} must pin its CSS height`).toMatch(/(^|[;{\s])height\s*:/)
    }
  })

  it('draws the timeline into the canvas it hit-tests, not the wrap around it', () => {
    /*
     * The canvas sets its bitmap from a measured size and stores that size for
     * the pointer handlers to hit-test against. Measuring the *wrap* for it is
     * a different box: the canvas was shorter than its container, so a 228px
     * timeline was drawn inside a 140px element — the whole strip at 60% scale
     * — and every hit test below the ruler looked for the clips lane at a `y`
     * no click could reach. Seeking worked; marking a range by dragging did
     * nothing, and the bottom third of the strip was not the canvas at all.
     *
     * Verified in a real browser against this stylesheet at 100% and 250%
     * scaling: drawn height, element height and wrap height now all agree.
     */
    const timeline = readFileSync(
      fileURLToPath(new URL('../../src/renderer/src/components/Timeline.tsx', import.meta.url)),
      'utf8'
    )
    const draw = /const draw = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(timeline)?.[1]
    expect(draw, 'could not find Timeline draw()').toBeDefined()
    expect(draw, 'measure the canvas, not the wrap').not.toMatch(/wrap\.client/)
  })

  it('never lets the POV wall be sized by what is inside it', () => {
    /*
     * The wall's tiles are canvases whose bitmap is chosen from how big the
     * tile was measured to be. So if the grid takes its size from its contents,
     * that is a loop: measure, decode bigger, cell grows, measure again.
     *
     * It happened. Giving the grid an `aspect-ratio` (to stop each picture
     * being pillarboxed inside a wider cell) meant dropping `flex: 1` for
     * `flex: 0 1 auto`, and the wall oscillated and overflowed the window with
     * eight of nine tiles black. `flex: 1` with both minimums at zero is what
     * makes the grid's size come from the stage and nothing else.
     *
     * Any future attempt at exact 16:9 cells has to take the grid's size from
     * the *stage's* measured pixels instead, and this test should still pass.
     */
    const body = /\.pov-wall\s*\{([^}]*)\}/.exec(bare)?.[1]
    expect(body, 'no rule for .pov-wall').toBeDefined()
    expect(body, 'the measured box must be stretched by the stage').toMatch(/flex:\s*1\s*;/)
    expect(body, 'and must not be able to grow to fit the wall').toMatch(/min-height:\s*0/)
    expect(body).toMatch(/min-width:\s*0/)

    // And the thing being measured must not be the thing being sized from the
    // measurement. `gridRef` belongs on the wrapper; the grid takes its shape
    // from `stageAspect`, so observing the grid would close the loop again.
    const povGrid = readFileSync(
      fileURLToPath(new URL('../../src/renderer/src/components/PovGrid.tsx', import.meta.url)),
      'utf8'
    )
    expect(povGrid).toMatch(/ref=\{gridRef\}\s+className="pov-wall"/)
  })
})
