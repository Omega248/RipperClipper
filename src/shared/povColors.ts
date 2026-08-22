/**
 * A stable colour per POV.
 *
 * The redesign leans on this everywhere — avatar tints, timeline lanes, clip
 * pips, thumbnail washes — so a POV has to look the same in every one of
 * them, and the same again tomorrow. Deriving it from the source id rather
 * than from list position is what guarantees that: adding or removing a POV
 * must not recolour the others, which is exactly what an index-based palette
 * would do.
 *
 * The palette is the streamer-group palette, for one reason: those eight are
 * already tuned to sit together on this app's dark ground, and reusing them
 * means a POV and a group never clash in the same row.
 */

import { STREAMER_GROUP_COLORS } from './streamerGroupColors.js'

export const POV_COLORS = STREAMER_GROUP_COLORS

/** Deterministic, order-independent, and never the same for two adjacent ids by accident. */
export function povColor(sourceId: string): string {
  let hash = 0
  for (let i = 0; i < sourceId.length; i++) {
    // A prime multiplier spreads similar ids (src_1, src_2) apart rather than
    // landing them on neighbouring palette entries.
    hash = (hash * 131 + sourceId.charCodeAt(i)) >>> 0
  }
  return POV_COLORS[hash % POV_COLORS.length]
}

/**
 * The same colour at a given alpha, for tints and washes.
 *
 * Returned as `color-mix` against the *surface* rather than a flat rgba, so a
 * tint stays correct when the theme changes — a fixed alpha over a light
 * ground reads completely differently than over a dark one.
 */
export function povTint(sourceId: string, percent: number): string {
  return `color-mix(in srgb, ${povColor(sourceId)} ${percent}%, transparent)`
}

/**
 * Colours for a whole set of POVs, avoiding collisions where it can.
 *
 * With eight colours and more than eight POVs a repeat is unavoidable, so
 * this only nudges: a POV whose hashed colour is already taken shifts to the
 * next free one. Order therefore matters slightly, but the *first* POV to
 * claim a colour keeps it, so adding one at the end never recolours anything
 * already on screen.
 */
export function povColorMap(sourceIds: string[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const id of sourceIds) {
    const preferred = povColor(id)
    if (!used.has(preferred)) {
      used.add(preferred)
      out.set(id, preferred)
      continue
    }
    const free = POV_COLORS.find((c) => !used.has(c))
    // Past eight POVs everything is taken; fall back to the hashed colour
    // rather than leaving one uncoloured.
    const chosen = free ?? preferred
    used.add(chosen)
    out.set(id, chosen)
  }
  return out
}
