import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildAudioFilter, editsForPov } from '../../src/shared/audioEdits.js'
import type { AudioEdit } from '../../src/shared/audioEdits.js'

/**
 * The mute has to survive the whole way to ffmpeg, not just exist.
 *
 * `tests/integration/audioEdits.test.ts` proves the *exporter* applies these
 * correctly — it calls `exportClip({ audioEdits })` directly. What nothing
 * covered was everything upstream of that call, and both links in it were
 * broken: `exportClips` in the renderer built its request literal by naming
 * fields and never named `audioEdits`, and `withAudioPovStreams` in the main
 * process rebuilt each clip the same way, dropping the field again for any
 * clip whose sound comes from another POV.
 *
 * So every mute, bleep and duck drawn in Properties was silently absent from
 * the exported file, with no note and no error, while a green integration
 * suite said the feature worked. The ranges people mute are slurs, doxxes and
 * leaks, so "silently ignored" is the worst available outcome.
 */

const src = (path: string): string => readFileSync(resolve(__dirname, '../../src', path), 'utf8')

describe('audio edits reach the export request', () => {
  it('the renderer puts them on the enqueue request', () => {
    const app = src('renderer/src/App.tsx')
    const literal = /group\.clips\.push\(\{[\s\S]*?\n {8}\}\)/.exec(app)?.[0]
    expect(literal, 'could not find the enqueue clip literal').toBeDefined()
    expect(literal, 'the export request must carry the clip audio edits').toContain('audioEdits')
  })

  it('the main process carries them past the audio-POV resolve', () => {
    const main = src('main/index.ts')
    const fn = /async function withAudioPovStreams[\s\S]*?\n\}/.exec(main)?.[0]
    expect(fn, 'could not find withAudioPovStreams').toBeDefined()
    /*
     * Asserted as "does not hand-list its fields" rather than "mentions
     * audioEdits": the bug was the rebuild, and a rebuild that happens to
     * remember one field today drops the next one added.
     */
    expect(fn).toContain('...carried')
    expect(fn, 'a hand-listed rebuild drops whatever it forgets').not.toMatch(
      /out\.push\(\{\s*id: clip\.id,/
    )
  })
})

describe('which edits belong to an export', () => {
  const edit = (over: Partial<AudioEdit>): AudioEdit => ({
    id: 'e1',
    kind: 'mute',
    startSeconds: 1,
    endSeconds: 2,
    ...over
  })

  it('takes the ones drawn against the POV supplying the sound', () => {
    const edits = [
      edit({ id: 'a', povId: 'pov-a' }),
      edit({ id: 'b', povId: 'pov-b' }),
      edit({ id: 'none' })
    ]
    // An edit with no POV belongs to whichever POV is being exported, which
    // is the same convention the Properties panel displays them under.
    expect(editsForPov(edits, 'pov-b', 'pov-b').map((e) => e.id)).toEqual(['b', 'none'])
    expect(editsForPov(edits, 'pov-a', 'pov-a').map((e) => e.id)).toEqual(['a', 'none'])
  })

  it('a gate shifted by the safety margin still covers the words it was drawn over', () => {
    /*
     * A POV whose alignment is uncertain is exported with padding, so the
     * file starts `pad` seconds *before* the clip does. Edit times are
     * clip-relative, so without the shift every gate lands `pad` early — on a
     * two-second margin that is the whole mute missing its target.
     */
    const pad = 2
    const drawn = edit({ startSeconds: 30.1, endSeconds: 30.6 })
    const shifted = { ...drawn, startSeconds: drawn.startSeconds + pad, endSeconds: drawn.endSeconds + pad }

    const plan = buildAudioFilter([shifted], {
      inputLabel: '0:a:0',
      durationSeconds: 60
    })
    expect(plan.filterComplex).toBeTruthy()
    // The gate is expressed in the exported file's own clock.
    expect(plan.filterComplex).toContain('32.1')
    expect(plan.filterComplex).toContain('32.6')
  })

  it('produces no filter graph when there is nothing to do', () => {
    expect(buildAudioFilter([], { inputLabel: '0:a:0', durationSeconds: 10 }).filterComplex).toBeNull()
  })
})
