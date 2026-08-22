import { describe, expect, it } from 'vitest'
import { PROFILE_MAX_AGE_MS, profileIsStale } from '../../src/main/services/streamerProfile.js'

/**
 * When a channel's name and picture are worth fetching again.
 *
 * A profile is decoration: refreshing it must be cheap and rare, and never
 * something that happens on every render.
 */
describe('profile freshness', () => {
  const now = Date.parse('2026-08-22T00:00:00Z')
  const agoMs = (ms: number): string => new Date(now - ms).toISOString()

  it('treats a never-fetched profile as stale', () => {
    expect(profileIsStale(undefined, now)).toBe(true)
  })

  it('leaves a recent profile alone', () => {
    expect(profileIsStale(agoMs(60 * 60 * 1000), now)).toBe(false)
  })

  it('refetches once it passes the max age', () => {
    expect(profileIsStale(agoMs(PROFILE_MAX_AGE_MS + 1000), now)).toBe(true)
  })

  it('treats an unparseable timestamp as stale rather than trusting it', () => {
    expect(profileIsStale('not a date', now)).toBe(true)
  })
})
