import { writeFile } from 'node:fs/promises'
import { ConcurrencyLimiter } from '../services/limiter.js'
import type { LiveState, StreamInfo } from '../../shared/types.js'
import {
  DEFAULT_BUFFER_WINDOW,
  archivePollMs,
  bufferCovers,
  bufferedSeconds,
  liveEdgeEpoch,
  measuredLatency,
  nextLiveState,
  pruneBuffer,
  recordingPollMs,
  retryDelayMs
} from '../../shared/live.js'
import type { BufferedSegment } from '../../shared/live.js'
import type { Logger } from '../services/logger.js'
import { fetchBuffer, fetchText } from './http.js'
import { isMasterPlaylist, parseMaster, parseMedia, sortVariants } from './hls.js'
import type { HlsMediaPlaylist } from './hls.js'


/**
 * One live source's rolling buffer.
 *
 * It holds the most recent `windowSeconds` of media in memory and **writes
 * nothing else to disk** — a live source that persisted everything it saw
 * would be a recording with extra steps, and an eight-hour stream would fill
 * the drive. Segments deliberately do not go through the segment cache for the
 * same reason: nothing here is worth keeping once it has aged out.
 *
 * All the rules live in `shared/live.ts`; this class supplies the sockets and
 * the timers and decides nothing. Both timers exist only while a source is
 * actually live — a stopped buffer holds no interval, so an idle app is idle.
 */

/** Held media plus its bytes. `BufferedSegment` is the part the rules see. */
interface HeldSegment extends BufferedSegment {
  data: Buffer
  uri: string
}

export interface LiveBufferOptions {
  windowSeconds?: number
  /** Injected in tests. Defaults to the real clock. */
  now?: () => number
  /**
   * Ask whether this broadcast's archive has been published yet, returning
   * its VOD id or null for "not yet".
   *
   * A socket, like the fetches: the buffer owns the schedule (`archivePollMs`
   * decides the cadence) and knows nothing about how an archive is found —
   * which differs per platform and belongs with the services that already do
   * it. Left unset, a finished broadcast simply stays `awaiting-vod`, which
   * is what it did before anything was looking.
   */
  findArchive?: () => Promise<string | null>
}

/**
 * Live traffic gets its own slots, separate from exports.
 *
 * Both used to share the app-wide segment limiter, which is deliberately
 * widened as export concurrency rises — so four exports downloading at
 * eight-way parallelism could take every slot, and a live POV's next
 * two-second segment queued behind multi-megabyte archive segments until the
 * buffer fell off the live edge and started reporting a lost connection.
 *
 * Live demand is bounded by the number of POVs rather than by a setting: one
 * segment every couple of seconds each, so a small fixed pool is both enough
 * for twenty angles and small enough that it cannot starve an export.
 */
const liveSegmentLimiter = new ConcurrencyLimiter(12)

export class LiveBuffer {
  private segments: HeldSegment[] = []
  private held: LiveState
  private pollTimer: NodeJS.Timeout | null = null
  private stream: StreamInfo | null = null
  private mediaPlaylistUrl: string | null = null
  private lastSequence = -1
  private archiveAttempts = 0
  private recordingAttempts = 0
  private recordingCheckAt = 0
  private running = false
  private readonly listeners = new Set<(state: LiveState) => void>()
  private readonly now: () => number
  private readonly findArchive: (() => Promise<string | null>) | null

