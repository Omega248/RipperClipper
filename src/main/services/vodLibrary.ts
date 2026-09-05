import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlatformId } from '../../shared/types.js'
import type { SavedStreamer, StreamerVod } from '../../shared/ipc.js'
import { atomicWriteJson } from './projects.js'
import type { Logger } from './logger.js'

/**
 * Every past broadcast the app knows about, per streamer, kept on disk.
 *
 * The point of writing it down is that finding it is expensive and the answer
 * barely changes. Twitch and YouTube list a channel's videos without dates, so
 * the only way to learn when a broadcast happened is to ask about that
 * broadcast specifically — one yt-dlp process each. A channel with three
 * hundred VODs is three hundred processes, which is a fine price to pay once
 * and an absurd one to pay on every visit to a page.
 *
 * So this file is the memory that makes the crawl a one-off. It is a cache in
 * the sense that it can always be rebuilt, and not one in the sense that it is
 * never dropped to save space: a channel's history is small text and the
 * effort behind it is the valuable part.
 */

/** What is known about one streamer's back catalogue. */
export interface StreamerVodShelf {
  streamerId: string
  platform: PlatformId
  handle: string
  /** Newest first, as everywhere else in the app. */
  vods: StreamerVod[]
  /** When the channel listing itself was last read. */
  listedAt: string | null
  /**
   * When reading the listing was last *attempted*, successful or not.
   *
   * Distinct from `listedAt` because a channel that cannot be read has no
   * listing time but must still be remembered as tried — otherwise it stays
   * permanently the stalest thing in the library and the crawl returns to it
   * on every tick, never reaching anyone behind it.
   */
  attemptedAt?: string | null
  /** When every VOD in the list last had a date. Null while some are missing. */
  datedAt: string | null
  /** Why the last attempt failed, so the UI can say so instead of showing nothing. */
  error?: string
}

interface Stored {
  version: 1
  shelves: StreamerVodShelf[]
}

export class VodLibrary {
  private readonly file: string
  private shelves = new Map<string, StreamerVodShelf>()
  private loaded = false
  /** Coalesces the writes a crawl produces into one per settle period. */
  private writeTimer: NodeJS.Timeout | null = null
  private writing: Promise<void> | null = null

  constructor(
    private readonly log: Logger,
    stateDir: string
  ) {
    this.file = join(stateDir, 'streamer-vods.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Stored
      for (const shelf of parsed?.shelves ?? []) {
        if (typeof shelf?.streamerId !== 'string') continue
        this.shelves.set(shelf.streamerId, {
          ...shelf,
          vods: Array.isArray(shelf.vods) ? shelf.vods : []
        })
      }
      this.log.info('vods', 'VOD library loaded', {
        streamers: this.shelves.size,
        vods: [...this.shelves.values()].reduce((n, s) => n + s.vods.length, 0)
      })
    } catch {
      // No library yet, or one we cannot read. Either way the crawl rebuilds
      // it, so this is a normal cold start rather than something to report.
      this.log.info('vods', 'Starting a new VOD library', { file: this.file })
    }
  }

  shelf(streamerId: string): StreamerVodShelf | null {
    return this.shelves.get(streamerId) ?? null
  }

  all(): StreamerVodShelf[] {
    return [...this.shelves.values()]
  }

  /**
   * How many VODs are still missing a date, across everything.
   *
   * This is the number the crawl is working through, and the honest way to
   * tell someone that the library is still filling in.
   */
  pendingDates(): number {
    let n = 0
    for (const shelf of this.shelves.values()) {
      n += shelf.vods.filter((v) => v.publishedAt === null).length
    }
    return n
  }

  /**
   * Merge a freshly read channel listing into what is already known.
   *
   * Merged rather than replaced, because the listing is the cheap half of the
   * knowledge and the dates are the expensive half: a VOD that is already
   * dated must keep its date when the channel is listed again, or every
   * refresh would throw away hours of crawling.
   */
  putListing(streamer: SavedStreamer, listed: StreamerVod[]): StreamerVodShelf {
    const existing = this.shelves.get(streamer.id)
    const known = new Map((existing?.vods ?? []).map((v) => [v.url, v]))

    const merged = listed.map((vod) => {
      const before = known.get(vod.url)
      // Kept whenever it is anything other than "not asked yet" — including
      // the empty string, which means the platform was asked and would not
      // say. Treating that as unknown would put the VOD back in the queue on
      // every re-listing, and the crawl would ask the same unanswerable
      // question every twelve hours, forever.
      return before && before.publishedAt !== null
        ? { ...vod, publishedAt: before.publishedAt }
        : vod
    })

    // VODs the channel no longer lists are dropped: a deleted broadcast is
    // not clippable, and keeping it would be a list of dead links that only
    // grows.
    const shelf: StreamerVodShelf = {
      streamerId: streamer.id,
      platform: streamer.platform,
      handle: streamer.handle,
      vods: sortNewestFirst(merged),
      listedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      datedAt: merged.every((v) => v.publishedAt !== null) ? new Date().toISOString() : null
    }
    this.shelves.set(streamer.id, shelf)
    this.scheduleWrite()
    return shelf
  }

