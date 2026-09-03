/**
 * Caps how many of one kind of expensive background work (an ffmpeg decode,
 * say) run at once. Nothing here is worth serializing to one-at-a-time — the
 * point is only to stop a burst of requests (every item on a timeline
 * mounting together) from spawning a process per item and fighting the rest
 * of the machine for CPU.
 */
export class ConcurrencyLimiter {
  private active = 0
  private max: number
  private readonly queue: Array<() => void> = []

  constructor(max: number) {
    this.max = Math.max(1, Math.round(max))
  }

  /**
   * Raise or lower the cap while work is already running — the segment
   * limiter is sized from a setting the user can change mid-batch.
   *
   * Waking every waiter is deliberate rather than counting out exactly the
   * new headroom: `run` re-checks the cap in a loop, so a waiter that finds
   * no room simply goes back on the queue. Over-releasing is harmless;
   * under-releasing would strand work.
   */
  setMax(value: number): void {
    this.max = Math.max(1, Math.round(value))
    for (const wake of this.queue.splice(0)) wake()
  }

  get limit(): number {
    return this.max
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // `while`, not `if`: the cap can shrink, and setMax wakes every waiter
    // regardless of how much room actually opened up.
    while (this.active >= this.max) {
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
