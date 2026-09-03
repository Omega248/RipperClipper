import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VodLibrary, datePending, sortNewestFirst } from '../../src/main/services/vodLibrary.js'
import { VodCrawler } from '../../src/main/services/vodCrawler.js'
import { Logger } from '../../src/main/services/logger.js'
import type { SavedStreamer, StreamerVod, VodCrawlProgress } from '../../src/shared/ipc.js'

let dir = ''
let log: Logger

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vodlib-'))
  log = new Logger(join(dir, 'logs'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function streamer(id: string, handle = id): SavedStreamer {
  return {
    id,
    platform: 'twitch',
    handle,
    displayName: handle,
    channelUrl: `https://twitch.tv/${handle}`,
    addedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null
  }
}

function vod(url: string, title: string, publishedAt: string | null = null): StreamerVod {
  return { url, title, durationSeconds: 600, publishedAt }
}

describe('VodLibrary', () => {
  it('keeps the expensive half of the knowledge when a listing is read again', async () => {
    const lib = new VodLibrary(log, dir)
    await lib.load()
    const alice = streamer('a')

    lib.putListing(alice, [vod('u1', 'One'), vod('u2', 'Two')])
    expect(lib.pendingDates()).toBe(2)

    lib.putDate('a', 'u2', '2026-05-05T00:00:00.000Z')
    expect(lib.pendingDates()).toBe(1)

    lib.putListing(alice, [vod('u1', 'One'), vod('u2', 'Two')])
    const kept = lib.shelf('a')?.vods.find((v) => v.url === 'u2')
    expect(kept?.publishedAt).toBe('2026-05-05T00:00:00.000Z')
  })

  it('does not re-queue a broadcast the platform already refused to date', async () => {
    // The regression this guards: '' means "asked, no answer" and is falsy, so
    // a truthiness check dropped it on every re-listing and the crawl asked
    // the same unanswerable question every twelve hours forever.
    const lib = new VodLibrary(log, dir)
    await lib.load()
    const alice = streamer('a')

    lib.putListing(alice, [vod('u1', 'One')])
    lib.putDate('a', 'u1', null)
    expect(lib.shelf('a')?.vods[0].publishedAt).toBe('')
    expect(datePending(lib.shelf('a')!.vods[0])).toBe(false)
    expect(lib.pendingDates()).toBe(0)

    lib.putListing(alice, [vod('u1', 'One')])
    expect(lib.shelf('a')?.vods[0].publishedAt).toBe('')
    expect(lib.pendingDates()).toBe(0)
    expect(lib.shelf('a')?.datedAt).not.toBeNull()
  })

  it('drops a broadcast the channel no longer lists', async () => {
    const lib = new VodLibrary(log, dir)
    await lib.load()
    lib.putListing(streamer('a'), [vod('u1', 'One'), vod('u2', 'Two')])
    lib.putListing(streamer('a'), [vod('u1', 'One')])
    expect(lib.shelf('a')?.vods.map((v) => v.url)).toEqual(['u1'])
  })

  it('persists across a restart, so a crawl resumes rather than restarts', async () => {
    const lib = new VodLibrary(log, dir)
    await lib.load()
    lib.putListing(streamer('a'), [vod('u1', 'One')])
    lib.putDate('a', 'u1', '2026-05-05T00:00:00.000Z')
    await lib.flush()

    const stored = JSON.parse(await readFile(join(dir, 'streamer-vods.json'), 'utf8'))
    expect(stored.version).toBe(1)

    const reopened = new VodLibrary(log, dir)
    await reopened.load()
    expect(reopened.shelf('a')?.vods[0].publishedAt).toBe('2026-05-05T00:00:00.000Z')
  })

  it('forgets a shelf when its streamer is removed', async () => {
    const lib = new VodLibrary(log, dir)
    await lib.load()
    lib.putListing(streamer('a'), [vod('u1', 'One')])
    lib.forget('a')
    expect(lib.shelf('a')).toBeNull()
  })

  it('sorts newest first and puts undated broadcasts last, not in 1970', () => {
    const sorted = sortNewestFirst([
      vod('a', 'A', ''),
      vod('b', 'B', '2026-01-01T00:00:00.000Z'),
      vod('c', 'C', '2026-06-01T00:00:00.000Z')
    ])
    expect(sorted.map((v) => v.url)).toEqual(['c', 'b', 'a'])
  })
})

interface Harness {
  crawler: VodCrawler
  library: VodLibrary
  calls: { listings: string[]; dates: string[] }
  events: VodCrawlProgress[]
  step: () => Promise<void>
}

async function crawlerHarness(
  options: {
    busy?: () => boolean
    listings?: Record<string, StreamerVod[]>
    failing?: string[]
  } = {}
): Promise<Harness> {
  const library = new VodLibrary(log, join(dir, Math.random().toString(36).slice(2)))
  await library.load()

  const listings = options.listings ?? {
    a: [vod('a1', 'A one'), vod('a2', 'A two')],
    b: [vod('b1', 'B one')]
  }
  const failing = new Set(options.failing ?? [])
  const calls = { listings: [] as string[], dates: [] as string[], bulk: [] as string[] }
  const events: VodCrawlProgress[] = []

  const streamers = {
    list: async () => Object.keys(listings).map((id) => streamer(id)),
    listChannelVods: async (_platform: string, handle: string) => {
      calls.listings.push(handle)
      if (failing.has(handle)) throw new Error('channel is gone')
      return listings[handle] ?? []
    },
    vodDate: async (url: string) => {
      calls.dates.push(url)
      return '2026-04-01T00:00:00.000Z'
    },
    // No bulk shortcut in this harness: these cases are about the paced,
    // one-at-a-time path. Bulk has its own describe block below.
    bulkVodDates: async (platform: string) => {
      calls.bulk.push(platform)
      return {}
    }
  }

  const crawler = new VodCrawler(
    log,
    streamers as never,
    library,
    options.busy ?? (() => false),
    (progress) => events.push(progress)
  )
  // start() is what opens the running gate; a step outside it is a no-op. The
  // timer it schedules is twenty seconds out and unref'd, so it never fires
  // during a test — every tick below is driven by hand.
  crawler.start()

  return {
    crawler,
    library,
    calls,
    events,
    step: () => (crawler as unknown as { step(): Promise<void> }).step()
  }
}

describe('VodCrawler', () => {
  it('does exactly one thing per tick, listings before dates', async () => {
    const { crawler, library, calls, step } = await crawlerHarness()

    await step()
    expect(calls.listings).toHaveLength(1)
    expect(calls.dates).toHaveLength(0)

    await step()
    expect(calls.listings).toHaveLength(2)
    // Every channel is listed before any date is looked up, so a newly added
    // streamer shows a history in seconds rather than after an hour of dating.
    expect(calls.dates).toHaveLength(0)

    await step()
    expect(calls.dates).toHaveLength(1)

    await step()
    await step()
    expect(calls.dates).toHaveLength(3)
    expect(library.pendingDates()).toBe(0)

    const done = calls.listings.length + calls.dates.length
    await step()
    expect(calls.listings.length + calls.dates.length).toBe(done)

    crawler.stop()
  })

  it('stands aside while the machine is busy, and says so', async () => {
    let busy = true
    const { crawler, calls, events, step } = await crawlerHarness({ busy: () => busy })

    await step()
    expect(calls.listings).toHaveLength(0)
    expect(crawler.progress().waiting).toBe(true)
    expect(events.some((e) => e.waiting)).toBe(true)

    busy = false
    await step()
    expect(crawler.progress().waiting).toBe(false)
    expect(calls.listings).toHaveLength(1)

    crawler.stop()
  })

  it('reads the streamer being looked at first', async () => {
    const { crawler, calls, step } = await crawlerHarness()
    crawler.prioritise('b')
    await step()
    expect(calls.listings[0]).toBe('b')
    crawler.stop()
  })

  it('does not let one unreadable channel starve the rest', async () => {
    // The regression this guards: a failed listing has no listedAt, so it stayed
    // permanently the stalest channel, was chosen again on the very next tick,
    // and nobody behind it was ever read.
    const { crawler, library, calls, step } = await crawlerHarness({ failing: ['a'] })

    await step()
    expect(library.shelf('a')?.error).toBe('channel is gone')

    await step()
    expect(calls.listings).toEqual(['a', 'b'])
    expect(library.shelf('b')?.vods).toHaveLength(1)
    expect(crawler.progress().active).toBeNull()

    crawler.stop()
  })
})

describe('dating a channel in one request', () => {
  it('takes the whole back catalogue at once where the platform offers it', async () => {
    // Twitch will answer for a hundred broadcasts in one call. Doing it one
    // process at a time is what made a three-hundred-VOD channel a
    // seventeen-minute crawl.
    const library = new VodLibrary(log, join(dir, 'bulk'))
    await library.load()
    const twitch: SavedStreamer = { ...streamer('t'), platform: 'twitch' }
    const listing = [vod('t1', 'One'), vod('t2', 'Two'), vod('t3', 'Three')]

    const calls = { bulk: 0, single: 0 }
    const streamers = {
      list: async () => [twitch],
      listChannelVods: async () => listing,
      bulkVodDates: async (_p: string, _h: string, pending: StreamerVod[]) => {
        calls.bulk += 1
        return Object.fromEntries(pending.map((v) => [v.url, '2026-04-01T00:00:00.000Z']))
      },
      vodDate: async () => {
        calls.single += 1
        return '2026-04-01T00:00:00.000Z'
      }
    }
    const crawler = new VodCrawler(log, streamers as never, library, () => false, () => undefined)
    crawler.start()
    const step = (): Promise<void> => (crawler as unknown as { step(): Promise<void> }).step()

    await step() // listing
    await step() // every date, in one go
    expect(calls.bulk).toBe(1)
    expect(calls.single).toBe(0)
    expect(library.pendingDates()).toBe(0)

    crawler.stop()
  })

  it('falls back to one at a time when the platform will not answer in bulk', async () => {
    const library = new VodLibrary(log, join(dir, 'nobulk'))
    await library.load()
    const calls = { single: 0 }
    const streamers = {
      list: async () => [streamer('k')],
      listChannelVods: async () => [vod('k1', 'One'), vod('k2', 'Two')],
      bulkVodDates: async () => ({}),
      vodDate: async () => {
        calls.single += 1
        return '2026-04-01T00:00:00.000Z'
      }
    }
    const crawler = new VodCrawler(log, streamers as never, library, () => false, () => undefined)
    crawler.start()
    const step = (): Promise<void> => (crawler as unknown as { step(): Promise<void> }).step()

    await step()
    await step()
    expect(calls.single).toBe(1)
    expect(library.pendingDates()).toBe(1)

    crawler.stop()
  })
})