  constructor(
    private readonly log: Logger,
    readonly sourceId: string,
    options: LiveBufferOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now() / 1000)
    this.findArchive = options.findArchive ?? null
    this.held = {
      state: 'live',
      latencySeconds: 0,
      bufferedSeconds: 0,
      windowSeconds: options.windowSeconds ?? DEFAULT_BUFFER_WINDOW,
      retries: 0
    }
  }

  get state(): LiveState {
    return this.held
  }

  /** Read-only view for the rules and for tests. */
  get buffered(): readonly BufferedSegment[] {
    return this.segments
  }

  onChange(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Change the window while live.
   *
   * Shrinking takes effect at the next prune rather than immediately, which
   * keeps eviction in one place; growing simply lets the buffer fill.
   */
  setWindow(seconds: number): void {
    this.held = { ...this.held, windowSeconds: seconds }
    // Shrinking the window is the one moment media has to be dropped that
    // arriving media does not already cover — `prune` emits for itself.
    this.prune()
  }

  async start(stream: StreamInfo): Promise<void> {
    if (this.running) return
    this.running = true
    this.stream = stream
    /*
     * No prune timer.
     *
     * `ingest` prunes after every appended segment, which is the only moment
     * the buffer can outgrow its window — so a once-a-second timer was
     * copying and re-sorting an array of a hundred-odd segments per source
     * per second and evicting nothing. With twenty live POVs that is twenty
     * pointless sorts a second, forever. The one case ingest does not cover
     * is the window being made smaller, and `setWindow` prunes for itself.
     */
    await this.poll()
  }

  /**
   * Stop polling and release the media.
   *
   * Called when a source is closed or the app quits — not on a disconnect,
   * where the buffer is the most valuable media in the app.
   */
  stop(): void {
    this.running = false
    if (this.pollTimer) clearTimeout(this.pollTimer)

    this.pollTimer = null
    this.segments = []
    this.listeners.clear()
  }

  // ------------------------------------------------------------- polling --

  private schedule(delayMs: number): void {
    if (!this.running) return
    this.pollTimer = setTimeout(() => void this.poll(), delayMs)
    this.pollTimer.unref?.()
  }

  /**
   * Find the platform's in-progress recording, once, on a slow clock.
   *
   * Deliberately fire-and-forget from the poll loop: a channel listing that is
   * slow or rate-limited must never delay the next playlist refresh, because
   * that is the part that cannot be caught up on later.
   */
  private async lookForRecording(): Promise<void> {
    if (!this.findArchive) return
    if (this.held.recordingVodId || this.held.archivedVodId) return

    const nowMs = this.now() * 1000
    if (nowMs < this.recordingCheckAt) return
    this.recordingAttempts += 1
    this.recordingCheckAt = nowMs + recordingPollMs(this.recordingAttempts)

    try {
      const vodId = await this.findArchive()
      if (!vodId) return
      this.log.info('live', 'Found the recording of a broadcast in progress', {
        source: this.sourceId,
        vodId
      })
      this.transition({ kind: 'recording-found', vodId })
    } catch (err) {
      // Same as not finding it: ask again on the next tick that is due.
      this.log.debug('live', 'Recording lookup failed', err)
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || !this.stream) return

    // The archive is the last thing this buffer waits for. Once it is known
    // there is nothing left to ask anyone, and the timer stops for good.
    if (this.held.archivedVodId) return

    // Nothing to poll for once the broadcast is over: what the source is
    // waiting on then is its archive, on a much slower clock.
    if (this.held.state === 'awaiting-vod') {
      this.archiveAttempts += 1
      try {
        const vodId = await this.findArchive?.()
        if (vodId) {
          this.log.info('live', 'Archive published for a finished broadcast', {
            source: this.sourceId,
            vodId
          })
          // No re-schedule: this is the terminal state.
          this.transition({ kind: 'archive-resolved', vodId })
          return
        }
      } catch (err) {
        // Not finding it yet and failing to look are the same thing from
        // here: ask again later.
        this.log.debug('live', 'Archive lookup failed', err)
      }
      this.schedule(archivePollMs(this.archiveAttempts))
      return
    }

    let playlist: HlsMediaPlaylist
    try {
      playlist = await this.fetchMediaPlaylist(this.stream)
    } catch (err) {
      // A failed refresh is a lost connection, never a lost buffer.
      this.log.debug('live', 'Live playlist refresh failed', err)
      this.transition({ kind: 'connection-lost' })
      this.schedule(retryDelayMs(this.held.retries ?? 1))
      return
    }

    await this.ingest(playlist)

    if (playlist.endList) {
      // The broadcaster finished. Clips already marked against this source
      // keep their event range and are held for the archive.
      this.transition({ kind: 'stream-ended' })
      this.archiveAttempts = 0
      this.schedule(archivePollMs(1))
      return
    }

    const edge = liveEdgeEpoch(this.segments)
    this.transition({
      kind: 'playlist-ok',
      latencySeconds: edge === null ? 0 : measuredLatency(edge, this.now()),
      bufferedSeconds: bufferedSeconds(this.segments)
    })

    // Look for the platform's own recording of the broadcast in progress. On
    // its own clock rather than the playlist's: the playlist refreshes every
    // second or so and this must not ask a channel listing that often.
    void this.lookForRecording()

    // Half the target duration is the usual refresh cadence: often enough not
    // to miss a segment, rarely enough not to hammer the origin.
    this.schedule(Math.max(500, (playlist.targetDuration || 2) * 500))
  }

  private async fetchMediaPlaylist(stream: StreamInfo): Promise<HlsMediaPlaylist> {
    // The media playlist URL is resolved once. A live master playlist does not
    // change its variants mid-broadcast, and re-resolving every poll would
    // double the requests for nothing.
    let url = this.mediaPlaylistUrl
    if (!url) {
      const text = await fetchText(stream.url, { headers: stream.httpHeaders })
      if (isMasterPlaylist(text)) {
        const master = parseMaster(text, stream.url)
        const best = sortVariants(master.variants)[0]
        if (!best) throw new Error('live master playlist listed no variants')
        url = best.uri
      } else {
        url = stream.url
      }
      this.mediaPlaylistUrl = url
    }

    const media = await fetchText(url, { headers: stream.httpHeaders })
    return parseMedia(media, url)
  }

  /** Append whatever this refresh added, identified by sequence number. */
  private async ingest(playlist: HlsMediaPlaylist): Promise<void> {
    const fresh = playlist.segments.filter((s) => s.sequence > this.lastSequence)
    if (fresh.length === 0) return

    for (const segment of fresh) {
      if (!this.running) return
      let data: Buffer
      try {
        data = await liveSegmentLimiter.run(() =>
          fetchBuffer(segment.uri, { headers: this.stream?.httpHeaders })
        )
      } catch (err) {
        // One segment failing is not a disconnect. Skip it and keep the
        // sequence moving, or the buffer stalls on a single bad request.
        this.log.debug('live', 'Live segment failed', err)
        this.lastSequence = Math.max(this.lastSequence, segment.sequence)
        continue
      }

      this.segments.push({
        sequence: segment.sequence,
        // A live playlist without PROGRAM-DATE-TIME gives no wall clock to
        // anchor to. Falling back to "now minus what is held" keeps the buffer
        // usable; §4.3's sync pass is what makes it accurate.
        startEpoch: segment.programDateTime ?? this.now() - bufferedSeconds(this.segments),
        durationSeconds: segment.durationSeconds,
        bytes: data.length,
        data,
        uri: segment.uri
      })
      this.lastSequence = Math.max(this.lastSequence, segment.sequence)
      // After every append, not after the batch. A refresh that brings six
      // segments at once would otherwise hold six segments past the window
      // until the loop ended — briefly, but the invariant is "never exceeds",
      // and a caller reading mid-ingest sees whatever is actually held.
      this.prune()
    }
  }

  /**
   * Evict on a timer, not on demand.
   *
   * A buffer that only evicts when someone asks for media is not bounded, so
   * this runs whether or not anything is reading — which is exactly why the
   * timer is stopped when the source is.
   */
  private prune(): void {
    const before = this.segments.length
    this.segments = pruneBuffer(
      this.segments,
      this.held.windowSeconds
    ) as HeldSegment[]

    const held = bufferedSeconds(this.segments)
    // The invariant the whole feature rests on. A buffer that has quietly
    // outgrown its window is one that is quietly filling memory.
    if (held > this.held.windowSeconds + this.longestSegment()) {
      this.log.warn('live', 'Live buffer exceeded its window', {
        sourceId: this.sourceId,
        heldSeconds: held,
        windowSeconds: this.held.windowSeconds
      })
    }

    if (this.segments.length !== before || held !== this.held.bufferedSeconds) {
      this.held = { ...this.held, bufferedSeconds: held }
      this.emit()
    }
  }

  /** The window can only be honoured to within one segment's granularity. */
  private longestSegment(): number {
    let longest = 0
    for (const s of this.segments) longest = Math.max(longest, s.durationSeconds)
    return longest
  }

  // -------------------------------------------------------------- events --

  /** Called when the platform publishes the archive of a finished broadcast. */
  archiveResolved(vodId: string): void {
    this.transition({ kind: 'archive-resolved', vodId })
  }

  private transition(event: Parameters<typeof nextLiveState>[1]): void {
    const next = nextLiveState(this.held, event)
    if (next === this.held) return
    this.held = next
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.held)
      } catch (err) {
        this.log.warn('live', 'A live-state listener threw', err)
      }
    }
  }

  // --------------------------------------------------------------- reads --

  /** Whether a range can be served from what is held, or needs an origin fetch. */
  covers(startEpoch: number, endEpoch: number): boolean {
    return bufferCovers(this.segments, startEpoch, endEpoch)
  }

  /**
   * Write the held media covering an event range to a file.
   *
   * Returns null when the range is not wholly held — the caller then fetches
   * it from the origin, and the UI is required to have said which of the two
   * was going to happen before the user asked.
   */
  async writeRange(
    startEpoch: number,
    endEpoch: number,
    destination: string
  ): Promise<{ file: string; windowStartEpoch: number; windowEndEpoch: number } | null> {
    if (!this.covers(startEpoch, endEpoch)) return null

    // Whole segments, so the file starts on a segment boundary rather than
    // mid-GOP. The caller cuts to the exact range afterwards, the same way a
    // VOD window is cut.
    const covering = this.segments.filter(
      (s) => s.startEpoch + s.durationSeconds > startEpoch && s.startEpoch < endEpoch
    )
    if (covering.length === 0) return null

    await writeFile(destination, Buffer.concat(covering.map((s) => s.data)))
    const last = covering[covering.length - 1]
    return {
      file: destination,
      windowStartEpoch: covering[0].startEpoch,
      windowEndEpoch: last.startEpoch + last.durationSeconds
    }
  }
}
