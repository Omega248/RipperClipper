import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StreamerService } from '../../src/main/services/streamers.js'
import { Logger } from '../../src/main/services/logger.js'
import type { ResolverService } from '../../src/main/media/resolver.js'
import type { StreamerVodShelf } from '../../src/shared/ipc.js'

/**
 * Asking "who else filmed this moment" used to list every saved channel live
 * and then ask the platform for a date per broadcast — forty-five channels and
 * a thousand requests for one question, most of which YouTube answers with a
 * bot check. The crawled shelf already holds that answer, dated.
 */
describe('a channel s broadcasts come from the crawled shelf', () => {
  let dir: string
  let log: Logger
  let service: StreamerService
  const flatPlaylist = vi.fn()

  beforeEach(async () => {
    flatPlaylist.mockReset()
    flatPlaylist.mockResolvedValue([])
    dir = await mkdtemp(join(tmpdir(), 'cookieclip-shelf-'))
    log = new Logger(join(dir, 'logs'))
    service = new StreamerService(log, { flatPlaylist } as unknown as ResolverService, dir)
  })

  afterEach(async () => {
    log.close()
    await rm(dir, { recursive: true, force: true })
  })

  const shelfOf = (streamerId: string): StreamerVodShelf => ({
    streamerId,
    platform: 'twitch',
    handle: 'someone',
    vods: [
      {
        url: 'https://www.twitch.tv/videos/1',
        title: 'Night one',
        durationSeconds: 7200,
        publishedAt: '2026-08-30T20:00:00.000Z'
      }
    ],
    listedAt: '2026-08-31T00:00:00.000Z',
    datedAt: '2026-08-31T00:00:00.000Z'
  })

  it('reads the shelf instead of the platform', async () => {
    const saved = await service.add('twitch.tv/someone')
    service.shelfFor = (id) => (id === saved[0].id ? shelfOf(id) : null)

    const vods = await service.vods(saved[0].id)

    expect(vods).toHaveLength(1)
    expect(vods[0].publishedAt).toBe('2026-08-30T20:00:00.000Z')
    expect(flatPlaylist).not.toHaveBeenCalled()
  })

  it('still lists a channel the crawl has not reached yet', async () => {
    const saved = await service.add('twitch.tv/someone')
    service.shelfFor = () => null

    await service.vods(saved[0].id)

    expect(flatPlaylist).toHaveBeenCalledTimes(1)
  })

  it('matches the event against the shelf, so the search costs no requests', async () => {
    const saved = await service.add('twitch.tv/someone')
    service.shelfFor = (id) => (id === saved[0].id ? shelfOf(id) : null)

    // 20:30 UTC, half an hour into a two-hour broadcast.
    const start = Date.parse('2026-08-30T20:30:00.000Z') / 1000
    const reply = await service.coveringEvent({
      eventStartSeconds: start,
      eventEndSeconds: start + 120,
      loadedUrls: []
    })

    expect(reply.streams).toHaveLength(1)
    expect(reply.streams[0].coverage.offsetSeconds).toBe(1800)
    expect(flatPlaylist).not.toHaveBeenCalled()
  })
})
