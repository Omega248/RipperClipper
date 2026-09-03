import { describe, expect, it } from 'vitest'
import { pickChannelVideo } from '../../src/main/media/kickDirect.js'
import type { ChannelVideoEntry } from '../../src/main/media/kickDirect.js'

/**
 * Opening a live channel opens the recording it is already making.
 *
 * Kick writes the VOD as the broadcast happens, so a channel that went live
 * four hours ago already has four hours of seekable, clippable recording.
 * Verified against a live channel: `/api/v2/channels/<slug>/videos` returns the
 * broadcast in progress as its newest entry with `is_live: true`, a
 * `video.uuid`, and a master playlist whose media playlists start at segment 0
 * and cover everything streamed so far.
 *
 * The app used to hold a rolling in-memory buffer of the last few minutes
 * instead, so you could not scrub back to something near the start of the
 * stream, let alone cut it.
 */
const entry = (over: Partial<ChannelVideoEntry> & { uuid?: string | null }): ChannelVideoEntry => ({
  is_live: over.is_live,
  start_time: over.start_time,
  video: over.uuid === null ? {} : { uuid: over.uuid ?? 'v-default' }
})

describe('picking which broadcast to open', () => {
  it('prefers the one still going', () => {
    const picked = pickChannelVideo([
      entry({ uuid: 'older', start_time: '2026-09-02 01:00:00' }),
      entry({ uuid: 'live', start_time: '2026-09-01 09:00:00', is_live: true })
    ])
    expect(picked?.video?.uuid).toBe('live')
  })

  it('falls back to the newest when nothing is live', () => {
    const picked = pickChannelVideo([
      entry({ uuid: 'old', start_time: '2026-08-30 12:00:00' }),
      entry({ uuid: 'newest', start_time: '2026-09-02 09:33:20' }),
      entry({ uuid: 'middle', start_time: '2026-09-01 22:00:00' })
    ])
    expect(picked?.video?.uuid).toBe('newest')
  })

  it('skips entries with no recording behind them', () => {
    const picked = pickChannelVideo([
      entry({ uuid: null, start_time: '2026-09-02 10:00:00', is_live: true }),
      entry({ uuid: 'real', start_time: '2026-09-01 09:00:00' })
    ])
    expect(picked?.video?.uuid).toBe('real')
  })

  it('says so rather than guessing when there is nothing', () => {
    expect(pickChannelVideo([])).toBeNull()
    expect(pickChannelVideo([entry({ uuid: null })])).toBeNull()
  })
})
