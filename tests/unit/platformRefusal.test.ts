import { describe, expect, it } from 'vitest'
import { AppError, Errors, isPlatformRefusal } from '@shared/errors'

/**
 * The distinction that stopped a bot check from permanently undating a
 * channel's whole back catalogue.
 *
 * Taken from a real log: 131 YouTube broadcasts, each asked once, each
 * refused with "Sign in to confirm you're not a bot", each then recorded as
 * "asked, no answer" and never asked again.
 */

describe('isPlatformRefusal', () => {
  it('recognises the message that caused this', () => {
    // Verbatim from the log, curly apostrophe and all.
    const stderr =
      "ERROR: [youtube] o7vtsWa0orM: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."
    expect(isPlatformRefusal(Errors.resolverFailed(stderr))).toBe(true)
    // And the straight-apostrophe spelling, which yt-dlp also emits.
    expect(isPlatformRefusal(Errors.resolverFailed("Sign in to confirm you're not a bot."))).toBe(true)
  })

  it('recognises a refusal by code, whatever it says', () => {
    expect(isPlatformRefusal(Errors.authRequired('YouTube'))).toBe(true)
  })

  it('recognises rate limiting in its usual disguises', () => {
    for (const text of [
      'HTTP Error 429: Too Many Requests',
      'You have been rate-limited, try again later',
      'temporarily blocked'
    ]) {
      expect(isPlatformRefusal(Errors.resolverFailed(text)), text).toBe(true)
    }
  })

  it('does NOT claim a genuinely missing recording is a refusal', () => {
    // This one must stay recordable, or the crawl asks about a deleted VOD
    // every twelve hours forever.
    expect(
      isPlatformRefusal(
        Errors.vodUnavailable('Unable to download JSON metadata: HTTP Error 404: Not Found')
      )
    ).toBe(false)
    expect(isPlatformRefusal(Errors.resolverFailed('exit code 1'))).toBe(false)
    expect(isPlatformRefusal(new Error('socket hang up'))).toBe(false)
  })

  it('survives being handed something that is not an error at all', () => {
    expect(isPlatformRefusal(null)).toBe(false)
    expect(isPlatformRefusal(undefined)).toBe(false)
    // A plain object is not an AppError and stringifies to nothing useful, so
    // a `code` property alone is not taken at its word.
    expect(isPlatformRefusal({ code: 'auth-required' })).toBe(false)
  })

  it('still reads a bare string that carries the platform\'s own words', () => {
    // Not every caller wraps before asking, and erring towards "back off" is
    // the safe direction: the cost of a wrong true is a thirty-minute pause,
    // the cost of a wrong false is a back catalogue marked undateable.
    expect(isPlatformRefusal('sign in to confirm you are not a bot')).toBe(true)
    expect(isPlatformRefusal('some unrelated failure')).toBe(false)
  })

  it('reads the detail as well as the message', () => {
    // The platform's own words arrive in `detail`, not in the sentence shown
    // to the person — which is where the giveaway usually is.
    const err = new AppError({
      code: 'resolver-failed',
      title: 'Could not read this broadcast',
      message: 'Something went wrong.',
      detail: 'ERROR: HTTP Error 429: Too Many Requests'
    })
    expect(isPlatformRefusal(err)).toBe(true)
  })
})
