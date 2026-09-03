import type { SavedStreamer } from '../../shared/ipc.js'
import type { StreamerService } from './streamers.js'
import type { VodLibrary } from './vodLibrary.js'
import { datePending } from './vodLibrary.js'
import { isPlatformRefusal } from '../../shared/errors.js'
import type { Logger } from './logger.js'

/**
 * Fills in every saved streamer's back catalogue, slowly, in the background.
 *
 * The pace is the feature. Learning when a broadcast happened costs one
 * yt-dlp process on Twitch and YouTube, and a library of a dozen streamers is
 * thousands of them — run eagerly that is a burst of processes and a platform
 * wondering what this client is doing. Run one at a time with a gap, it is a
 * background hum nobody notices that has quietly finished by the time anyone
 * looks.
 *
 * So this does exactly one thing per tick, holds no parallelism of its own,
 * yields entirely while an export is running, and writes down every answer as
 * it gets it — a crawl interrupted by quitting the app resumes rather than
 * restarts.
 */

/**
 * Gap between two pieces of work.
 *
 * Roughly a thousand lookups an hour: fast enough that a channel's history is
 * complete within a session, slow enough that it never looks like a scrape.
 */
const STEP_MS = 3_500

/** Gap when there is nothing to do, before looking for work again. */
const IDLE_MS = 60_000

/** Gap while the machine is busy with something the person asked for. */
const BUSY_MS = 20_000

/** How long a channel listing stays fresh before it is worth reading again. */
const LISTING_TTL_MS = 12 * 60 * 60 * 1000

/** Settle time after startup, so the crawl never competes with opening a project. */
const START_DELAY_MS = 20_000

/**
 * How long a channel that could not be read is left alone.
 *
 * Without this a failed listing stays the stalest thing in the library, so the
 * crawl picks it again on the very next tick and hammers a dead or blocked
 * channel every few seconds while every other streamer waits behind it.
 */
const RETRY_MS = 10 * 60 * 1000

/**
 * How long a whole platform is left alone after it refuses us.
 *
 * A bot check or a rate limit is not about the recording being asked for — it
 * is about this client, and it applies to everything on that platform at
 * once. Carrying on down the list means a hundred and thirty more refusals in
 * ten minutes, which is both pointless and exactly the behaviour that
 * provoked the block.
 */
const REFUSED_MS = 30 * 60 * 1000

export interface VodCrawlProgress {
  /** A streamer is being worked on right now, by display name. */
  active: string | null
  /** Broadcasts still needing a date, across every streamer. */
  pending: number
  /** True while the crawl is standing aside for an export. */
  waiting: boolean
}

