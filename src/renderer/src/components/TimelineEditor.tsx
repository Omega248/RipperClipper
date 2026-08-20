import { useEffect, useMemo, useRef, useState } from 'react'
import { activeVideoItemAt, timelineDurationSeconds } from '@shared/timeline'
import { clipRangeInPov } from '@shared/povMapping'
import { povLabel } from '@shared/pov'
import { formatDuration, formatTimecode } from '@shared/time'
import type { TimelineItem, TimelineTrack, VodSource } from '@shared/types'
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
 */

const MIN_PX_PER_SECOND = 4
const MAX_PX_PER_SECOND = 120
const DEFAULT_PX_PER_SECOND = 24
const TRACK_HEIGHT = 56
const MIN_ITEM_SECONDS = 0.1
/** How close, in screen pixels, an edge has to get before it snaps. */
const SNAP_PX = 10

type TrimSide = 'start' | 'end'
interface DragPreview {
  itemId: string
  side: TrimSide
  deltaSeconds: number
}
interface MovePreview {
  itemId: string
  trackId: string
  deltaSeconds: number
}

export default function TimelineEditor({
  onExport,
  onWatchSource
}: {
  onExport: () => void
  /**
   * Builds (or reuses, if a prefetch already did) a local instantly-playable
   * copy of a POV range — the Editor's actual media source, the same way a
   * normal editor plays from ingested proxies rather than re-streaming the
   * original on every cut. Called silently on every POV swap; a miss just
   * falls back to the live stream, same as before this existed.
   */
  onWatchSource: (
    target: { startSeconds: number; endSeconds: number },
    opts: { silent: true }
  ) => Promise<void>
}): JSX.Element {
  const project = useStore((s) => s.project)
  const ensureTimeline = useStore((s) => s.ensureTimeline)
  const addTimelineTrack = useStore((s) => s.addTimelineTrack)
  const removeTimelineTrack = useStore((s) => s.removeTimelineTrack)
  const patchTimelineTrack = useStore((s) => s.patchTimelineTrack)
  const addTimelineItem = useStore((s) => s.addTimelineItem)
  const moveTimelineItem = useStore((s) => s.moveTimelineItem)
  const trimTimelineItem = useStore((s) => s.trimTimelineItem)
  const splitTimelineItem = useStore((s) => s.splitTimelineItem)
  const deleteTimelineItem = useStore((s) => s.deleteTimelineItem)
  const duplicateTimelineItem = useStore((s) => s.duplicateTimelineItem)
  const selectedItemId = useStore((s) => s.selectedTimelineItemId)
  const selectTimelineItem = useStore((s) => s.selectTimelineItem)
  const playhead = useStore((s) => s.timelinePlayheadSeconds)
  const setTimelinePlayhead = useStore((s) => s.setTimelinePlayhead)
  const ripple = useStore((s) => s.timelineRippleDelete)
  const setTimelineRippleDelete = useStore((s) => s.setTimelineRippleDelete)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const currentTime = useStore((s) => s.currentTime)
  const playing = useStore((s) => s.playing)

  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SECOND)
  const [trim, setTrim] = useState<DragPreview | null>(null)
  const [move, setMove] = useState<MovePreview | null>(null)
  // Which item is currently driving the picture — not derivable from
  // `activeSourceId` alone, since two items on different tracks can share a
  // POV. This is what playback advances and what a cut compares against.
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const laneRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const bodyRef = useRef<HTMLDivElement>(null)

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

  // Zoom follows the sequence: whenever it gets longer or shorter (an item is
  // added, trimmed, split, or removed) or the panel itself is resized, the
  // whole thing is refit into view — so there's never a manual "zoom to fit"
  // step between editing and seeing the result.
  useEffect(() => {
    const body = bodyRef.current
    if (!body || durationSeconds <= 0) return
    const fit = (): void => {
      const laneWidth = body.clientWidth - 172
      if (laneWidth <= 0) return
      const target = laneWidth / durationSeconds
      setPxPerSecond(Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, target)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(body)
    return () => ro.disconnect()
  }, [durationSeconds])

  /** Show the frame the playhead is now on: whichever POV is on top, at the equivalent point in its own source. */
  const watch = (seconds: number): void => {
    setTimelinePlayhead(seconds)
    if (!timeline) return
    const active = activeVideoItemAt(timeline, seconds)
    const changedItem = active?.id !== activeItemId
    setActiveItemId(active?.id ?? null)
    if (!active) return
    const localSeconds = active.sourceStartSeconds + (seconds - active.timelineStartSeconds)
    setActiveSource(active.sourceId)
    playerBus.seek(localSeconds)
    // Only worth asking for on an actual cut — a click within the same item
    // is a plain seek, which the already-attached player handles on its own.
    if (changedItem) {
      void onWatchSource(
        { startSeconds: active.sourceStartSeconds, endSeconds: active.sourceEndSeconds },
        { silent: true }
      )
    }
  }

  // The picture defaults to whatever POV happens to be active from earlier
  // browsing. The moment there's a sequence to play, it should show the
  // sequence's own start instead — otherwise pressing Play plays the wrong
  // thing until the ruler is clicked once.
  useEffect(() => {
    if (activeItemId || !timeline || timeline.items.length === 0) return
    watch(0)
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
    const next = activeVideoItemAt(timeline, derived)
    if (next) {
      setTimelinePlayhead(Math.max(0, derived))
      if (next.id !== active.id) watch(derived)
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
      watch(upcoming.timelineStartSeconds)
      return
    }
    playerBus.pause()
    watch(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, playing])

  const widthFor = (item: TimelineItem): number => {
    let duration = item.timelineEndSeconds - item.timelineStartSeconds
    if (trim?.itemId === item.id) {
      duration = trim.side === 'start' ? duration - trim.deltaSeconds : duration + trim.deltaSeconds
    }
    return Math.max(4, duration * pxPerSecond)
  }

  const leftFor = (item: TimelineItem): number => {
    let start = item.timelineStartSeconds
    if (trim?.itemId === item.id && trim.side === 'start') start += trim.deltaSeconds
    if (move?.itemId === item.id) start += move.deltaSeconds
    return Math.max(0, start) * pxPerSecond
  }

  /**
   * Where edges snap to: 0, the playhead, and every other item's own start
   * and end — so two clips dragged near each other land exactly flush, with
   * no sliver of a gap between them, the same way a real NLE's magnetic
   * timeline behaves. `excludeItemId` leaves out the item being dragged so
   * it never snaps to its own edge.
   */
  const snapPoints = (excludeItemId: string | null): number[] => {
    const points = new Set<number>([0, playhead])
    if (timeline) {
      for (const it of timeline.items) {
        if (it.id === excludeItemId) continue
        points.add(it.timelineStartSeconds)
        points.add(it.timelineEndSeconds)
      }
    }
    return [...points]
  }

  const nearestSnap = (value: number, points: number[]): number | null => {
    const tolerance = SNAP_PX / pxPerSecond
    let best: number | null = null
    let bestDist = tolerance
    for (const p of points) {
      const d = Math.abs(p - value)
      if (d <= bestDist) {
        bestDist = d
        best = p
      }
    }
    return best
  }

  /** Snaps whichever edge of a `[start, start+duration)` span is closer to a snap point. */
  const snapStart = (rawStart: number, duration: number, excludeItemId: string | null): number => {
    const points = snapPoints(excludeItemId)
    const snappedStart = nearestSnap(rawStart, points)
    const snappedEnd = nearestSnap(rawStart + duration, points)
    if (snappedStart !== null && snappedEnd !== null) {
      return Math.abs(snappedStart - rawStart) <= Math.abs(snappedEnd - duration - rawStart)
        ? snappedStart
        : snappedEnd - duration
    }
    if (snappedStart !== null) return snappedStart
    if (snappedEnd !== null) return snappedEnd - duration
    return rawStart
  }

  const beginTrim = (item: TimelineItem, side: TrimSide) => (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    selectTimelineItem(item.id)
    const startX = e.clientX
    const move = (ev: PointerEvent): void => {
      const deltaSeconds = (ev.clientX - startX) / pxPerSecond
      setTrim({ itemId: item.id, side, deltaSeconds })
    }
    const up = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      const deltaSeconds = (ev.clientX - startX) / pxPerSecond
      setTrim(null)
      if (Math.abs(deltaSeconds) < 0.02) return
      const raw =
        side === 'start' ? item.timelineStartSeconds + deltaSeconds : item.timelineEndSeconds + deltaSeconds
      const boundary = nearestSnap(raw, snapPoints(item.id)) ?? raw
      trimTimelineItem(item.id, side, Math.max(0, boundary))
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const beginMove = (item: TimelineItem) => (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.titem-trim')) return
    e.preventDefault()
    selectTimelineItem(item.id)
    const startX = e.clientX
    let overTrackId = item.trackId
    const onMove = (ev: PointerEvent): void => {
      const deltaSeconds = (ev.clientX - startX) / pxPerSecond
      // Which track lane is the pointer over now, among tracks of the same kind.
      for (const [trackId, el] of laneRefs.current) {
        const track = tracks.find((t) => t.id === trackId)
        if (!track || track.kind !== item.kind) continue
        const box = el.getBoundingClientRect()
        if (ev.clientY >= box.top && ev.clientY <= box.bottom) {
          overTrackId = trackId
          break
        }
      }
      setMove({ itemId: item.id, trackId: overTrackId, deltaSeconds })
    }
    const onUp = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      const deltaSeconds = (ev.clientX - startX) / pxPerSecond
      setMove(null)
      const duration = item.timelineEndSeconds - item.timelineStartSeconds
      const rawStart = Math.max(0, item.timelineStartSeconds + deltaSeconds)
      const nextStart = Math.max(0, snapStart(rawStart, duration, item.id))
      if (Math.abs(deltaSeconds) >= 0.02 || overTrackId !== item.trackId) {
        moveTimelineItem(item.id, overTrackId, nextStart)
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const onDropOnTrack = (track: TimelineTrack) => (e: React.DragEvent): void => {
    e.preventDefault()
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw || !project) return
    const payload = JSON.parse(raw) as ClipPovDragPayload
    const clip = project.clips.find((c) => c.id === payload.clipId)
    const source = project.sources.find((s) => s.id === payload.povId)
    if (!clip || !source) return
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const rawDropSeconds = Math.max(0, (e.clientX - box.left) / pxPerSecond)

    // The POV's own range for this clip — the picture and the sound share
    // it, since both come from the same recording.
    const local = clip.povMappings?.find((m) => m.sourceId === source.id)
    const sourceStart = local ? local.vodStartSeconds : clip.startSeconds
    const sourceEnd = local ? local.vodEndSeconds : clip.endSeconds
    if (sourceEnd - sourceStart < MIN_ITEM_SECONDS) return

    // Dropped near another item's edge — most often the tail of the POV
    // that was covering the moment before this one — lands flush against it
    // instead of leaving a gap or a sliver of overlap, so this is also what
    // makes "picks up right where the last POV left off" the natural result
    // of just dragging it into roughly the right place.
    const dropSeconds = Math.max(0, snapStart(rawDropSeconds, sourceEnd - sourceStart, null))

    addTimelineItem({
      trackId: track.id,
      kind: track.kind,
      sourceId: source.id,
      sourceClipId: clip.id,
      sourceStartSeconds: sourceStart,
      sourceEndSeconds: sourceEnd,
      timelineStartSeconds: dropSeconds,
      timelineEndSeconds: dropSeconds + (sourceEnd - sourceStart)
    })
  }

  if (!project) return <EmptyState icon="scissors" title="Open or create a project to build a sequence." />
  // One render behind `ensureTimeline()` at most — the effect above fires
  // immediately after this first paint.
  if (!timeline) return <></>

  const hasItems = timeline.items.length > 0
  const selectedItem = timeline.items.find((i) => i.id === selectedItemId) ?? null

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

  return (
    <div className="timeline-editor">
      <TimelineToolbar
        pxPerSecond={pxPerSecond}
        setPxPerSecond={setPxPerSecond}
        ripple={ripple}
        setRipple={setTimelineRippleDelete}
        durationLabel={formatDuration(durationSeconds)}
        onAddVideoTrack={() => addTimelineTrack('video')}
        onAddAudioTrack={() => addTimelineTrack('audio')}
        onSplit={() => selectedItemId && splitTimelineItem(selectedItemId, playhead)}
        onDelete={() => selectedItemId && deleteTimelineItem(selectedItemId, ripple)}
        onDuplicate={() => selectedItemId && duplicateTimelineItem(selectedItemId)}
        canEditSelection={Boolean(selectedItemId)}
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
        <div className="timeline-playhead" style={{ left: 160 + playhead * pxPerSecond }} />
        <div
          className="timeline-ruler"
          style={{ marginLeft: 160, minWidth: Math.max(400, durationSeconds * pxPerSecond) }}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect()
            watch(Math.max(0, (e.clientX - box.left) / pxPerSecond))
          }}
        />

        <div className="timeline-track-list">
          {tracks.map((track) => {
            const items = timeline.items.filter((i) => i.trackId === track.id)
            return (
              <div className="timeline-track-row" key={track.id} style={{ height: TRACK_HEIGHT }}>
                <div className="timeline-track-header">
                  <Icon name={track.kind === 'video' ? 'grid' : 'waveform'} />
                  <span className="ellipsis">{track.name}</span>
                  <span className="spacer" />
                  {track.kind === 'video' ? (
                    <IconButton
                      icon={track.hidden ? 'volume-off' : 'volume'}
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
                    icon={track.locked ? 'save' : 'open'}
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

                <div
                  className="timeline-track-lane"
                  ref={(el) => {
                    if (el) laneRefs.current.set(track.id, el)
                    else laneRefs.current.delete(track.id)
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDropOnTrack(track)}
                >
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className={`titem${item.id === selectedItemId ? ' on' : ''}`}
                      style={{ left: leftFor(item), width: widthFor(item) }}
                      onClick={(e) => {
                        e.stopPropagation()
                        selectTimelineItem(item.id)
                      }}
                      onPointerDown={beginMove(item)}
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

const filmstripCache = new Map<string, string[]>()
const waveformCache = new Map<string, number[]>()

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
  pxPerSecond: number
  setPxPerSecond: (v: number) => void
  ripple: boolean
  setRipple: (v: boolean) => void
  durationLabel: string
  onAddVideoTrack: () => void
  onAddAudioTrack: () => void
  onSplit: () => void
  onDelete: () => void
  onDuplicate: () => void
  canEditSelection: boolean
  onSeparateAudio: () => void
  canSeparateAudio: boolean
  onExport: () => void
  canExport: boolean
}): JSX.Element {
  return (
    <div className="clip-timeline-head">
      <span className="mono">{props.durationLabel} total</span>
      <span className="topbar-divider" />
      <Button size="compact" icon="plus" onClick={props.onAddVideoTrack}>
        Video track
      </Button>
      <Button size="compact" icon="plus" onClick={props.onAddAudioTrack}>
        Audio track
      </Button>
      <span className="topbar-divider" />
      <Button size="compact" icon="scissors" disabled={!props.canEditSelection} onClick={props.onSplit}>
        Split
      </Button>
      <Button size="compact" icon="copy" disabled={!props.canEditSelection} onClick={props.onDuplicate}>
        Duplicate
      </Button>
      <Button size="compact" icon="trash" disabled={!props.canEditSelection} onClick={props.onDelete}>
        Delete
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
      <button
        className={`segmented-item${props.ripple ? ' on' : ''}`}
        aria-pressed={props.ripple}
        onClick={() => props.setRipple(!props.ripple)}
        title="When on, deleting a clip pulls everything after it (on the same track) left to close the gap"
      >
        Ripple
      </button>
      <span className="spacer" />
      <IconButton
        icon="minus"
        size="compact"
        label="Zoom out"
        onClick={() => props.setPxPerSecond(Math.max(MIN_PX_PER_SECOND, props.pxPerSecond / 1.4))}
      />
      <IconButton
        icon="plus"
        size="compact"
        label="Zoom in"
        onClick={() => props.setPxPerSecond(Math.min(MAX_PX_PER_SECOND, props.pxPerSecond * 1.4))}
      />
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
