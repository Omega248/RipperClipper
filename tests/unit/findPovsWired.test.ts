import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { personAliases, samePerson } from '../../src/shared/povPriority.js'

/**
 * The find-POVs flow has three moving parts and each has been broken once.
 *
 * It fires automatically when a clip is made — that is the whole point, because
 * the moment you have just marked is when you know what you are looking for.
 * It shows a dialog. And it runs its sweep exactly once per opening rather than
 * on every render. None of the three is visible in a type check.
 */
const app = readFileSync(fileURLToPath(new URL('../../src/renderer/src/App.tsx', import.meta.url)), 'utf8')
const dialog = readFileSync(
  fileURLToPath(new URL('../../src/renderer/src/components/FindPovsDialog.tsx', import.meta.url)),
  'utf8'
)

describe('finding other POVs', () => {
  it('is triggered by making a clip, not by a menu somewhere', () => {
    // createClip and the search have to stay in the same handler: separating
    // them is how the automatic part quietly stops being automatic.
    const handler = app.slice(app.indexOf('store.createClip(name)'), app.indexOf('store.createClip(name)') + 900)
    expect(handler).toContain('setFindPovsFor(')
    expect(handler).toContain('eventStartTime')
  })

  it('renders the dialog when there is a clip to search for', () => {
    expect(app).toMatch(/\{findPovsFor && \(\s*<FindPovsDialog/)
  })

  it('passes the clip’s real-world window, which is what the search needs', () => {
    expect(app).toContain('eventStartSeconds={findPovsFor.startSeconds}')
    expect(app).toContain('eventEndSeconds={findPovsFor.endSeconds}')
  })

  it('sweeps the saved library and then the platforms', () => {
    expect(dialog).toContain('window.api.streamersCoveringEvent(')
    expect(dialog).toContain('window.api.discoverEvent(')
  })

  it('runs the sweep once per opening', () => {
    // `loadedUrls` is a fresh array on every render of the parent. As an effect
    // dependency it restarted the whole two-phase search several times a
    // second; the URLs are captured at open instead.
    expect(dialog).toContain('startedWith.current')
    const deps = /\}, \[eventStartSeconds, eventEndSeconds, absorb\]\)/
    expect(dialog).toMatch(deps)
  })

  it('still offers to add what it finds', () => {
    expect(dialog).toContain('onAdd(picked.map(')
    expect(app).toContain('for (const one of picked) await loadVod(one.url)')
  })
})

/**
 * The dedupe must not eat the results.
 *
 * Collapsing a simulcast to one angle is right; collapsing the list to nothing
 * because two different key shapes were compared is the bug that hid behind it.
 */
describe('excluding people already on the wall', () => {
  const personOf = new Map([['s_twitch', 'p1']])
  const lookup = (id: string): string | undefined => personOf.get(id)

  it('matches a linked candidate against a POV loaded under only a name', () => {
    // The loaded POV was known by name; the sweep knows the same human through
    // the library's person link. Comparing one key against the other found
    // nothing, and the duplicate came straight back.
    const loaded = new Set(personAliases({ streamerName: 'Leonarwho' }, lookup))
    const candidate = personAliases({ streamerId: 's_twitch', streamerName: 'Leonarwho' }, lookup)
    expect(samePerson(candidate, loaded)).toBe(true)
  })

  it('matches through the person link when the display names differ', () => {
    const loaded = new Set(personAliases({ streamerId: 's_twitch', streamerName: 'Silbullet' }, lookup))
    const candidate = personAliases({ streamerId: 's_twitch', streamerName: 'SilbulletLIVE' }, lookup)
    expect(samePerson(candidate, loaded)).toBe(true)
  })

  it('does not exclude somebody who is simply not loaded', () => {
    const loaded = new Set(personAliases({ streamerName: 'Leonarwho' }, lookup))
    expect(samePerson(personAliases({ streamerName: 'uhsnow' }, lookup), loaded)).toBe(false)
  })

  it('excludes nothing when nothing is loaded', () => {
    expect(samePerson(personAliases({ streamerName: 'anyone' }), new Set())).toBe(false)
  })
})
