import type { LiveState, StreamInfo, VodSource } from '../../shared/types.js'
import { DEFAULT_BUFFER_WINDOW, degradeWindow } from '../../shared/live.js'
import type { BufferWindow } from '../../shared/live.js'
import { LiveBuffer } from '../media/liveBuffer.js'
import type { Logger } from './logger.js'

/**
 * Every live source the app is currently holding media for.
 *
 * One buffer per source, shared by every consumer — the player, a pending
 * clip and a prefetch that all want the same live segment are one fetch,
 * because there is only one thing fetching. The registry also owns the
 * cross-source decision the individual buffers cannot make: how much of the
 * live memory budget each of them may take.
 *
 * Nothing here polls on its own. A registry with no live sources holds no
 * timers at all.
 */

/** Bytes per second of held media, per POV, used to size the memory budget. */
const ESTIMATED_BITRATE_BYTES = 6_400_000 / 8

export class LiveService {
  private readonly buffers = new Map<string, LiveBuffer>()
  /** The source each buffer belongs to, for callers that need more than its id. */
  private readonly watched = new Map<string, VodSource>()
  private windowSeconds: BufferWindow = DEFAULT_BUFFER_WINDOW
  private notice: string | null = null

  constructor(
    private readonly log: Logger,
    /** Called whenever any source's state changes. Debouncing is the caller's. */
    private readonly onChange: (sourceId: string, state: LiveState) => void,
    /**
     * How to find the archive a finished broadcast became. Per-source,
     * because the answer depends on the channel and the platform; supplied
     * by the caller, because finding it is not this registry's business.
     */
    private readonly findArchive?: (source: VodSource) => Promise<string | null>
  ) {}

  /** How many sources are live right now. */
  get count(): number {
    return this.buffers.size
  }

  /**
   * The window actually in force, and why it is not the one asked for.
   *
   * Stated rather than silent: a user who chose five minutes and is being
   * given ninety seconds needs to know, or the buffer strip is lying about
   * what can be clipped.
   */
  get windowNotice(): string | null {
    return this.notice
  }

  states(): Record<string, LiveState> {
    const out: Record<string, LiveState> = {}
    for (const [id, buffer] of this.buffers) out[id] = buffer.state
    return out
  }

  stateOf(sourceId: string): LiveState | null {
    return this.buffers.get(sourceId)?.state ?? null
  }

  /** The source behind a buffer — its handle and platform, for lookups. */
  sourceFor(sourceId: string): VodSource | null {
    return this.watched.get(sourceId) ?? null
  }

  /**
   * Begin holding media for a live source.
   *
   * Idempotent: watching a source twice is one buffer, which is the whole
   * point of the registry.
   */
  async watch(source: VodSource, stream: StreamInfo): Promise<LiveState> {
    const existing = this.buffers.get(source.id)
    if (existing) return existing.state

    const buffer = new LiveBuffer(this.log, source.id, {
      windowSeconds: this.windowSeconds,
      ...(this.findArchive ? { findArchive: () => this.findArchive!(source) } : {})
    })
    this.buffers.set(source.id, buffer)
    this.watched.set(source.id, source)
    buffer.onChange((state) => this.onChange(source.id, state))

    // Adding a POV changes what every other one can afford, so the budget is
    // re-shared before the new buffer starts filling rather than after.
    this.rebalance()

    try {
      await buffer.start(stream)
    } catch (err) {
      this.log.warn('live', 'Could not start a live source', err)
      this.unwatch(source.id)
      throw err
    }
    return buffer.state
  }

  /** Stop holding media for a source, and free it. */
  unwatch(sourceId: string): void {
    const buffer = this.buffers.get(sourceId)
    if (!buffer) return
    buffer.stop()
    this.buffers.delete(sourceId)
    this.watched.delete(sourceId)
    this.rebalance()
  }

  /** Everything, on quit. */
  stopAll(): void {
    for (const id of [...this.buffers.keys()]) this.unwatch(id)
  }

  /** The user changed the buffer window in Settings → Playback & live. */
  setWindow(seconds: BufferWindow): void {
    this.windowSeconds = seconds
    this.rebalance()
  }

  /** Tell a finished source that its archive has been published. */
  archiveResolved(sourceId: string, vodId: string): void {
    this.buffers.get(sourceId)?.archiveResolved(vodId)
  }

  /** Whether a range can be served from held media rather than the origin. */
  covers(sourceId: string, startEpoch: number, endEpoch: number): boolean {
    return this.buffers.get(sourceId)?.covers(startEpoch, endEpoch) ?? false
  }

  /** Held media for a range, or null when it has to come from the origin. */
  writeRange(
    sourceId: string,
    startEpoch: number,
    endEpoch: number,
    destination: string
  ): Promise<{ file: string; windowStartEpoch: number; windowEndEpoch: number } | null> {
    const buffer = this.buffers.get(sourceId)
    return buffer ? buffer.writeRange(startEpoch, endEpoch, destination) : Promise.resolve(null)
  }

  /**
   * Share the live memory budget across however many sources are live.
   *
   * Six live POVs at five minutes is roughly 11 GB of held media — not a
   * configuration to accept silently. Every buffer gets the same window, so
   * one POV is never quietly worth less than another.
   */
  private rebalance(): void {
    const { windowSeconds, reason } = degradeWindow(
      this.windowSeconds,
      this.buffers.size,
      ESTIMATED_BITRATE_BYTES
    )
    this.notice = reason
    for (const buffer of this.buffers.values()) buffer.setWindow(windowSeconds)
  }
}
