/**
 * Going to a thing, rather than setting the two bits of state that add up to
 * being there.
 *
 * Opening a clip is "select it, then be on a page that shows it" — two calls
 * that have to happen together and in that order. Spread across the Backlog,
 * the review run and the clip grid, that pairing is the kind of thing that
 * drifts: one caller forgets the route, another selects after navigating and
 * lands on an empty inspector. One function, so there is one answer.
 */

import { useStore } from './store.js'

/**
 * Show this clip.
 *
 * Deliberately does not touch the transport or the picked angle: the review
 * run advances through moments while the player stays mounted, and rebuilding
 * it between clips is what would make the keyboard loop slower than clicking.
 */
export function openClip(clipId: string): void {
  const state = useStore.getState()
  state.selectClip(clipId)
  state.setRoute('workspace')
}
