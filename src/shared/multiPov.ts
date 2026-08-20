import { eventToLocal, isSynced, localToEvent } from './sync.js'
import type { VodSource } from './types.js'

/**
 * The maths behind Show All: one canonical moment, every POV's own time.
 *
 * Kept out of the component because it is the part that has to be right — a
 * POV placed a second late is worse than one not shown at all.
 */

export type GridLayout = 'auto' | 1 | 2 | 4 | 6 | 8

export function columnsFor(layout: GridLayout, count: number): number {
  if (count <= 0) return 1
  const wanted =
    layout !== 'auto'
      ? layout <= 2
        ? layout
        : Math.ceil(Math.sqrt(layout))
      : count <= 1
        ? 1
        : count <= 2
          ? 2
          : count <= 6
            ? 3
            : count <= 9
              ? 3
              : 4
  // An explicit layout picks a track count for its target tile count (e.g.
  // "8 across" means "up to 8, roughly square"), not a fixed number of
  // columns to render regardless of how many POVs are actually loaded — that
  // left empty grid tracks next to an undersized tile whenever fewer POVs
  // were loaded than the chosen layout supports.
  return Math.min(wanted, count)
}

/** Local time in each POV for one real-world moment. Null = not recording. */
export function followerTargets(
  sources: VodSource[],
  leader: VodSource | undefined,
  leaderLocalTime: number
): Map<string, number | null> {
  const out = new Map<string, number | null>()
  const leaderMapping = leader?.syncMapping
  const eventTime =
    leaderMapping && isSynced(leaderMapping) ? localToEvent(leaderMapping, leaderLocalTime) : null

  for (const source of sources) {
    if (leader && source.id === leader.id) {
      out.set(source.id, leaderLocalTime)
      continue
    }
    const mapping = source.syncMapping
    if (eventTime === null || !mapping || !isSynced(mapping)) {
      out.set(source.id, null)
      continue
    }
    const local = eventToLocal(mapping, eventTime)
    out.set(
      source.id,
      local === null || local < 0 || local > source.durationSeconds ? null : local
    )
  }
  return out
}

