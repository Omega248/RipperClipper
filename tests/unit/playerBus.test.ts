import { describe, expect, it } from 'vitest'
import { playerBus } from '../../src/renderer/src/player/controller.js'
import type { PlayerController } from '../../src/renderer/src/player/controller.js'

function stub(name: string, played: string[]): PlayerController {
  return {
    play: () => played.push(name),
    pause: () => undefined,
    seek: () => undefined,
    getCurrentTime: () => 0,
    getDuration: () => 0,
    setVolume: () => undefined,
    setMuted: () => undefined,
    setRate: () => undefined,
    requestFullscreen: () => undefined,
    seekPrecisionSeconds: 0.001
  }
}

/**
 * Swapping POV mounts the new player and unmounts the old one, and React does
 * not promise which cleanup runs first. If the departing player is allowed to
 * clear the bus unconditionally, the arriving one is left disconnected — the
 * video is visible but Play does nothing. That was the reported bug.
 */
describe('player bus hand-over', () => {
  it('keeps the new player connected when the old one detaches afterwards', () => {
    const played: string[] = []
    const first = stub('A', played)
    const second = stub('B', played)

    playerBus.attach(first)
    playerBus.attach(second) // POV switch: the new player attaches...
    playerBus.detach(first) // ...and the old one's cleanup lands late.

    expect(playerBus.available).toBe(true)
    playerBus.play()
    expect(played).toEqual(['B'])
  })

  it('still disconnects when the attached player is the one leaving', () => {
    const played: string[] = []
    const only = stub('A', played)
    playerBus.attach(only)
    playerBus.detach(only)

    expect(playerBus.available).toBe(false)
    playerBus.play()
    expect(played).toEqual([])
  })
})
