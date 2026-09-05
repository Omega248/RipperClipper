import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoundedCache } from '../boundedCache.js'
import { pipCompositionAt, timelineDurationSeconds, withLinked } from '@shared/timeline'
import type { ItemMove } from '@shared/timeline'
import {
  fitPxPerSecond,
  nearestSnap,
  rulerTicks,
  snapCandidates,
  snapSpanStart,
  tickSpacing
} from '@shared/timelineView'
import { clipRangeInPov } from '@shared/povMapping'
import { povLabel } from '@shared/pov'
import { formatDuration, formatTimecode } from '@shared/time'
import type { TimelineItem, TimelineMarker, TimelineTrack, VodSource } from '@shared/types'
import { useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import { MASTER_PAD_SECONDS, bucketsFor, frameCountFor } from '../media/prefetch.js'
import { Button, EmptyState, Icon, IconButton } from '../ui/index.js'
import { DRAG_MIME } from './MediaLibrary.js'
import type { ClipPovDragPayload } from './MediaLibrary.js'

/**
 * The multi-track timeline: drag POVs in from the Media Library, arrange
 * them across as many video and audio tracks as the story needs, trim,
 * split, delete. Every item is a reference to a range of a POV's own VOD
 * time — see shared/timeline.ts for why moving or trimming one never
 * touches the source clip it came from.
 *
 * The playhead here is a position on the *assembled* sequence, not on any
 * one POV's own clock — `watch()` is what translates between the two, by
 * asking the timeline which item is on top at this instant and seeking the
 * player into *that item's own source range* at the equivalent offset.
 *
 * What is deliberately not in this file: the ruler's tick arithmetic, the
 * snapping candidates and the multi-item edits all live in `shared/` as pure
 * functions, so the parts that have to be *right* are tested without a DOM.
 */

const MIN_PX_PER_SECOND = 1
const MAX_PX_PER_SECOND = 400
const DEFAULT_PX_PER_SECOND = 24
const TRACK_HEIGHT = 56
const MARKER_LANE_HEIGHT = 22
/** The track-header column. Must match `.timeline-track-header` in app.css. */
const HEADER_WIDTH = 160
/** How close, in screen pixels, an edge has to get before it snaps. */
const SNAP_PX = 10
/** Empty room past the last item, so something can be dragged beyond the end. */
const TAIL_PADDING_PX = 320
/** Below this, a pointer press is a click, not a drag. */
const DRAG_SLOP_PX = 3

type TrimSide = 'start' | 'end'
interface TrimPreview {
  itemIds: string[]
  side: TrimSide
  deltaSeconds: number
}
interface MovePreview {
  itemIds: string[]
  /** Only the item under the pointer changes lane; the rest keep their own. */
  anchorId: string
  trackId: string
  deltaSeconds: number
}
interface Marquee {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface MenuState {
  x: number
  y: number
  itemId: string
}

export default function TimelineEditor({
  onExport,
  onWatchSource,
  onSetActiveLive,
  onPrepare
}: {
  onExport: () => void
  /**
   * Builds (or reuses, if a prefetch already did) a local instantly-playable
   * copy of a POV range — the fallback path for a POV `onSetActiveLive`
   * can't take live (see below). Called silently on every such POV swap; a
   * miss just falls back to the live stream, same as before this existed.
   */
  onWatchSource: (
    target: { startSeconds: number; endSeconds: number },
    opts: { silent: true }
  ) => Promise<void>
  /**
   * Hands a cut straight to the warm live-preview pool: makes `sourceId`
   * the visible/audible picture, seeked to `localSeconds`, with no rebuild —
   * true if it could, false for a POV it doesn't keep warm (not
   * live-playable at all), which is when `onWatchSource` is asked instead.
   */
  onSetActiveLive: (sourceId: string, localSeconds: number) => boolean
  /** Opens the gather-material dialog (§19). */
  onPrepare: () => void
}): JSX.Element {
  const project = useStore((s) => s.project)
  const ensureTimeline = useStore((s) => s.ensureTimeline)
  const addTimelineTrack = useStore((s) => s.addTimelineTrack)
  const removeTimelineTrack = useStore((s) => s.removeTimelineTrack)
  const renameTimelineTrack = useStore((s) => s.renameTimelineTrack)
  const patchTimelineTrack = useStore((s) => s.patchTimelineTrack)
  const reorderTimelineTrack = useStore((s) => s.reorderTimelineTrack)
  const addTimelineItem = useStore((s) => s.addTimelineItem)
  const moveTimelineItems = useStore((s) => s.moveTimelineItems)
  const nudgeTimelineItems = useStore((s) => s.nudgeTimelineItems)
  const trimTimelineItem = useStore((s) => s.trimTimelineItem)
  const splitTimelineAt = useStore((s) => s.splitTimelineAt)
  const deleteTimelineItems = useStore((s) => s.deleteTimelineItems)
  const duplicateTimelineItems = useStore((s) => s.duplicateTimelineItems)
  const copyTimelineItems = useStore((s) => s.copyTimelineItems)
  const pasteTimelineItems = useStore((s) => s.pasteTimelineItems)
  const closeTimelineGap = useStore((s) => s.closeTimelineGap)
  const selectedIds = useStore((s) => s.selectedTimelineItemIds)
  const selectedItemId = useStore((s) => s.selectedTimelineItemId)
  const selectTimelineItem = useStore((s) => s.selectTimelineItem)
  const selectTimelineItems = useStore((s) => s.selectTimelineItems)
  const selectTimelineItemsInSpan = useStore((s) => s.selectTimelineItemsInSpan)
  const addTimelineMarker = useStore((s) => s.addTimelineMarker)
  const removeTimelineMarker = useStore((s) => s.removeTimelineMarker)
  const patchTimelineMarker = useStore((s) => s.patchTimelineMarker)
  const playhead = useStore((s) => s.timelinePlayheadSeconds)
  const setTimelinePlayhead = useStore((s) => s.setTimelinePlayhead)
  const ripple = useStore((s) => s.timelineRippleDelete)
  const setTimelineRippleDelete = useStore((s) => s.setTimelineRippleDelete)
  const snap = useStore((s) => s.timelineSnap)
  const setTimelineSnap = useStore((s) => s.setTimelineSnap)
  const clipboardCount = useStore((s) => s.timelineClipboard.length)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const currentTime = useStore((s) => s.currentTime)
  const playing = useStore((s) => s.playing)
  const followPlayhead = useStore((s) => s.settings?.ui.timelineFollowPlayhead ?? true)

  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SECOND)
  /** Zoom keeps refitting to the sequence until the editor zooms themselves. */
  const [autoFit, setAutoFit] = useState(true)
  const [trim, setTrim] = useState<TrimPreview | null>(null)
  const [move, setMove] = useState<MovePreview | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null)
  const [renamingMarkerId, setRenamingMarkerId] = useState<string | null>(null)
  // Which item is currently driving the picture — not derivable from
  // `activeSourceId` alone, since two items on different tracks can share a
  // POV. This is what playback advances and what a cut compares against.
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const laneRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // The timeline is created the moment this view is first opened, not on the
  // first edit — otherwise there would be no track lanes to drop the first
  // clip onto.
  useEffect(() => {
    if (project && !project.timeline) ensureTimeline()
  }, [project, ensureTimeline])

  const timeline = project?.timeline
  const tracks = useMemo(() => {
    if (!timeline) return []
    const video = timeline.tracks.filter((t) => t.kind === 'video').sort((a, b) => b.order - a.order)
    const audio = timeline.tracks.filter((t) => t.kind === 'audio').sort((a, b) => b.order - a.order)
    return [...video, ...audio]
  }, [timeline])

  const durationSeconds = useMemo(() => (timeline ? timelineDurationSeconds(timeline) : 0), [timeline])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  /** The lane's own pixel width: the sequence, plus room to drag past its end. */
  const contentWidth = Math.max(400, durationSeconds * pxPerSecond + TAIL_PADDING_PX)
  const spacing = useMemo(() => tickSpacing(pxPerSecond), [pxPerSecond])

  /*
   * Zoom refits the sequence as it grows or shrinks — until the editor zooms
   * for themselves, at which point it stops fighting them. This used to refit
   * unconditionally, so pressing Zoom In and then trimming anything threw the
   * zoom away. "Fit" puts it back on the leash.
   */
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !autoFit || durationSeconds <= 0) return
    const fit = (): void => {
      const laneWidth = body.clientWidth - HEADER_WIDTH - 12
      if (laneWidth <= 0) return
      setPxPerSecond(fitPxPerSecond(laneWidth, durationSeconds, MIN_PX_PER_SECOND, MAX_PX_PER_SECOND))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(body)
    return () => ro.disconnect()
  }, [durationSeconds, autoFit])

  /** Zoom about a fixed point on screen, so the frame under the pointer stays put. */
  const zoomAround = useCallback(
    (factor: number, anchorSeconds: number): void => {
      setAutoFit(false)
      const scroller = scrollRef.current
      const before = scroller ? anchorSeconds * pxPerSecond - scroller.scrollLeft : 0
      const next = Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, pxPerSecond * factor))
      setPxPerSecond(next)
      if (scroller) {
        // Applied after the width changes, or the scroller clamps against a
        // content box that has not grown yet.
        requestAnimationFrame(() => {
          scroller.scrollLeft = Math.max(0, anchorSeconds * next - before)
        })
      }
    },
    [pxPerSecond]
  )

  /** Show the frame the playhead is now on: whichever POV is the background at this instant, at the equivalent point in its own source. */
  const watch = useCallback(
    (seconds: number): void => {
      setTimelinePlayhead(seconds)
      if (!timeline) return
      const active = pipCompositionAt(timeline, seconds)?.background ?? null
      const changedItem = active?.id !== activeItemId
      setActiveItemId(active?.id ?? null)
      if (!active) return
      const localSeconds = active.sourceStartSeconds + (seconds - active.timelineStartSeconds)
      setActiveSource(active.sourceId)
      // The warm live pool takes almost every cut instantly, no rebuild. Only
      // a POV it can't stream directly (see TimelineLivePlayer) falls back to
      // the older build-a-local-proxy player, and only on an actual cut — a
      // seek within the same item is a plain scrub either player handles alone.
      const live = onSetActiveLive(active.sourceId, localSeconds)
      if (!live) {
        playerBus.seek(localSeconds)
        if (changedItem) {
          void onWatchSource(
            { startSeconds: active.sourceStartSeconds, endSeconds: active.sourceEndSeconds },
            { silent: true }
          )
        }
      }
    },
    [timeline, activeItemId, onSetActiveLive, onWatchSource, setActiveSource, setTimelinePlayhead]
  )
  // Read by listeners that must not re-subscribe every time the playhead moves.
  const watchRef = useRef(watch)
  watchRef.current = watch

  // The picture defaults to whatever POV happens to be active from earlier
  // browsing. The moment there's a sequence to play, it should show the
  // sequence's own start instead — otherwise pressing Play plays the wrong
  // thing until the ruler is clicked once.
  useEffect(() => {
    if (activeItemId || !timeline || timeline.items.length === 0) return
    watchRef.current(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline?.items.length])

  // Playback follows the *assembled sequence*, not one POV's own clock: as
  // the active item's own time advances, the timeline playhead is derived
  // from it every tick, and crossing into the next item's span re-points
  // `watch()` at the new POV — carrying the moving picture, and the sound,
  // across a cut the same way a real multicam edit plays back.
  useEffect(() => {
    if (!playing || !activeItemId || !timeline) return
    const active = timeline.items.find((i) => i.id === activeItemId)
    if (!active) return
    const derived = active.timelineStartSeconds + (currentTime - active.sourceStartSeconds)
    const next = pipCompositionAt(timeline, derived)?.background ?? null
    if (next) {
      setTimelinePlayhead(Math.max(0, derived))
      if (next.id !== active.id) watchRef.current(derived)
      return
    }
    // Nothing covers this instant — either a gap between clips, or the real
    // end of the sequence. Landing here and just pausing would leave the
    // playhead sitting on a position no item covers: the next Play press
    // resumes the same POV from that same uncovered spot, this effect fires
    // again on the very next tick, finds nothing here either, and pauses
    // again immediately — Play looks permanently broken. So a gap is always
    // skipped over rather than stalled on, and only the genuine end pauses —
    // and rewinds first, so Play always has a valid position to resume from.
    const upcoming = timeline.items
      .filter((i) => i.kind === 'video' && i.timelineStartSeconds > derived + 0.001)
      .sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)[0]
    if (upcoming) {
      watchRef.current(upcoming.timelineStartSeconds)
      return
    }
    playerBus.pause()
    watchRef.current(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, playing])

  /*
   * Keep the playhead on screen while it is moving.
   *
   * Only while playing, and only when it has actually left the visible strip:
   * scrolling on every tick would fight a user who has deliberately scrolled
   * somewhere else to look at something.
   */
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || !playing || !followPlayhead) return
    const x = playhead * pxPerSecond
    const left = scroller.scrollLeft
    const right = left + scroller.clientWidth - HEADER_WIDTH
    if (x < left || x > right - 40) {
      scroller.scrollLeft = Math.max(0, x - (scroller.clientWidth - HEADER_WIDTH) * 0.35)
    }
  }, [playhead, playing, pxPerSecond, followPlayhead])

  /** Seconds at a client X, in lane coordinates. */
  const secondsAtClientX = useCallback(
    (clientX: number): number => {
      const scroller = scrollRef.current
      if (!scroller) return 0
      const box = scroller.getBoundingClientRect()
      return Math.max(0, (clientX - box.left - HEADER_WIDTH + scroller.scrollLeft) / pxPerSecond)
    },
    [pxPerSecond]
  )

  const snapPointsFor = useCallback(
    (excludeItemIds: Iterable<string>): number[] =>
      timeline ? snapCandidates(timeline, { playheadSeconds: playhead, excludeItemIds }) : [],
    [timeline, playhead]
  )
  const tolerance = snap ? SNAP_PX / pxPerSecond : 0

  const widthFor = (item: TimelineItem): number => {
    let duration = item.timelineEndSeconds - item.timelineStartSeconds
    if (trim?.itemIds.includes(item.id)) {
      duration = trim.side === 'start' ? duration - trim.deltaSeconds : duration + trim.deltaSeconds
    }
    return Math.max(4, duration * pxPerSecond)
  }

  const leftFor = (item: TimelineItem): number => {
    let start = item.timelineStartSeconds
    if (trim?.itemIds.includes(item.id) && trim.side === 'start') start += trim.deltaSeconds
    if (move?.itemIds.includes(item.id)) start += move.deltaSeconds
    return Math.max(0, start) * pxPerSecond
  }

  /** The ids an edit should touch: everything selected (plus linked partners), or just this item if it isn't in the selection. */
  const scopeFor = useCallback(
    (itemId: string): string[] => {
      if (!timeline) return []
      const base = selectedSet.has(itemId) ? selectedIds : [itemId]
      return withLinked(timeline, base)
    },
    [timeline, selectedIds, selectedSet]
  )

  const beginTrim = (item: TimelineItem, side: TrimSide) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!timeline) return
    if (!selectedSet.has(item.id)) selectTimelineItem(item.id)
    // Trimming drags the linked partner's matching edge too, so a picture and
    // its sound cannot end up different lengths without unlinking first.
    const ids = withLinked(timeline, [item.id])
    const startX = e.clientX
    const onMove = (ev: PointerEvent): void => {
      setTrim({ itemIds: ids, side, deltaSeconds: (ev.clientX - startX) / pxPerSecond })
    }
    const onUp = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      const deltaSeconds = (ev.clientX - startX) / pxPerSecond
      setTrim(null)
      if (Math.abs(deltaSeconds) < 0.02) return
      const raw =
        side === 'start' ? item.timelineStartSeconds + deltaSeconds : item.timelineEndSeconds + deltaSeconds
      const boundary = nearestSnap(raw, snapPointsFor(ids), tolerance) ?? raw
      for (const id of ids) trimTimelineItem(id, side, Math.max(0, boundary))
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const beginMove = (item: TimelineItem) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.titem-trim')) return
    if (!timeline) return
    const track = tracks.find((t) => t.id === item.trackId)
    if (track?.locked) return
    e.preventDefault()

    // Clicking an unselected item selects it; clicking one already in the
    // selection keeps the whole group so it can be dragged as a group.
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    if (additive) selectTimelineItem(item.id, 'toggle')
    else if (!selectedSet.has(item.id)) selectTimelineItem(item.id)

    const ids = additive ? withLinked(timeline, [item.id]) : scopeFor(item.id)
    const startX = e.clientX
    let overTrackId = item.trackId
    let dragged = false

    const onMove = (ev: PointerEvent): void => {
      const deltaSeconds = (ev.clientX - startX) / pxPerSecond
      if (!dragged && Math.abs(ev.clientX - startX) < DRAG_SLOP_PX) return
      dragged = true
      // Which track lane is the pointer over now, among unlocked tracks of the
      // same kind.
      for (const [trackId, el] of laneRefs.current) {
        const candidate = tracks.find((t) => t.id === trackId)
        if (!candidate || candidate.kind !== item.kind || candidate.locked) continue
        const box = el.getBoundingClientRect()
        if (ev.clientY >= box.top && ev.clientY <= box.bottom) {
          overTrackId = trackId
          break
        }
      }
      setMove({ itemIds: ids, anchorId: item.id, trackId: overTrackId, deltaSeconds })
    }

    const onUp = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      setMove(null)
      if (!dragged) return
      const rawDelta = (ev.clientX - startX) / pxPerSecond
      const duration = item.timelineEndSeconds - item.timelineStartSeconds
      // Snap is computed for the item under the pointer; everybody else keeps
      // their offset from it, so a group keeps its internal spacing exactly.
      const snappedStart = snapSpanStart(
        Math.max(0, item.timelineStartSeconds + rawDelta),
        duration,
        snapPointsFor(ids),
        tolerance
      )
      const delta = Math.max(snappedStart, 0) - item.timelineStartSeconds
      const moving = timeline.items.filter((i) => ids.includes(i.id))
      const earliest = Math.min(...moving.map((i) => i.timelineStartSeconds))
      const clamped = Math.max(delta, -earliest)
      if (Math.abs(clamped) < 0.02 && overTrackId === item.trackId) return
      const moves: ItemMove[] = moving.map((i) => ({
        id: i.id,
        trackId: i.id === item.id ? overTrackId : i.trackId,
        timelineStartSeconds: i.timelineStartSeconds + clamped
      }))
      moveTimelineItems(moves)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  /** Press-and-drag on empty lane space: rubber-band select. */
  const beginMarquee = (e: React.PointerEvent): void => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    const scroller = scrollRef.current
    if (!scroller) return
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const start = { x: e.clientX, y: e.clientY }
    let dragged = false
    const onMove = (ev: PointerEvent): void => {
      if (!dragged && Math.abs(ev.clientX - start.x) < DRAG_SLOP_PX && Math.abs(ev.clientY - start.y) < DRAG_SLOP_PX) {
        return
      }
      dragged = true
      setMarquee({ x0: start.x, y0: start.y, x1: ev.clientX, y1: ev.clientY })
    }
    const onUp = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      setMarquee(null)
      if (!dragged) {
        // A plain click on empty space clears the selection, the same as
        // clicking off a shape in any drawing tool.
        if (!additive) selectTimelineItem(null)
        return
      }
      const top = Math.min(start.y, ev.clientY)
      const bottom = Math.max(start.y, ev.clientY)
      const hitTracks: string[] = []
      for (const [trackId, el] of laneRefs.current) {
        const box = el.getBoundingClientRect()
        if (box.bottom >= top && box.top <= bottom) hitTracks.push(trackId)
      }
      selectTimelineItemsInSpan(
        secondsAtClientX(start.x),
        secondsAtClientX(ev.clientX),
        hitTracks,
        additive
      )
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  /** Click or drag anywhere on the ruler: scrub. */
  const beginScrub = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const to = (clientX: number): void => watchRef.current(secondsAtClientX(clientX))
    to(e.clientX)
    const onMove = (ev: PointerEvent): void => to(ev.clientX)
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const beginMarkerDrag = (marker: TimelineMarker) => (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    let dragged = false
    const startX = e.clientX
    const onMove = (ev: PointerEvent): void => {
      if (!dragged && Math.abs(ev.clientX - startX) < DRAG_SLOP_PX) return
      dragged = true
      patchTimelineMarker(marker.id, { timeSeconds: secondsAtClientX(ev.clientX) })
    }
    const onUp = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      if (!dragged) watchRef.current(marker.timeSeconds)
      else patchTimelineMarker(marker.id, { timeSeconds: secondsAtClientX(ev.clientX) })
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const onDropOnTrack = (track: TimelineTrack) => (e: React.DragEvent): void => {
    e.preventDefault()
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw || !project || track.locked) return
    const payload = JSON.parse(raw) as ClipPovDragPayload
    const clip = project.clips.find((c) => c.id === payload.clipId)
    const source = project.sources.find((s) => s.id === payload.povId)
    if (!clip || !source) return
    const rawDropSeconds = secondsAtClientX(e.clientX)

    // The POV's own range for this clip — the picture and the sound share
    // it, since both come from the same recording.
    const local = clip.povMappings?.find((m) => m.sourceId === source.id)
    const sourceStart = local ? local.vodStartSeconds : clip.startSeconds
    const sourceEnd = local ? local.vodEndSeconds : clip.endSeconds
    if (sourceEnd - sourceStart < 0.1) return

    // Dropped near another item's edge — most often the tail of the POV
    // that was covering the moment before this one — lands flush against it
    // instead of leaving a gap or a sliver of overlap, so this is also what
    // makes "picks up right where the last POV left off" the natural result
    // of just dragging it into roughly the right place.
    const dropSeconds = Math.max(
      0,
      snapSpanStart(rawDropSeconds, sourceEnd - sourceStart, snapPointsFor([]), tolerance)
    )

    const id = addTimelineItem({
      trackId: track.id,
      kind: track.kind,
      sourceId: source.id,
      sourceClipId: clip.id,
      sourceStartSeconds: sourceStart,
      sourceEndSeconds: sourceEnd,
      timelineStartSeconds: dropSeconds,
      timelineEndSeconds: dropSeconds + (sourceEnd - sourceStart)
    })
    if (id) selectTimelineItems([id])
  }

  /**
   * The blade, the nudge, the lot — keyboard bindings that only exist while
   * this view is mounted.
   *
   * Registered on the capture phase so they beat the application-wide
   * shortcuts, which are about *clips* on the Video page: Delete there means
   * "delete the selected clip", and while the editor is open with a timeline
   * item selected, it has to mean this item instead. Anything the editor does
   * not claim falls through untouched, so Ctrl+Z is still one undo.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) return
      }
      const state = useStore.getState()
      const ids = state.selectedTimelineItemIds
      const at = state.timelinePlayheadSeconds
      const tl = state.project?.timeline
      const claim = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      const ctrl = e.ctrlKey || e.metaKey

      if (ctrl && e.code === 'KeyC' && ids.length > 0) return claim(), state.copyTimelineItems(ids)
      if (ctrl && e.code === 'KeyV' && state.timelineClipboard.length > 0) {
        return claim(), state.pasteTimelineItems(at)
      }
      if (ctrl && e.code === 'KeyX' && ids.length > 0) {
        claim()
        state.copyTimelineItems(ids)
        state.deleteTimelineItems(ids, state.timelineRippleDelete)
        return
      }
      if (ctrl && e.code === 'KeyD' && ids.length > 0) return claim(), state.duplicateTimelineItems(ids)
      if (ctrl && e.code === 'KeyA' && tl) {
        return claim(), state.selectTimelineItems(tl.items.map((i) => i.id))
      }
      if (ctrl && (e.code === 'Equal' || e.code === 'NumpadAdd')) return claim(), zoomAround(1.4, at)
      if (ctrl && (e.code === 'Minus' || e.code === 'NumpadSubtract')) return claim(), zoomAround(1 / 1.4, at)

      switch (e.code) {
        case 'KeyS':
          if (ctrl) return // Ctrl+S is Save, and stays Save.
          claim()
          splitTimelineAt(at, ids.length > 0 ? ids : undefined)
          return
        case 'Delete':
        case 'Backspace':
          if (ids.length === 0) return
          claim()
          deleteTimelineItems(ids, state.timelineRippleDelete)
          return
        case 'KeyM':
          claim()
          addTimelineMarker(at)
          return
        case 'KeyF':
          claim()
          setAutoFit(true)
          return
        case 'BracketLeft':
          if (ids.length === 0) return
          claim()
          for (const id of ids) trimTimelineItem(id, 'start', at)
          return
        case 'BracketRight':
          if (ids.length === 0) return
          claim()
          for (const id of ids) trimTimelineItem(id, 'end', at)
          return
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (ids.length === 0) return
          claim()
          // One frame at 30fps by default; a whole second with Shift held.
          const step = (e.shiftKey ? 1 : 1 / 30) * (e.code === 'ArrowLeft' ? -1 : 1)
          nudgeTimelineItems(ids, step)
          return
        }
        case 'Home':
          claim()
          watchRef.current(0)
          return
        case 'End':
          claim()
          watchRef.current(timelineDurationSeconds(tl ?? { tracks: [], items: [], markers: [] }))
          return
        case 'Escape':
          if (ids.length === 0) return
          claim()
          state.selectTimelineItem(null)
          return
        default:
          return
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    zoomAround,
    splitTimelineAt,
    deleteTimelineItems,
    addTimelineMarker,
    trimTimelineItem,
    nudgeTimelineItems
  ])

  /** Ctrl+wheel zooms about the pointer; Shift+wheel pans. Plain wheel scrolls tracks, as it should. */
  const onWheel = (e: React.WheelEvent): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      zoomAround(e.deltaY < 0 ? 1.15 : 1 / 1.15, secondsAtClientX(e.clientX))
      return
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault()
      scroller.scrollLeft += e.deltaX !== 0 ? e.deltaX : e.deltaY
    }
  }

  // A menu that stays open after its item is deleted would act on nothing.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!project) return <EmptyState icon="scissors" title="Open or create a project to build a sequence." />
  // One render behind `ensureTimeline()` at most — the effect above fires
  // immediately after this first paint.
  if (!timeline) return <></>

  const hasItems = timeline.items.length > 0
  const selectedItem = timeline.items.find((i) => i.id === selectedItemId) ?? null
  const selectionSeconds = timeline.items
    .filter((i) => selectedSet.has(i.id) && i.kind === 'video')
    .reduce((total, i) => total + (i.timelineEndSeconds - i.timelineStartSeconds), 0)

  /** Adds a matching audio-track item alongside a video item's own picture, so the sound can be nudged, muted, or replaced on its own. */
  const onSeparateAudio = (): void => {
    const state = useStore.getState()
    const tl = state.project?.timeline
    const item = tl?.items.find((i) => i.id === selectedItemId)
    if (!tl || !item || item.kind !== 'video') return
    let target: TimelineTrack | undefined = [...tl.tracks]
      .filter((t) => t.kind === 'audio' && !t.locked)
      .sort((a, b) => b.order - a.order)[0]
    if (!target) {
      addTimelineTrack('audio')
      target = useStore
        .getState()
        .project?.timeline?.tracks.filter((t) => t.kind === 'audio')
        .sort((a, b) => b.order - a.order)[0]
    }
    if (!target) return
    addTimelineItem({
      trackId: target.id,
      kind: 'audio',
      sourceId: item.sourceId,
      sourceClipId: item.sourceClipId,
      sourceStartSeconds: item.sourceStartSeconds,
      sourceEndSeconds: item.sourceEndSeconds,
      timelineStartSeconds: item.timelineStartSeconds,
      timelineEndSeconds: item.timelineEndSeconds
    })
  }

  const menuItem = menu ? timeline.items.find((i) => i.id === menu.itemId) ?? null : null

  return (
    <div className="timeline-editor">
      <TimelineToolbar
        onPrepare={onPrepare}
        onZoomIn={() => zoomAround(1.4, playhead)}
        onZoomOut={() => zoomAround(1 / 1.4, playhead)}
        onFit={() => setAutoFit(true)}
        autoFit={autoFit}
        ripple={ripple}
        setRipple={setTimelineRippleDelete}
        snap={snap}
        setSnap={setTimelineSnap}
        durationLabel={formatDuration(durationSeconds)}
        onAddVideoTrack={() => addTimelineTrack('video')}
        onAddAudioTrack={() => addTimelineTrack('audio')}
        onSplit={() => splitTimelineAt(playhead, selectedIds.length > 0 ? selectedIds : undefined)}
        onDelete={() => deleteTimelineItems(selectedIds, ripple)}
        onDuplicate={() => duplicateTimelineItems(selectedIds)}
        onCopy={() => copyTimelineItems(selectedIds)}
        onPaste={() => pasteTimelineItems(playhead)}
        canPaste={clipboardCount > 0}
        onAddMarker={() => addTimelineMarker(playhead)}
        selectionCount={selectedIds.length}
        onSeparateAudio={onSeparateAudio}
        canSeparateAudio={selectedItem?.kind === 'video'}
        onExport={onExport}
        canExport={hasItems}
      />

      <div className="timeline-editor-body" ref={bodyRef}>
        {!hasItems && (
          <div className="timeline-empty-hint">
            Drag a POV card from the Library onto a video or audio track below.
          </div>
        )}
        <div className="timeline-scroll" ref={scrollRef} onWheel={onWheel}>
          <div className="timeline-canvas" style={{ width: HEADER_WIDTH + contentWidth }}>
            <div
              className="timeline-playhead"
              style={{ left: HEADER_WIDTH + playhead * pxPerSecond }}
              aria-hidden="true"
            />

            <div className="timeline-ruler-row">
              <div className="timeline-lane-gutter timeline-ruler-gutter">
                <span className="mono">{formatTimecode(playhead, { millis: true })}</span>
              </div>
              <div
                className="timeline-ruler"
                style={{ width: contentWidth }}
                onPointerDown={beginScrub}
                role="slider"
                tabIndex={0}
                aria-label="Playhead"
                aria-valuemin={0}
                aria-valuemax={Math.max(0, durationSeconds)}
                aria-valuenow={playhead}
                aria-valuetext={formatTimecode(playhead, { millis: false })}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault()
                    e.stopPropagation()
                    watch(Math.max(0, playhead + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)))
                  }
                }}
              >
                {rulerTicks(0, contentWidth / pxPerSecond, pxPerSecond, spacing).map((tick) => (
                  <div
                    key={tick.seconds}
                    className={`timeline-tick${tick.major ? ' is-major' : ''}`}
                    style={{ left: tick.seconds * pxPerSecond }}
                  >
                    {tick.major && (
                      <span className="timeline-tick-label mono">
                        {formatTimecode(tick.seconds, { millis: spacing.major < 1 })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="timeline-marker-row" style={{ height: MARKER_LANE_HEIGHT }}>
              <div className="timeline-lane-gutter">
                <Icon name="flag" size={12} />
                <span className="ellipsis">Markers</span>
              </div>
              <div
                className="timeline-marker-lane"
                style={{ width: contentWidth }}
                onDoubleClick={(e) => addTimelineMarker(secondsAtClientX(e.clientX))}
                title="Double-click to drop a marker"
              >
                {timeline.markers.map((marker) => (
                  <div
                    key={marker.id}
                    className="timeline-marker"
                    style={{ left: marker.timeSeconds * pxPerSecond }}
                    onPointerDown={beginMarkerDrag(marker)}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenamingMarkerId(marker.id)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      removeTimelineMarker(marker.id)
                    }}
                    title={`${marker.name} — ${formatTimecode(marker.timeSeconds, { millis: false })}. Drag to move, double-click to rename, right-click to remove.`}
                  >
                    <span className="timeline-marker-flag" />
                    {renamingMarkerId === marker.id ? (
                      <input
                        className="timeline-marker-input"
                        autoFocus
                        defaultValue={marker.name}
                        onPointerDown={(e) => e.stopPropagation()}
                        onBlur={(e) => {
                          const name = e.currentTarget.value.trim()
                          if (name) patchTimelineMarker(marker.id, { name })
                          setRenamingMarkerId(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') setRenamingMarkerId(null)
                        }}
                      />
                    ) : (
                      <span className="timeline-marker-name ellipsis">{marker.name}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="timeline-track-list">
              {tracks.map((track) => {
                const items = timeline.items.filter((i) => i.trackId === track.id)
                return (
                  <div className="timeline-track-row" key={track.id} style={{ height: TRACK_HEIGHT }}>
                    <div className={`timeline-track-header${track.locked ? ' is-locked' : ''}`}>
                      <div className="timeline-track-title">
                      <Icon name={track.kind === 'video' ? 'grid' : 'waveform'} />
                      {renamingTrackId === track.id ? (
                        <input
                          className="timeline-track-name-input"
                          autoFocus
                          defaultValue={track.name}
                          onBlur={(e) => {
                            renameTimelineTrack(track.id, e.currentTarget.value)
                            setRenamingTrackId(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                            if (e.key === 'Escape') setRenamingTrackId(null)
                          }}
                        />
                      ) : (
                        <span
                          className="ellipsis timeline-track-name"
                          onDoubleClick={() => setRenamingTrackId(track.id)}
                          title="Double-click to rename"
                        >
                          {track.name}
                        </span>
                      )}
                      <span className="spacer" />
                      <span className="timeline-track-count mono">{items.length}</span>
                      </div>
                      <div className="timeline-track-buttons">
                      <IconButton
                        icon="chevron-up"
                        size="compact"
                        label={`Move ${track.name} up`}
                        onClick={() => reorderTimelineTrack(track.id, 'up')}
                      />
                      <IconButton
                        icon="chevron-down"
                        size="compact"
                        label={`Move ${track.name} down`}
                        onClick={() => reorderTimelineTrack(track.id, 'down')}
                      />
                      {track.kind === 'video' ? (
                        <IconButton
                          icon={track.hidden ? 'eye-off' : 'eye'}
                          size="compact"
                          label={track.hidden ? 'Show track' : 'Hide track'}
                          selected={track.hidden}
                          onClick={() => patchTimelineTrack(track.id, { hidden: !track.hidden })}
                        />
                      ) : (
                        <>
                          <IconButton
                            icon={track.muted ? 'volume-off' : 'volume'}
                            size="compact"
                            label={track.muted ? 'Unmute track' : 'Mute track'}
                            selected={track.muted}
                            onClick={() => patchTimelineTrack(track.id, { muted: !track.muted })}
                          />
                          <IconButton
                            icon="target"
                            size="compact"
                            label={track.solo ? 'Unsolo track' : 'Solo track'}
                            selected={track.solo}
                            onClick={() => patchTimelineTrack(track.id, { solo: !track.solo })}
                          />
                        </>
                      )}
                      <IconButton
                        icon={track.locked ? 'lock' : 'unlock'}
                        size="compact"
                        label={track.locked ? 'Unlock track' : 'Lock track'}
                        selected={track.locked}
                        onClick={() => patchTimelineTrack(track.id, { locked: !track.locked })}
                      />
                      <IconButton
                        icon="trash"
                        size="compact"
                        label={`Remove ${track.name}`}
                        onClick={() => removeTimelineTrack(track.id)}
                      />
                      </div>
                    </div>

                    <div
                      className={`timeline-track-lane${track.locked ? ' is-locked' : ''}`}
                      style={{ width: contentWidth }}
                      ref={(el) => {
                        if (el) laneRefs.current.set(track.id, el)
                        else laneRefs.current.delete(track.id)
                      }}
                      onPointerDown={beginMarquee}
                      onDoubleClick={(e) => {
                        if (e.target !== e.currentTarget) return
                        closeTimelineGap(track.id, secondsAtClientX(e.clientX))
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={onDropOnTrack(track)}
                      title={track.locked ? `${track.name} is locked` : undefined}
                    >
                      {items.map((item) => (
                        <div
                          key={item.id}
                          className={`titem${selectedSet.has(item.id) ? ' on' : ''}${
                            item.id === activeItemId ? ' is-playing' : ''
                          }${item.pip ? ' is-pip' : ''}${move?.itemIds.includes(item.id) ? ' is-dragging' : ''}`}
                          style={{ left: leftFor(item), width: widthFor(item) }}
                          onPointerDown={beginMove(item)}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            watch(item.timelineStartSeconds)
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            if (!selectedSet.has(item.id)) selectTimelineItem(item.id)
                            setMenu({ x: e.clientX, y: e.clientY, itemId: item.id })
                          }}
                        >
                          <div className="titem-trim titem-trim-start" onPointerDown={beginTrim(item, 'start')} />
                          <div className="titem-visual">
                            <ItemVisual
                              item={item}
                              project={project}
                              source={project.sources.find((s) => s.id === item.sourceId) ?? null}
                            />
                          </div>
                          <div className="titem-body">
                            <ItemLabel item={item} project={project} />
                          </div>
                          <div className="titem-trim titem-trim-end" onPointerDown={beginTrim(item, 'end')} />
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {marquee && (
          <div
            className="timeline-marquee"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0)
            }}
          />
        )}
      </div>

      <div className="timeline-status">
        <span className="mono">{formatTimecode(playhead, { millis: true })}</span>
        <span className="topbar-divider" />
        <span>{formatDuration(durationSeconds)} total</span>
        {selectedIds.length > 0 && (
          <>
            <span className="topbar-divider" />
            <span>
              {selectedIds.length} selected · {formatDuration(selectionSeconds)}
            </span>
          </>
        )}
        <span className="spacer" />
        <span className="dim">
          S split · Del remove · Ctrl+D duplicate · ←/→ nudge · [ ] trim to playhead · M marker · F fit ·
          Ctrl+wheel zoom
        </span>
      </div>

      {menu && menuItem && (
        <div className="timeline-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button role="menuitem" onClick={() => (setMenu(null), watch(menuItem.timelineStartSeconds))}>
            Play from here
          </button>
          <button
            role="menuitem"
            onClick={() => (setMenu(null), splitTimelineAt(playhead, scopeFor(menuItem.id)))}
          >
            Split at playhead
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), duplicateTimelineItems(scopeFor(menuItem.id)))}>
            Duplicate
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), copyTimelineItems(scopeFor(menuItem.id)))}>
            Copy
          </button>
          {menuItem.kind === 'video' && (
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null)
                useStore.getState().patchTimelineItem(menuItem.id, { pip: !menuItem.pip })
              }}
            >
              {menuItem.pip ? 'Stop using as inset' : 'Use as picture-in-picture inset'}
            </button>
          )}
          {menuItem.linkedItemId && (
            <button role="menuitem" onClick={() => (setMenu(null), useStore.getState().unlinkTimelineItem(menuItem.id))}>
              Unlink picture and sound
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => (setMenu(null), closeTimelineGap(menuItem.trackId, menuItem.timelineStartSeconds - 0.001))}
          >
            Close the gap before this
          </button>
          <button
            role="menuitem"
            className="is-destructive"
            onClick={() => (setMenu(null), deleteTimelineItems(scopeFor(menuItem.id), ripple))}
          >
            Remove{selectedIds.length > 1 && selectedSet.has(menuItem.id) ? ` ${selectedIds.length} items` : ''}
          </button>
        </div>
      )}
    </div>
  )
}

function ItemLabel({
  item,
  project
}: {
  item: TimelineItem
  project: NonNullable<ReturnType<typeof useStore.getState>['project']>
}): JSX.Element {
  const source = project.sources.find((s) => s.id === item.sourceId)
  const clip = item.sourceClipId ? project.clips.find((c) => c.id === item.sourceClipId) : undefined
  const label = clip ? `${clip.name} — ${source ? povLabel(source) : ''}` : source ? povLabel(source) : 'Untitled'
  // The POV's own VOD time, not the timeline position — this is what lines
  // up across POVs when eyeballing whether two items cover the same moment.
  const range = `${formatTimecode(item.sourceStartSeconds, { millis: false })} → ${formatTimecode(item.sourceEndSeconds, { millis: false })}`
  return (
    <>
      <div className="titem-title ellipsis">{label}</div>
      <div className="titem-time mono ellipsis">{range}</div>
    </>
  )
}

/**
 * The range to actually fetch filmstrip/waveform data for: the clip's own
 * full span in this POV (padded a little), not the item's current trim.
 * Trimming only narrows which slice of that fetch is shown — see
 * `sliceByTime` below — so shortening or restoring a trim within the padded
 * range never asks the main process to run ffmpeg again. Falls back to the
 * item's own exact range when it isn't from a clip, or has been trimmed
 * outside what padding covers (rare — pushed past the clip's own marked
 * edges), which simply costs one fresh fetch the same as before this existed.
 */
function masterRangeFor(
  item: TimelineItem,
  project: NonNullable<ReturnType<typeof useStore.getState>['project']>
): { start: number; end: number } {
  const fallback = { start: item.sourceStartSeconds, end: item.sourceEndSeconds }
  const clip = item.sourceClipId ? project.clips.find((c) => c.id === item.sourceClipId) : undefined
  const source = project.sources.find((s) => s.id === item.sourceId)
  if (!clip || !source) return fallback
  const range = clipRangeInPov(clip, source)
  if (range.coverage === 'none') return fallback
  return {
    start: Math.max(0, Math.min(range.localStart, item.sourceStartSeconds) - MASTER_PAD_SECONDS),
    end: Math.min(
      source.durationSeconds,
      Math.max(range.localEnd, item.sourceEndSeconds) + MASTER_PAD_SECONDS
    )
  }
}

/** The slice of an evenly-spaced-across-`[from,to]` array that falls within `[start,end]`. */
function sliceByTime<T>(values: T[], from: number, to: number, start: number, end: number): T[] {
  const span = to - from
  if (!(span > 0) || values.length === 0) return values
  const i0 = Math.max(0, Math.floor(((start - from) / span) * values.length))
  const i1 = Math.min(values.length, Math.ceil(((end - from) / span) * values.length))
  const slice = values.slice(i0, Math.max(i0 + 1, i1))
  return slice.length > 0 ? slice : values
}

/** Filmstrip frames for a video item, a waveform for an audio one — whichever helps recognise it and line it up against other POVs at a glance. */
function ItemVisual({
  item,
  project,
  source
}: {
  item: TimelineItem
  project: NonNullable<ReturnType<typeof useStore.getState>['project']>
  source: VodSource | null
}): JSX.Element | null {
  if (!source) return null
  const master = masterRangeFor(item, project)
  return item.kind === 'video' ? (
    <ItemFilmstrip
      source={source}
      masterStart={master.start}
      masterEnd={master.end}
      displayStart={item.sourceStartSeconds}
      displayEnd={item.sourceEndSeconds}
    />
  ) : (
    <ItemWaveform
      source={source}
      masterStart={master.start}
      masterEnd={master.end}
      displayStart={item.sourceStartSeconds}
      displayEnd={item.sourceEndSeconds}
    />
  )
}

/*
 * Bounded, because these hold base64 frames and the keys embed each item's
 * trimmed range — every drag of a handle stranded the previous entry forever.
 * Generous caps: the main process disk-caches the same frames, so a miss is
 * one IPC call, not a re-decode.
 */
const filmstripCache = new BoundedCache<string, string[]>(200)
const waveformCache = new BoundedCache<string, number[]>(200)

function ItemFilmstrip({
  source,
  masterStart,
  masterEnd,
  displayStart,
  displayEnd
}: {
  source: VodSource
  masterStart: number
  masterEnd: number
  displayStart: number
  displayEnd: number
}): JSX.Element | null {
  const duration = masterEnd - masterStart
  const frameCount = frameCountFor(duration)
  const key = `${source.id}:${masterStart.toFixed(2)}:${masterEnd.toFixed(2)}:${frameCount}`
  const [frames, setFrames] = useState<string[] | null>(filmstripCache.get(key) ?? null)

  useEffect(() => {
    const cached = filmstripCache.get(key)
    if (cached) {
      setFrames(cached)
      return
    }
    if (!(duration > 0)) return
    let cancelled = false
    setFrames(null)
    window.api
      .filmstrip({ source, startSeconds: masterStart, endSeconds: masterEnd, frameCount, width: 96 })
      .then((res) => {
        if (cancelled) return
        filmstripCache.set(key, res.frames)
        setFrames(res.frames)
      })
      .catch(() => {
        // No filmstrip for this source — the item still works, it just shows
        // its label alone, the same as before this existed.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!frames || frames.length === 0) return null
  const shown = sliceByTime(frames, masterStart, masterEnd, displayStart, displayEnd)
  return (
    <div className="titem-filmstrip">
      {shown.map((src, i) => (
        <img key={i} src={src} alt="" draggable={false} />
      ))}
    </div>
  )
}

function ItemWaveform({
  source,
  masterStart,
  masterEnd,
  displayStart,
  displayEnd
}: {
  source: VodSource
  masterStart: number
  masterEnd: number
  displayStart: number
  displayEnd: number
}): JSX.Element | null {
  const duration = masterEnd - masterStart
  const buckets = bucketsFor(duration)
  const key = `${source.id}:${masterStart.toFixed(2)}:${masterEnd.toFixed(2)}:${buckets}`
  const [master, setMaster] = useState<number[] | null>(waveformCache.get(key) ?? null)

  useEffect(() => {
    const cached = waveformCache.get(key)
    if (cached) {
      setMaster(cached)
      return
    }
    if (!(duration > 0)) return
    let cancelled = false
    setMaster(null)
    window.api
      .audioPeaks({ source, startSeconds: masterStart, endSeconds: masterEnd, buckets })
      .then((res) => {
        if (cancelled) return
        waveformCache.set(key, res.peaks)
        setMaster(res.peaks)
      })
      .catch(() => {
        // No audio on this POV, or nothing decodable — the item stays plain.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!master || master.length === 0) return null
  const peaks = sliceByTime(master, masterStart, masterEnd, displayStart, displayEnd)
  const mid = 50
  const top = peaks.map((p, i) => `${(i / (peaks.length - 1)) * 100},${mid - p * mid}`)
  const bottom = peaks
    .map((p, i) => `${(i / (peaks.length - 1)) * 100},${mid + p * mid}`)
    .reverse()
  const path = `M ${[...top, ...bottom].join(' L ')} Z`
  return (
    <svg className="titem-waveform" viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d={path} />
    </svg>
  )
}

function TimelineToolbar(props: {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  autoFit: boolean
  ripple: boolean
  setRipple: (v: boolean) => void
  snap: boolean
  setSnap: (v: boolean) => void
  durationLabel: string
  onAddVideoTrack: () => void
  onAddAudioTrack: () => void
  onSplit: () => void
  onDelete: () => void
  onDuplicate: () => void
  onCopy: () => void
  onPaste: () => void
  canPaste: boolean
  onAddMarker: () => void
  selectionCount: number
  onSeparateAudio: () => void
  canSeparateAudio: boolean
  onExport: () => void
  canExport: boolean
  onPrepare: () => void
}): JSX.Element {
  const has = props.selectionCount > 0
  const suffix = props.selectionCount > 1 ? ` (${props.selectionCount})` : ''
  return (
    <div className="clip-timeline-head">
      <Button
        size="compact"
        icon="download"
        onClick={props.onPrepare}
        title="Bring gathered clips, their POVs, sync and edits into this sequence"
      >
        Prepare
      </Button>
      <Button size="compact" icon="plus" onClick={props.onAddVideoTrack} title="Add a video track">
        Video
      </Button>
      <Button size="compact" icon="plus" onClick={props.onAddAudioTrack} title="Add an audio track">
        Audio
      </Button>
      <span className="topbar-divider" />
      <Button size="compact" icon="scissors" onClick={props.onSplit} title="Split at the playhead (S)">
        Split
      </Button>
      <Button size="compact" icon="copy" disabled={!has} onClick={props.onDuplicate} title="Duplicate (Ctrl+D)">
        Duplicate{suffix}
      </Button>
      <IconButton icon="copy" size="compact" label="Copy (Ctrl+C)" disabled={!has} onClick={props.onCopy} />
      <IconButton
        icon="file"
        size="compact"
        label="Paste at the playhead (Ctrl+V)"
        disabled={!props.canPaste}
        onClick={props.onPaste}
      />
      <Button size="compact" icon="trash" disabled={!has} onClick={props.onDelete} title="Remove (Delete)">
        Remove{suffix}
      </Button>
      <Button
        size="compact"
        icon="waveform"
        disabled={!props.canSeparateAudio}
        onClick={props.onSeparateAudio}
        title="Add this item's sound to its own audio track, so it can be edited apart from the picture"
      >
        Separate audio
      </Button>
      <Button size="compact" icon="flag" onClick={props.onAddMarker} title="Drop a marker at the playhead (M)">
        Marker
      </Button>
      <span className="topbar-divider" />
      <button
        className={`segmented-item${props.snap ? ' on' : ''}`}
        aria-pressed={props.snap}
        onClick={() => props.setSnap(!props.snap)}
        title="Edges land exactly on other clips, markers and the playhead"
      >
        Snap
      </button>
      <button
        className={`segmented-item${props.ripple ? ' on' : ''}`}
        aria-pressed={props.ripple}
        onClick={() => props.setRipple(!props.ripple)}
        title="When on, deleting a clip pulls everything after it (on the same track) left to close the gap"
      >
        Ripple
      </button>
      <span className="spacer" />
      <IconButton icon="minus" size="compact" label="Zoom out (Ctrl+-)" onClick={props.onZoomOut} />
      <IconButton icon="plus" size="compact" label="Zoom in (Ctrl++)" onClick={props.onZoomIn} />
      <button
        className={`segmented-item${props.autoFit ? ' on' : ''}`}
        aria-pressed={props.autoFit}
        onClick={props.onFit}
        title="Fit the whole sequence in view, and keep it fitted as it changes (F)"
      >
        Fit
      </button>
      <span className="topbar-divider" />
      <Button
        size="compact"
        variant="primary"
        icon="download"
        disabled={!props.canExport}
        onClick={props.onExport}
      >
        Export sequence
      </Button>
    </div>
  )
}