export class VodCrawler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private active: string | null = null
  private waiting = false

  constructor(
    private readonly log: Logger,
    private readonly streamers: StreamerService,
    private readonly library: VodLibrary,
    /** True while the person is waiting on something that needs the machine. */
    private readonly isBusy: () => boolean,
    /** Called when the progress a person could be watching has changed. */
    private readonly onProgress: (progress: VodCrawlProgress) => void
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(START_DELAY_MS)
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  progress(): VodCrawlProgress {
    return { active: this.active, pending: this.library.pendingDates(), waiting: this.waiting }
  }

  /**
   * Bring one streamer to the front of the queue.
   *
   * Opening someone's page is the clearest possible statement of what matters
   * now, and a crawl that ignored it would leave a person watching a spinner
   * while it dated somebody else's broadcasts from last year.
   */
  prioritise(streamerId: string): void {
    // Asking again for whoever is already at the front changes nothing, and
    // must not reset the timer: the page re-reads a shelf on every progress
    // event, so honouring a repeat would pull the next step forward to now,
    // over and over, and the pacing this whole class exists for would be gone
    // for exactly as long as someone had the page open.
    if (this.priority === streamerId) return
    this.priority = streamerId
    // Only worth interrupting an idle wait; a step already in flight finishes.
    if (this.running && !this.active) this.schedule(0)
  }

  private priority: string | null = null
  /** Platform → when it is worth asking again. See `REFUSED_MS`. */
  private readonly refusedUntil = new Map<string, number>()

  private schedule(delayMs: number): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.step(), delayMs)
    // A background crawl must never be the reason the app will not quit.
    this.timer.unref?.()
  }

  private async step(): Promise<void> {
    if (!this.running) return

    // Stand aside entirely while the person is waiting on something. The
    // crawl has hours; an export does not.
    if (this.isBusy()) {
      if (!this.waiting) {
        this.waiting = true
        this.emit()
      }
      this.schedule(BUSY_MS)
      return
    }
    if (this.waiting) {
      this.waiting = false
      this.emit()
    }

    let did = false
    try {
      did = await this.doOneThing()
    } catch (err) {
      // A crawl that stopped on the first unreachable channel would never
      // finish the reachable ones.
      this.log.debug('vods', 'A crawl step failed', err)
    } finally {
      this.active = null
      this.emit()
    }

    this.schedule(did ? STEP_MS : IDLE_MS)
  }

  /**
   * One unit of work: either read a channel's listing, or date one broadcast.
   *
   * Listings come first across the board, so a new streamer's history appears
   * in the interface within seconds of being added rather than after every
   * older streamer has been fully dated.
   */
  private async doOneThing(): Promise<boolean> {
    const all = await this.streamers.list()
    if (all.length === 0) return false

    const order = this.inPriorityOrder(all)

    const needsListing = order.find((s) => this.listingIsStale(s))
    if (needsListing) {
      await this.readListing(needsListing)
      return true
    }

    for (const streamer of order) {
      if ((this.refusedUntil.get(streamer.platform) ?? 0) > Date.now()) continue
      const shelf = this.library.shelf(streamer.id)
      const pending = shelf?.vods.filter(datePending) ?? []
      if (pending.length === 0) continue
      this.active = streamer.displayName
      this.emit()

      /*
       * Ask for the whole channel at once first.
       *
       * Where a platform will answer in bulk — Twitch, through the same GQL
       * endpoint the profile lookup uses — a channel's entire back catalogue
       * is dated in one request rather than one process per broadcast. Three
       * hundred VODs stop being seventeen minutes of crawling and become a
       * single tick, which is the difference between a page that fills in
       * while you look at it and one you come back to later.
       */
      const bulk = await this.streamers
        .bulkVodDates(streamer.platform, streamer.handle, pending)
        .catch(() => ({}))
      const found = Object.entries(bulk)
      if (found.length > 0) {
        for (const [url, at] of found) this.library.putDate(streamer.id, url, at)
        this.log.info('vods', 'Dated a channel in one request', {
          handle: streamer.handle,
          dated: found.length,
          of: pending.length
        })
        return true
      }

      // No shortcut for this platform, or it declined: one at a time, paced.
      const next = pending[0]
      try {
        const date = await this.streamers.vodDate(next.url, { priority: 'idle' })
        this.library.putDate(streamer.id, next.url, date)
      } catch (err) {
        /*
         * Only record an answer when the platform actually gave one.
         *
         * `putDate(…, null)` means "asked, nothing to tell" and is never asked
         * again — right for a deleted recording, catastrophic for a bot check.
         * Swallowing every error into that branch is how one bad ten minutes
         * on YouTube marked a hundred and thirty broadcasts permanently
         * undateable: the block cleared, and nothing ever went back.
         */
        if (isPlatformRefusal(err)) {
          this.refusedUntil.set(streamer.platform, Date.now() + REFUSED_MS)
          this.log.warn('vods', 'Platform refused the crawl; backing off', {
            platform: streamer.platform,
            minutes: Math.round(REFUSED_MS / 60_000),
            stillPending: pending.length
          })
          return true
        }
        this.library.putDate(streamer.id, next.url, null)
      }
      return true
    }

    // Everything listed, everything dated. The library is complete until a
    // listing goes stale or a streamer is added.
    return false
  }

  /** The streamer the person is looking at first, then the least recently read. */
  private inPriorityOrder(all: SavedStreamer[]): SavedStreamer[] {
    const wanted = this.priority
    return all.slice().sort((a, b) => {
      if (wanted) {
        if (a.id === wanted) return -1
        if (b.id === wanted) return 1
      }
      // Ordered by when each was last *tried*, not when it was last read, so
      // a channel that keeps failing drifts to the back instead of sitting at
      // the front forever with nothing to show for it.
      const left = attemptedAt(this.library.shelf(a.id))
      const right = attemptedAt(this.library.shelf(b.id))
      // Never-tried channels sort first: an empty shelf is the worst thing a
      // person can be shown, and it is also the cheapest to fix.
      return left.localeCompare(right)
    })
  }

  private listingIsStale(streamer: SavedStreamer): boolean {
    const shelf = this.library.shelf(streamer.id)

    // A channel that just failed is left alone for a while. It is still stale
    // in the sense that matters to a person looking at it, but asking again
    // immediately would not fix that and would mean a request every few
    // seconds against something already telling us no.
    if (shelf?.error && shelf.attemptedAt) {
      if (Date.now() - Date.parse(shelf.attemptedAt) < RETRY_MS) return false
    }

    if (!shelf?.listedAt) return true
    return Date.now() - Date.parse(shelf.listedAt) > LISTING_TTL_MS
  }

  private async readListing(streamer: SavedStreamer): Promise<void> {
    this.active = streamer.displayName
    this.emit()
    try {
      const listed = await this.streamers.listChannelVods(streamer.platform, streamer.handle, {
        priority: 'idle'
      })
      this.library.putListing(streamer, listed)
      this.log.info('vods', 'Read a channel listing', {
        handle: streamer.handle,
        count: listed.length
      })
    } catch (err) {
      // Recorded on the shelf so the page can say why it is empty, instead of
      // looking like a channel with no broadcasts.
      this.library.noteFailure(streamer, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  private emit(): void {
    try {
      this.onProgress(this.progress())
    } catch (err) {
      this.log.warn('vods', 'A crawl-progress listener threw', err)
    }
  }
}

/** When a shelf's listing was last attempted; empty sorts first, as never-tried. */
function attemptedAt(shelf: { attemptedAt?: string | null; listedAt: string | null } | null): string {
  return shelf?.attemptedAt ?? shelf?.listedAt ?? ''
}