  /** Record the date the crawl just worked out for one broadcast. */
  putDate(streamerId: string, url: string, publishedAt: string | null): void {
    const shelf = this.shelves.get(streamerId)
    if (!shelf) return
    const index = shelf.vods.findIndex((v) => v.url === url)
    if (index === -1) return

    // A lookup that came back with nothing still counts as done, or the crawl
    // would return to the same unanswerable VOD forever. It is recorded as an
    // empty string rather than null so "asked, no answer" is distinguishable
    // from "not asked yet" — see `datePending`.
    shelf.vods[index] = { ...shelf.vods[index], publishedAt: publishedAt ?? '' }
    shelf.vods = sortNewestFirst(shelf.vods)
    if (shelf.vods.every((v) => v.publishedAt !== null)) {
      shelf.datedAt = new Date().toISOString()
    }
    this.scheduleWrite()
  }

  /**
   * Put every unanswered VOD back in the queue for this streamer.
   *
   * "Asked, and the platform would not say" is normally worth remembering —
   * it stops the crawl asking the same unanswerable question every twelve
   * hours. But it is recorded identically whether the platform said "this
   * recording is gone" or refused the request altogether, and a refusal can
   * mark a whole back catalogue undateable in a few minutes. This is the way
   * back: an explicit refresh means the person is telling us the answer might
   * be different now.
   *
   * Returns how many were reopened, so the caller can say.
   */
  forgetUnanswered(streamerId: string): number {
    const shelf = this.shelves.get(streamerId)
    if (!shelf) return 0
    let reopened = 0
    shelf.vods = shelf.vods.map((vod) => {
      if (vod.publishedAt !== '') return vod
      reopened++
      return { ...vod, publishedAt: null }
    })
    if (reopened > 0) {
      shelf.datedAt = null
      this.scheduleWrite()
    }
    return reopened
  }

  noteFailure(streamer: SavedStreamer, error: string): void {
    const existing = this.shelves.get(streamer.id)
    this.shelves.set(streamer.id, {
      streamerId: streamer.id,
      platform: streamer.platform,
      handle: streamer.handle,
      vods: existing?.vods ?? [],
      listedAt: existing?.listedAt ?? null,
      attemptedAt: new Date().toISOString(),
      datedAt: existing?.datedAt ?? null,
      error
    })
    this.scheduleWrite()
  }

  /** Forget a streamer's shelf, when the streamer itself is removed. */
  forget(streamerId: string): void {
    if (this.shelves.delete(streamerId)) this.scheduleWrite()
  }

  /**
   * Write soon, not now.
   *
   * A crawl records a date every few seconds for hours. Writing the whole
   * library on each of those would be thousands of rewrites of a file nobody
   * is reading in between, so they settle into one.
   */
  private scheduleWrite(): void {
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, 5000)
    this.writeTimer.unref?.()
  }

  /** Write now. Called on quit, so nothing crawled is lost to a settle timer. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    // One write at a time, and never interleaved: two atomic writes racing on
    // the same path is how a library ends up truncated.
    this.writing = (this.writing ?? Promise.resolve()).then(async () => {
      const stored: Stored = { version: 1, shelves: [...this.shelves.values()] }
      await atomicWriteJson(this.file, stored).catch((err) => {
        this.log.warn('vods', 'Could not write the VOD library', err)
      })
    })
    await this.writing
  }
}

/**
 * Newest first, with undated broadcasts last.
 *
 * An unknown date sorts to the end rather than to 1970: a VOD the crawl has
 * not reached yet is not an ancient one, and putting it at the top of the
 * list would be a lie about the channel's history.
 */
export function sortNewestFirst(vods: StreamerVod[]): StreamerVod[] {
  return vods.slice().sort((a, b) => {
    const left = a.publishedAt || ''
    const right = b.publishedAt || ''
    if (left === right) return a.title.localeCompare(b.title)
    if (left === '') return 1
    if (right === '') return -1
    return right.localeCompare(left)
  })
}

/** Whether this broadcast still needs the expensive per-VOD date lookup. */
export function datePending(vod: StreamerVod): boolean {
  return vod.publishedAt === null
}
