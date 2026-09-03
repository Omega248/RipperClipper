import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The Streamers page shipped once with no way to add a streamer: the roster
 * only ever grew as a side effect of loading a POV, and the header's one
 * primary button managed groups. This is the guard against that returning —
 * the bridge call has to be reachable from the page a person opens to do it.
 */
describe('add streamer is reachable from the Streamers page', () => {
  const page = readFileSync(
    resolve(__dirname, '../../src/renderer/src/components/StreamersPage.tsx'),
    'utf8'
  )

  it('calls the addStreamer bridge', () => {
    expect(page).toContain('window.api.addStreamer(')
  })

  it('offers it as a control, not only as a handler', () => {
    expect(page).toMatch(/Add streamer/)
  })
})
