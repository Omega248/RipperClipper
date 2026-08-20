/**
 * Player abstraction.
 *
 * The editor talks to `playerBus` and never to a concrete player, so every
 * platform is driven through the same controls.
 */
export interface PlayerController {
  play(): void
  pause(): void
  seek(seconds: number): void
  getCurrentTime(): number
  getDuration(): number
  setVolume(value: number): void
  setMuted(value: boolean): void
  setRate(value: number): void
  requestFullscreen(): void
  /** Seeking granularity the player can actually deliver, in seconds. */
  readonly seekPrecisionSeconds: number
}

class PlayerBus {
  private controller: PlayerController | null = null

  attach(controller: PlayerController | null): void {
    this.controller = controller
  }

  /**
   * Unplug a specific player. React can run the departing POV's cleanup *after*
   * the arriving POV has attached, and an unconditional `attach(null)` there
   * leaves the bus empty: the new video is on screen but play, seek and the
   * keyboard all do nothing. Only the player that is still connected may
   * disconnect itself.
   */
  detach(controller: PlayerController): void {
    if (this.controller === controller) this.controller = null
  }

  get available(): boolean {
    return this.controller !== null
  }

  get precision(): number {
    return this.controller?.seekPrecisionSeconds ?? 0.001
  }

  play(): void {
    this.controller?.play()
  }
  pause(): void {
    this.controller?.pause()
  }
  seek(seconds: number): void {
    this.controller?.seek(Math.max(0, seconds))
  }
  currentTime(): number {
    return this.controller?.getCurrentTime() ?? 0
  }
  duration(): number {
    return this.controller?.getDuration() ?? 0
  }
  setVolume(value: number): void {
    this.controller?.setVolume(value)
  }
  setMuted(value: boolean): void {
    this.controller?.setMuted(value)
  }
  setRate(value: number): void {
    this.controller?.setRate(value)
  }
  fullscreen(): void {
    this.controller?.requestFullscreen()
  }
}

export const playerBus = new PlayerBus()
