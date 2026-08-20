/**
 * Caps how many of one kind of expensive background work (an ffmpeg decode,
 * say) run at once. Nothing here is worth serializing to one-at-a-time — the
 * point is only to stop a burst of requests (every item on a timeline
 * mounting together) from spawning a process per item and fighting the rest
 * of the machine for CPU.
 */
export class ConcurrencyLimiter {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}
