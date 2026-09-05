import { eventToLocal, isSynced, localToEvent } from './sync.js'
import type { VodSource } from './types.js'

/**
 * The maths behind Show All: one canonical moment, every POV's own time.
 *
 * Kept out of the component because it is the part that has to be right — a
 * POV placed a second late is worse than one not shown at all.
 */

export type GridLayout = 'auto' | 1 | 2 | 4 | 6 | 8

/**
 * The column count that makes the tiles as large as possible.
 *
 * Every tile shows a 16:9 picture inside a box the grid stretches to fill, so
 * any mismatch between the box and 16:9 is letterboxing — black bars on a wall
 * whose entire job is letting you see what you are cutting. Measured on a
 * two-angle wall: the picture was using 39% of the stage.
 *
 * Which arrangement wins depends on the *stage's* shape, not just the number
 * of angles. Two angles side by side on a wide stage waste half the height;
 * stacked on a tall one they waste half the width. So every column count is
 * tried and the one giving the biggest tile wins — it is at most a dozen
 * candidates and it runs when the layout changes, not per frame.
 *
 * `stageAspect` is width / height of the space available.
 */
export function bestColumns(count: number, stageAspect: number): number {
  if (count <= 1) return 1
  if (!Number.isFinite(stageAspect) || stageAspect <= 0) return Math.ceil(Math.sqrt(count))

  let best = 1
  let bestTile = 0
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    /*
     * How wide the 16:9 picture ends up, as a fraction of the stage width.
     *
     * The box is `1/columns` wide and `1/rows` of the stage height tall.
     * Whichever of those binds decides the picture: expressed in stage widths,
     * the row height allows `16 / (9 * rows * aspect)`. Height is inverted by
     * the aspect ratio because it is being converted into width units, which
     * is easy to get backwards — doing so picks a stacked layout on a wide
     * screen, which is exactly the letterboxing this exists to remove.
     */
    const tile = Math.min(1 / columns, 16 / (9 * rows * stageAspect))
    /*
     * Ties go to the wider arrangement.
     *
     * They are common — on a 16:9 stage, two angles are exactly the same size
     * side by side as stacked — and side by side is what people mean by a
     * wall. Stacking them leaves a tall empty margin either side and reads as
     * a mistake even though the picture is the same number of pixels.
     */
    if (tile >= bestTile - 1e-9) {
      bestTile = tile
      best = columns
    }
  }
  return best
}

export function columnsFor(layout: GridLayout, count: number, stageAspect?: number): number {
  if (count <= 0) return 1
  const wanted =
    layout !== 'auto'
      ? layout <= 2
        ? layout
        : Math.ceil(Math.sqrt(layout))
      : // Automatic means "make them as big as they can be", which depends on
        // the shape of the space as well as the number of angles. Without a
        // measured stage it falls back to roughly square.
        bestColumns(count, stageAspect ?? 16 / 9)
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
    const local =
      eventTime === null || !mapping || !isSynced(mapping)
        ? null
        : eventToLocal(mapping, eventTime)

    /*
     * A live angle always has something to show: its own live edge.
     *
     * Every way of asking "where is this POV right now" can fail for a
     * broadcast in progress, and all of them used to end in a tile reading
     * "Not recording at this moment" while the angle was, in fact, recording:
     *
     *  - no sync mapping at all, because a POV loaded from a channel link has
     *    not been aligned against anything yet;
     *  - a negative time, because the two POVs started being watched minutes
     *    apart and every live clock here is relative to when watching began;
     *  - a time past `durationSeconds`, which for a live source is a floor
     *    that moves rather than a length — whatever the platform had published
     *    when the source resolved.
     *
     * None of those mean the broadcaster stopped. So a live angle falls back
     * to its live edge, which is also the honest answer: two angles both at
     * their live edge are both showing the same real moment, which is the
     * whole point of a wall of live POVs. `FollowerVideo` clamps whatever it
     * is given to what the playlist actually holds, so asking for the edge is
     * enough to land on it.
     *
     * `stillRecording` matters as much as `isLive` here, and missing it is a
     * bug this app has already shipped. A live channel is now opened as the
     * VOD the platform is already writing, which makes `isLive` false — so
     * every follower fell through to the finished-recording branch below,
     * where a target past its (already stale) length is `null`, and a null
     * target is a tile that says "Not recording at this moment". The leader is
     * returned above without any of these checks, so the wall showed a live
     * picture for exactly one angle: whichever one was in focus.
     */
    if (stillOnAir(source)) {
      const usable = local !== null && local >= 0
      out.set(source.id, usable ? local : source.durationSeconds)
      continue
    }

    // A finished recording is bounded by its real length, and "not recording"
    // there is a fact worth stating.
    out.set(
      source.id,
      local === null || local < 0 || local > source.durationSeconds ? null : local
    )
  }

  return out
}

/**
 * How many angles may decode at once.
 *
 * A ceiling for the machine, not a choice about content — which angles you
 * want on screen is `wallSelection`'s job, and the two are deliberately
 * separate: unticking an angle should never be the way you protect the CPU,
 * and a CPU limit should never silently decide which angles you see.
 *
 * `cap` is the user's setting. 0 or absent means no ceiling; the default is 8,
 * which is roughly what fits on one screen before the tiles stop being worth
 * looking at.
 */
export function livePovBudget(count: number, cap: number | null | undefined): number {
  if (count <= 0) return 0
  // Anything under one angle is not a ceiling anyone meant — 0 is the "no
  // limit" value the setting stores, and a fraction cannot be a tile count.
  if (cap === null || cap === undefined || cap < 1) return count
  return Math.min(count, Math.floor(cap))
}

