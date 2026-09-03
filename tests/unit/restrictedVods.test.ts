import { describe, expect, it } from 'vitest'
import { defaultSettings, mergeSettings } from '../../src/shared/defaults.js'

/**
 * The sign-in cookie setting has to actually reach yt-dlp.
 *
 * Both platform adapters have told people for a long time that restricted VODs
 * need "an authenticated session" set up in Settings — while no such setting
 * existed and the resolver's `cookiesFromBrowser` option had no caller. That is
 * worse than an unimplemented feature: it is an instruction the user cannot
 * follow, on the error that most needs a way out.
 */

const paths = {
  outputDirectory: '/out',
  cacheDirectory: '/cache'
}

describe('the sign-in cookie setting', () => {
  it('defaults to not touching the browser at all', () => {
    expect(defaultSettings(paths).advanced.cookiesFromBrowser).toBeNull()
  })

  it('survives a save and reload', () => {
    const base = defaultSettings(paths)
    const merged = mergeSettings(base, { advanced: { ...base.advanced, cookiesFromBrowser: 'firefox' } })
    expect(merged.advanced.cookiesFromBrowser).toBe('firefox')
  })

  it('is offered by the platforms whose notes tell people to set it', async () => {
    const { TwitchAdapter } = await import('../../src/main/platforms/twitch.js')
    const { YouTubeAdapter } = await import('../../src/main/platforms/youtube.js')
    for (const adapter of [new TwitchAdapter(), new YouTubeAdapter()]) {
      const note = adapter.capabilities.notes.find((n) => /authenticated session/i.test(n))
      expect(note, adapter.constructor.name).toBeDefined()
      // The place it names must be a real one. It used to say "Settings →
      // Advanced", which is not one of the tabs.
      expect(note).toContain('Settings → Setup')
    }
  })
})