export interface WallSelection {
  /** Tiles to render, in source order. An unticked angle gets no tile at all. */
  shown: VodSource[]
  /** Of those, the ones that may actually decode. The rest are over the ceiling. */
  decoding: Set<string>
  /** Angles the user has unticked. Counted so the UI can offer them back. */
  hiddenCount: number
}

/**
 * Which angles the wall shows, and which of those may decode.
 *
 * Two ceilings that would otherwise fight each other, resolved in one place:
 *
 *  - **The tick list** is the person's answer to "which of these fourteen
 *    angles do I want to watch". An unticked angle is not drawn at all — a
 *    tile saying "you turned this one off" is the same wasted screen the
 *    ticking was meant to reclaim.
 *  - **The cap** is the machine's answer to "how many can I decode". It never
 *    removes a tile, it just stops it decoding, so the person can see that
 *    they asked for more than the ceiling allows and do something about it.
 *
 * The focused angle is exempt from both. It owns the playhead and the sound,
 * so hiding it would leave the wall with no clock — and it is the one tile
 * that is always worth a slot.
 */
export function wallSelection(
  sources: VodSource[],
  leaderId: string | undefined,
  cap: number | null | undefined
): WallSelection {
  const shown = sources.filter((source) => source.id === leaderId || source.hiddenInWall !== true)
  const budget = livePovBudget(shown.length, cap)

  const decoding = new Set<string>()
  if (leaderId && shown.some((source) => source.id === leaderId)) decoding.add(leaderId)
  for (const source of shown) {
    if (decoding.size >= budget) break
    // Ordered by the source list rather than by coverage: which tiles are live
    // has to stay put as the playhead moves, or angles would flicker in and
    // out of life every time one of them ran out of footage.
    decoding.add(source.id)
  }

  return { shown, decoding, hiddenCount: sources.length - shown.length }
}

/**
 * The angles to hide so that exactly a screenful is left.
 *
 * The picker's "First N" shortcut. Getting to a legal wall by hand is one
 * click per angle over the ceiling, which on fourteen angles is six clicks to
 * reach the state the app could have offered.
 *
 * The focused angle is kept wherever it sits in the list and *counts against*
 * the ceiling — keeping it as a bonus would leave N+1 tiles and one of them
 * unable to decode, which is the state the shortcut exists to avoid.
 */
export function firstScreenful(
  sources: VodSource[],
  leaderId: string | undefined,
  cap: number
): string[] {
  const keep = new Set<string>()
  if (leaderId && sources.some((s) => s.id === leaderId)) keep.add(leaderId)
  for (const source of sources) {
    if (keep.size >= cap) break
    keep.add(source.id)
  }
  return sources.filter((s) => !keep.has(s.id)).map((s) => s.id)
}

/**
 * Still broadcasting, whichever way the app got there.
 *
 * `isLive` is a source whose media is the live edge. `stillRecording` is one
 * opened as the VOD the platform is writing while the broadcast runs — an
 * ordinary recording that happens to be growing. For every question of the form
 * "is this angle's end a wall or a floor" they are the same answer, and treating
 * them differently is what left a wall of live POVs showing a picture for the
 * focused angle only.
 */
export function stillOnAir(source: Pick<VodSource, 'isLive' | 'stillRecording'>): boolean {
  return source.isLive === true || source.stillRecording === true
}

/** Where one POV's recording sits on the focused POV's ruler. */
export interface PovCoverageSpan {
  sourceId: string
  /**
   * The POV's own recording, expressed in the *leader's* local time — null
   * when the two cannot be related at all (either is unsynced), which is a
   * fact worth drawing rather than a reason to leave the row blank.
   */
  startSeconds: number | null
  endSeconds: number | null
  /** This is the POV the ruler belongs to. */
  isLeader: boolean
  /** Still broadcasting: its end is a floor that keeps moving, not a wall. */
  isLive: boolean
}

/**
 * Every angle's recording laid out on one ruler.
 *
 * This is what turns a six-hour timeline from a grey bar into something you
 * can read: which angles were rolling at any given moment, and where one
 * joined or dropped, without seeking to find out. The arithmetic is the same
 * `followerTargets` uses — each POV's own [0, duration] taken through event
 * time and back into the leader's clock — done once for the whole recording
 * instead of once per playhead tick.
 */
export function povCoverage(sources: VodSource[], leader: VodSource | undefined): PovCoverageSpan[] {
  if (!leader) return []
  const leaderMapping = leader.syncMapping
  return sources.map((source) => {
    if (source.id === leader.id) {
      return {
        sourceId: source.id,
        startSeconds: 0,
        endSeconds: leader.durationSeconds,
        isLeader: true,
        isLive: stillOnAir(source)
      }
    }
    const mapping = source.syncMapping
    const unplaceable = {
      sourceId: source.id,
      startSeconds: null,
      endSeconds: null,
      isLeader: false,
      isLive: stillOnAir(source)
    }
    if (!leaderMapping || !mapping || !isSynced(leaderMapping) || !isSynced(mapping)) return unplaceable

    const eventStart = localToEvent(mapping, 0)
    const eventEnd = localToEvent(mapping, source.durationSeconds)
    if (eventStart === null || eventEnd === null) return unplaceable
    const start = eventToLocal(leaderMapping, eventStart)
    const end = eventToLocal(leaderMapping, eventEnd)
    if (start === null || end === null) return unplaceable

    return {
      sourceId: source.id,
      startSeconds: Math.min(start, end),
      endSeconds: Math.max(start, end),
      isLeader: false,
      isLive: stillOnAir(source)
    }
  })
}
