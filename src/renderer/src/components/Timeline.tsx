import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDuration, formatTimecode, roundMs } from '@shared/time'
import { povCoverage } from '@shared/multiPov'
import { timelineBands } from '@shared/timelineView'
import { povColor } from '@shared/povColors'
import { povLabel } from '@shared/pov'
import type { ClipSegment, Marker } from '@shared/types'
import { useActiveClips, useActiveMarkers, useActiveSource, useStore } from '../store.js'
import { useTimelineFilmstrip } from '../hooks/useTimelineFilmstrip.js'
import MarkersLane from './MarkersLane.js'
import { playerBus } from '../player/controller.js'
import { Button, IconButton, TimeInput } from '../ui/index.js'

const RULER_H = 20
const MARKER_H = 16
const EDGE_GRAB_PX = 6
/** Tallest a single POV row gets; with many angles they share what is left. */
const POV_LANE_MAX_H = 15
/**
 * Shortest a row can be and still carry its name. The row is drawn one pixel
 * shorter than the lane it sits in, so testing the drawn height against 10
 * silently dropped every label at a 10px lane — which is what nine angles in a
 * normal-height strip works out at.
 */
const LABEL_MIN_H = 9
/**
 * The clips lane never gets squeezed below this by the POV rows above it.
 *
 * A clip is grabbed by its edges, and an edge is `EDGE_GRAB_PX` wide in a lane
 * this tall — so this is not decoration, it is how precisely a range can be
 * trimmed by hand.
 */
const MIN_CLIP_LANE_H = 84
/** The filmstrip band under the ruler, when the strip is tall enough for one. */
const FILM_H = 64
/** Canvas height with no POV rows. */
const BASE_CANVAS_H = 200
/** However many angles are loaded, the rows together never exceed this. */
const MAX_POV_BAND_H = 132

type DragKind =
  | { type: 'none' }
  | { type: 'seek' }
  | { type: 'pan'; startX: number; startView: number }
  | { type: 'select'; anchorSeconds: number }
  | { type: 'clip-start'; clipId: string }
  | { type: 'clip-end'; clipId: string }
  | { type: 'clip-move'; clipId: string; grabOffset: number }
  | { type: 'in-handle' }
  | { type: 'out-handle' }

/**
 * Canvas timeline. Adaptive tick spacing keeps a 10-hour VOD readable while
 * still allowing millisecond-level work when zoomed in.
 */
export default function Timeline(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragKind>({ type: 'none' })
  const movedRef = useRef(false)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const [hoverPovId, setHoverPovId] = useState<string | null>(null)
  /**
   * The room the strip is giving the canvas. The wrap is `flex: 1 1 0`, so its
   * height comes from the strip and never from the canvas inside it — which is
   * what makes measuring it here safe rather than circular.
   */
  const [availableHeight, setAvailableHeight] = useState(0)

  const clips = useActiveClips()
  const markers = useActiveMarkers()
  const duration = useStore((s) => s.duration)
  const currentTime = useStore((s) => s.currentTime)
  const viewStart = useStore((s) => s.viewStart)
  const viewSpan = useStore((s) => s.viewSpan)
  const inPoint = useStore((s) => s.inPoint)
  const outPoint = useStore((s) => s.outPoint)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const setView = useStore((s) => s.setView)
  const zoomBy = useStore((s) => s.zoomBy)
  const setInPoint = useStore((s) => s.setInPoint)
  const setOutPoint = useStore((s) => s.setOutPoint)
  const selectClip = useStore((s) => s.selectClip)
  const patchClip = useStore((s) => s.patchClip)
  const pushHistory = useStore((s) => s.pushHistory)
  const followPlayhead = useStore((s) => s.settings?.ui.timelineFollowPlayhead ?? true)
  const sources = useStore((s) => s.project?.sources)
  const activeSourceId = useStore((s) => s.activeSourceId)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const requestCreateClip = useStore((s) => s.requestCreateClip)
  const activeSource = useActiveSource()
  const loopSelection = useStore((s) => s.loopSelection)
  const setLoopSelection = useStore((s) => s.setLoopSelection)

  /**
   * Where every angle's recording sits on this angle's ruler.
   *
   * Recomputed only when the POVs themselves change — not on the playhead,
   * which moves several times a second and never moves a recording.
   */
  const coverage = useMemo(() => {
    const list = sources ?? []
    if (list.length < 2) return []
    return povCoverage(list, list.find((s) => s.id === activeSourceId) ?? list[0])
  }, [sources, activeSourceId])

  // Read inside `draw` for lane labels; a ref keeps the canvas from
  // re-subscribing every time an unrelated part of the project changes.
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources

  const size = useRef({ width: 800, height: 132 })

  /** The POV band's geometry, shared by the drawing and the hit-testing. */
  const povBand = useCallback(
    (height: number) =>
      timelineBands(height, coverage.length, {
        rulerHeight: RULER_H,
        markerHeight: MARKER_H,
        minClipHeight: MIN_CLIP_LANE_H,
        maxLaneHeight: POV_LANE_MAX_H,
        filmHeight: FILM_H
      }),
    [coverage]
  )

  /**
   * The canvas is the strip.
   *
   * It used to ask for only as much height as its rows needed and stop there,
   * which left the rest of the strip looking like timeline and behaving like
   * nothing: a click below the canvas reaches no element, so half of what
   * looks like the timeline could not be clicked to seek. `timelineBands`
   * already shares out whatever height it is given — the angle rows thin down
   * and the clips lane keeps its floor — so there is nothing to gain by
   * leaving the space empty, and a dead strip to lose.
   *
   * `wanted` is only the estimate used for the first paint, before the strip
   * has been measured.
   */
  const wanted =
    BASE_CANVAS_H +
    (coverage.length === 0 ? 0 : Math.min(MAX_POV_BAND_H, coverage.length * POV_LANE_MAX_H) + 6)
  const canvasHeight = availableHeight > 0 ? availableHeight : wanted

  /*
   * The frames drawn under the ruler.
   *
   * Asked for by the same geometry the canvas draws with, so the band is only
   * fetched when there is actually room to show it — see `timelineBands`,
   * which drops the filmstrip before it lets the clips lane go thin.
   */
  const film = useTimelineFilmstrip(
    activeSource,
    viewStart,
    viewSpan,
    size.current.width,
    povBand(canvasHeight).filmHeight > 0 && duration > 0
  )

  const timeToX = useCallback(
    (seconds: number): number => ((seconds - viewStart) / viewSpan) * size.current.width,
    [viewStart, viewSpan]
  )
  const xToTime = useCallback(
    (x: number): number => viewStart + (x / size.current.width) * viewSpan,
    [viewStart, viewSpan]
  )

  // ------------------------------------------------------------- render ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    /*
     * Measured on the canvas, never on the wrap around it.
     *
     * These two numbers are the coordinate space everything is drawn in *and*
     * — through `size.current` — the space every pointer position is
     * hit-tested in. The pointer's is the canvas's own box, so the drawing's
     * has to be as well. Taking the height from the wrap instead meant the
     * canvas drew a 275px-tall timeline inside a 140px element: the whole
     * strip rendered at half scale, and every hit test below the ruler looked
     * for the clips lane at a y no click could ever reach. Marking a range by
     * dragging did nothing at all.
     */
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) return
    size.current = { width, height }
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const css = getComputedStyle(document.documentElement)
    const c = (name: string): string =>
      css.getPropertyValue(name).trim() || 'transparent'

    const band = povBand(height)
    const laneTop = band.clipTop
    const laneHeight = band.clipHeight

    // background
    ctx.fillStyle = c('--surface-raised')
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = c('--surface')
    ctx.fillRect(0, laneTop, width, laneHeight)

    if (duration <= 0) {
      ctx.fillStyle = c('--text-tertiary')
      ctx.font = '12px "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText('Load a VOD to start marking ranges', width / 2, height / 2)
      ctx.textAlign = 'left'
      return
    }

    // ruler
    const { step, minor } = tickStep(viewSpan, width)
    ctx.strokeStyle = c('--border-subtle')
    ctx.fillStyle = c('--text-tertiary')
    ctx.font = '10px ui-monospace, monospace'
    ctx.textBaseline = 'alphabetic'
    ctx.beginPath()
    const firstMinor = Math.floor(viewStart / minor) * minor
    for (let t = firstMinor; t <= viewStart + viewSpan; t += minor) {
      const x = Math.round(timeToXLocal(t)) + 0.5
      ctx.moveTo(x, RULER_H - 4)
      ctx.lineTo(x, RULER_H)
    }
    ctx.stroke()

    ctx.strokeStyle = c('--border-strong')
    ctx.beginPath()
    const firstMajor = Math.floor(viewStart / step) * step
    for (let t = firstMajor; t <= viewStart + viewSpan; t += step) {
      const x = Math.round(timeToXLocal(t)) + 0.5
      ctx.moveTo(x, 0)
      ctx.lineTo(x, RULER_H)
      if (t >= 0) {
        ctx.fillText(labelFor(t, step), x + 3, RULER_H - 6)
      }
    }
    ctx.stroke()

    ctx.strokeStyle = c('--border-subtle')
    ctx.beginPath()
    ctx.moveTo(0, RULER_H + 0.5)
    ctx.lineTo(width, RULER_H + 0.5)
    ctx.stroke()

    /*
     * The filmstrip.
     *
     * Frames arrive one at a time and the band is drawn from whatever has
     * arrived, so it fills in rather than appearing all at once — and a
     * broadcast the source will not give frames for simply stays dark instead
     * of blocking the timeline behind a spinner.
     *
     * Each frame is drawn cropped-to-fill its slot: a letterboxed thumbnail in
     * a 64px band is mostly black bars, and the point of the band is to show
     * what changed between one slot and the next.
     */
    if (band.filmHeight > 0) {
      ctx.fillStyle = c('--background')
      ctx.fillRect(0, band.filmTop, width, band.filmHeight)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, band.filmTop, width, band.filmHeight)
      ctx.clip()
      const slotPx = (film.step / viewSpan) * width
      for (const [seconds, img] of film.frames) {
        if (!img.naturalWidth) continue
        const x = timeToXLocal(seconds)
        if (x > width || x + slotPx < 0) continue
        const scale = Math.max(slotPx / img.naturalWidth, band.filmHeight / img.naturalHeight)
        const drawW = img.naturalWidth * scale
        const drawH = img.naturalHeight * scale
        ctx.drawImage(
          img,
          x + (slotPx - drawW) / 2,
          band.filmTop + (band.filmHeight - drawH) / 2,
          drawW,
          drawH
        )
      }
      ctx.restore()
      // A hairline between slots, so twelve frames read as a strip of moments
      // rather than one smeared picture.
      ctx.strokeStyle = c('--background')
      ctx.beginPath()
      for (const seconds of film.frames.keys()) {
        const x = Math.round(timeToXLocal(seconds)) + 0.5
        ctx.moveTo(x, band.filmTop)
        ctx.lineTo(x, band.filmTop + band.filmHeight)
      }
      ctx.stroke()
      ctx.strokeStyle = c('--border-subtle')
      ctx.beginPath()
      ctx.moveTo(0, band.filmTop + band.filmHeight + 0.5)
      ctx.lineTo(width, band.filmTop + band.filmHeight + 0.5)
      ctx.stroke()
    }

    /*
     * Every angle's recording, one thin row each.
     *
     * The single change that makes a six-hour broadcast readable: without it
     * this whole band is a flat grey rectangle that says nothing about what
     * is in the VOD or who else was rolling. A row that cannot be placed is
     * drawn as a hatched strip rather than left blank, because "this angle
     * has no timing yet" is information too.
     */
    if (coverage.length > 0 && band.povLaneHeight > 0) {
      coverage.forEach((span, index) => {
        const y = band.povTop + index * band.povLaneHeight
        const h = Math.max(2, band.povLaneHeight - 1)

        const source = sourcesRef.current?.find((s) => s.id === span.sourceId)
        const label = source ? povLabel(source) : ''

        if (span.startSeconds === null || span.endSeconds === null) {
          ctx.fillStyle = c('--surface')
          ctx.fillRect(0, y, width, h)
          ctx.strokeStyle = c('--border-subtle')
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.moveTo(0, Math.round(y + h / 2) + 0.5)
          ctx.lineTo(width, Math.round(y + h / 2) + 0.5)
          ctx.stroke()
          ctx.setLineDash([])
          // Naming it matters most here: a nameless dashed row looks like a
          // rendering fault, when what it means is "this angle has no timing
          // yet, so nobody can say where it belongs" — which is actionable.
          if (h >= LABEL_MIN_H && label !== '') {
            ctx.fillStyle = c('--text-tertiary')
            ctx.font = '10px "Segoe UI", system-ui, sans-serif'
            ctx.textBaseline = 'middle'
            ctx.fillText(`${label} — not aligned yet`, 4, y + h / 2)
          }
          return
        }

        const x1 = Math.max(-2, timeToXLocal(span.startSeconds))
        const x2 = Math.min(width + 2, timeToXLocal(span.endSeconds))
        ctx.fillStyle = c('--surface')
        ctx.fillRect(0, y, width, h)
        ctx.globalAlpha = span.isLeader ? 1 : 0.62
        ctx.fillStyle = povColor(span.sourceId)
        ctx.fillRect(x1, y, Math.max(2, x2 - x1), h)
        ctx.globalAlpha = 1

        // A broadcast still going has no end yet; fade the trailing edge
        // rather than drawing a wall the recording does not actually have.
        if (span.isLive && x2 < width) {
          const fade = ctx.createLinearGradient(x2 - 24, 0, x2, 0)
          fade.addColorStop(0, povColor(span.sourceId))
          fade.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.globalAlpha = 0.62
          ctx.fillStyle = fade
          ctx.fillRect(Math.max(x1, x2 - 24), y, 24, h)
          ctx.globalAlpha = 1
        }

        // The angle you are actually watching, marked as such — nine coloured
        // rows otherwise give no clue which one the picture is coming from.
        if (span.isLeader) {
          ctx.strokeStyle = c('--accent')
          ctx.lineWidth = 2
          ctx.strokeRect(0, Math.round(y) + 1, width, h - 2)
          ctx.lineWidth = 1
        }

        if (h >= LABEL_MIN_H && label !== '') {
          ctx.save()
          ctx.beginPath()
          ctx.rect(0, y, width, h)
          ctx.clip()
          ctx.fillStyle = c('--data-clip-text')
          ctx.font = `${span.isLeader ? 'bold ' : ''}10px "Segoe UI", system-ui, sans-serif`
          ctx.textBaseline = 'middle'
          ctx.fillText(label, Math.max(4, x1 + 4), y + h / 2)
          ctx.restore()
        }
      })
      ctx.strokeStyle = c('--border-subtle')
      ctx.beginPath()
      ctx.moveTo(0, Math.round(band.povTop + band.povTotal - 2) + 0.5)
      ctx.lineTo(width, Math.round(band.povTop + band.povTotal - 2) + 0.5)
      ctx.stroke()
    }

    // Nothing marked and nothing clipped: say what to do here, in the empty
    // space that would otherwise just be grey.
    if (clips.length === 0 && inPoint === null && outPoint === null && laneHeight > 24) {
      ctx.fillStyle = c('--text-tertiary')
      ctx.font = '12px "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(
        'Shift-drag here to mark a range — or press I where it starts and O where it ends',
        width / 2,
        laneTop + laneHeight / 2
      )
      ctx.textAlign = 'left'
    }

    // pending in/out selection
    if (inPoint !== null || outPoint !== null) {
      const a = inPoint ?? outPoint ?? 0
      const b = outPoint ?? inPoint ?? 0
      const x1 = timeToXLocal(Math.min(a, b))
      const x2 = timeToXLocal(Math.max(a, b))
      ctx.fillStyle = 'rgba(194,24,91,0.14)'
      ctx.fillRect(x1, laneTop, Math.max(1, x2 - x1), laneHeight)
      ctx.strokeStyle = c('--accent')
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(Math.round(x1) + 0.5, laneTop)
      ctx.lineTo(Math.round(x1) + 0.5, laneTop + laneHeight)
      ctx.moveTo(Math.round(x2) + 0.5, laneTop)
      ctx.lineTo(Math.round(x2) + 0.5, laneTop + laneHeight)
      ctx.stroke()
      ctx.setLineDash([])

      // Solid grips at both edges — a dashed line does not read as something
      // you can take hold of, and both edges are draggable.
      ctx.fillStyle = c('--accent')
      if (inPoint !== null) ctx.fillRect(Math.round(x1) - 2, laneTop, 4, Math.min(14, laneHeight))
      if (outPoint !== null) {
        ctx.fillRect(Math.round(x2) - 2, laneTop + laneHeight - Math.min(14, laneHeight), 4, Math.min(14, laneHeight))
      }
    }

    // clips
    const rowCount = Math.max(1, Math.min(4, clips.length === 0 ? 1 : rowsNeeded(clips)))
    const rowHeight = laneHeight / rowCount
    clips.forEach((clip, index) => {
      const row = index % rowCount
      const x1 = timeToXLocal(clip.startSeconds)
      const x2 = timeToXLocal(clip.endSeconds)
      const w = Math.max(2, x2 - x1)
      const y = laneTop + row * rowHeight + 2
      const h = rowHeight - 4
      const selected = clip.id === selectedClipId

      ctx.fillStyle = selected ? c('--data-clip-selected') : c('--data-clip')
      ctx.fillRect(x1, y, w, h)
      ctx.strokeStyle = c('--data-clip-edge')
      ctx.lineWidth = selected ? 2 : 1
      ctx.strokeRect(Math.round(x1) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1)
      ctx.lineWidth = 1

      // Status is communicated by a glyph as well as colour.
      if (w > 40) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x1 + 4, y, w - 8, h)
        ctx.clip()
        ctx.fillStyle = c('--data-clip-text')
        ctx.font = '11px "Segoe UI", system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${statusGlyph(clip)}${index + 1}. ${clip.name}`, x1 + 6, y + h / 2)
        ctx.restore()
      }
    })

    // markers
    const markerY = height - MARKER_H
    ctx.fillStyle = c('--surface-raised')
    ctx.fillRect(0, markerY, width, MARKER_H)
    markers.forEach((marker) => {
      const x = timeToXLocal(marker.timeSeconds)
      if (x < -20 || x > width + 20) return
      ctx.fillStyle = c(markerColor(marker))
      ctx.beginPath()
      ctx.moveTo(x, markerY + 2)
      ctx.lineTo(x + 5, markerY + 8)
      ctx.lineTo(x, markerY + 14)
      ctx.lineTo(x - 5, markerY + 8)
      ctx.closePath()
      ctx.fill()
      if (viewSpan < 3600) {
        ctx.fillStyle = c('--text-secondary')
        ctx.font = '10px "Segoe UI", system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillText(marker.label, x + 8, markerY + 8)
      }
    })

    // playhead
    const px = Math.round(timeToXLocal(currentTime)) + 0.5
    ctx.strokeStyle = c('--accent')
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, height)
    ctx.stroke()
    ctx.fillStyle = c('--accent')
    ctx.beginPath()
    ctx.moveTo(px - 5, 0)
    ctx.lineTo(px + 5, 0)
    ctx.lineTo(px, 7)
    ctx.closePath()
    ctx.fill()

    function timeToXLocal(seconds: number): number {
      return ((seconds - viewStart) / viewSpan) * width
    }
  }, [
    clips,
    markers,
    currentTime,
    duration,
    viewStart,
    viewSpan,
    inPoint,
    outPoint,
    selectedClipId,
    coverage,
    povBand,
    // The band repaints as frames arrive; `film` is a fresh object each render
    // and its `frames` map is what actually changed.
    film
  ])

  useEffect(() => {
    draw()
  }, [draw])

  /*
   * Observe the element once, not once per frame.
   *
   * `draw` changes identity on every playhead tick, so depending on it here
   * tore down and rebuilt the ResizeObserver four times a second — and
   * `observe()` fires immediately, which forced a second full canvas repaint
   * on every one of those. The observer only ever needs the latest `draw`,
   * which a ref gives it without re-subscribing.
   */
  const drawRef = useRef(draw)
  drawRef.current = draw

  useEffect(() => {
    const onResize = (): void => {
      const wrap = wrapRef.current
      if (wrap) setAvailableHeight(wrap.clientHeight)
      drawRef.current()
    }
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
    }
  }, [])

  // Keep the playhead visible while playing.
  useEffect(() => {
    if (!followPlayhead) return
    if (currentTime < viewStart || currentTime > viewStart + viewSpan) {
      setView(currentTime - viewSpan / 3, viewSpan)
    }
  }, [currentTime, viewStart, viewSpan, followPlayhead, setView])

  // ------------------------------------------------------- interaction ---
  /** Which POV row the pointer is over, if any. */
  const povLaneAt = useCallback(
    (y: number): string | null => {
      const band = povBand(size.current.height)
      if (band.povLaneHeight <= 0) return null
      const index = Math.floor((y - band.povTop) / band.povLaneHeight)
      if (y < band.povTop || index < 0 || index >= coverage.length) return null
      return coverage[index].sourceId
    },
    [coverage, povBand]
  )

  const hitTest = useCallback(
    (x: number, y: number): DragKind => {
      const band = povBand(size.current.height)
      const laneTop = band.clipTop
      const laneHeight = band.clipHeight
      if (y < laneTop || y > laneTop + laneHeight) return { type: 'none' }

      // The marked range's own edges outrank a clip underneath them: the
      // selection is the thing being worked on right now.
      if (inPoint !== null && Math.abs(x - timeToX(inPoint)) <= EDGE_GRAB_PX) return { type: 'in-handle' }
      if (outPoint !== null && Math.abs(x - timeToX(outPoint)) <= EDGE_GRAB_PX) return { type: 'out-handle' }

      const rowCount = Math.max(1, Math.min(4, clips.length === 0 ? 1 : rowsNeeded(clips)))
      const rowHeight = laneHeight / rowCount
      const row = Math.floor((y - laneTop) / rowHeight)

      for (let i = clips.length - 1; i >= 0; i--) {
        if (i % rowCount !== row) continue
        const clip = clips[i]
        // Only the POV the range was defined in can drag it: elsewhere these
        // numbers are a projection, and dragging them would silently rewrite
        // the event time through someone else's clock.
        if (!clip.authored) continue
        const x1 = timeToX(clip.startSeconds)
        const x2 = timeToX(clip.endSeconds)
        if (x < x1 - EDGE_GRAB_PX || x > x2 + EDGE_GRAB_PX) continue
        if (Math.abs(x - x1) <= EDGE_GRAB_PX) return { type: 'clip-start', clipId: clip.id }
        if (Math.abs(x - x2) <= EDGE_GRAB_PX) return { type: 'clip-end', clipId: clip.id }
        return {
          type: 'clip-move',
          clipId: clip.id,
          grabOffset: xToTime(x) - clip.startSeconds
        }
      }
      return { type: 'none' }
    },
    [clips, timeToX, xToTime, inPoint, outPoint, povBand]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    e.currentTarget.setPointerCapture(e.pointerId)
    movedRef.current = false

    if (e.button === 1 || e.altKey) {
      dragRef.current = { type: 'pan', startX: x, startView: viewStart }
      return
    }

    if (y <= RULER_H) {
      dragRef.current = { type: 'seek' }
      seekTo(xToTime(x))
      return
    }

    /*
     * Clicking an angle's row switches to it — the fastest way there is to
     * ask "what did this look like from over there", and the row is already
     * showing you that the angle was rolling at that moment.
     */
    const lane = povLaneAt(y)
    if (lane !== null) {
      seekTo(xToTime(x))
      if (lane !== activeSourceId) setActiveSource(lane)
      dragRef.current = { type: 'none' }
      return
    }

    const hit = hitTest(x, y)
    if (hit.type !== 'none') {
      if ('clipId' in hit) {
        selectClip(hit.clipId)
        // Once, here, rather than on every pointer event of the drag. Undo
        // then lands where the drag began. See `patchClip`'s `history` option.
        pushHistory()
      }
      dragRef.current = hit
      return
    }

    if (e.shiftKey) {
      const anchor = xToTime(x)
      setInPoint(anchor)
      setOutPoint(anchor)
      dragRef.current = { type: 'select', anchorSeconds: anchor }
      return
    }

    dragRef.current = { type: 'seek' }
    seekTo(xToTime(x))
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setHoverTime(xToTime(x))
    setHoverPovId(povLaneAt(y))
    const drag = dragRef.current
    if (drag.type === 'none') {
      const hit = hitTest(x, y)
      e.currentTarget.style.cursor =
        hit.type === 'clip-start' ||
        hit.type === 'clip-end' ||
        hit.type === 'in-handle' ||
        hit.type === 'out-handle'
          ? 'ew-resize'
          : hit.type === 'clip-move'
            ? 'grab'
            : povLaneAt(y) !== null
              ? 'pointer'
              : 'crosshair'
      return
    }
    movedRef.current = true

    switch (drag.type) {
      case 'seek':
        seekTo(xToTime(x))
        break
      case 'pan':
        setView(drag.startView - ((x - drag.startX) / size.current.width) * viewSpan, viewSpan)
        break
      case 'select': {
        const t = xToTime(x)
        setInPoint(Math.min(drag.anchorSeconds, t))
        setOutPoint(Math.max(drag.anchorSeconds, t))
        break
      }
      case 'in-handle':
        // Held to the other edge, so dragging one past the other cannot
        // produce an inverted range the rest of the app has to defend against.
        setInPoint(outPoint === null ? xToTime(x) : Math.min(xToTime(x), outPoint - 0.05))
        break
      case 'out-handle':
        setOutPoint(inPoint === null ? xToTime(x) : Math.max(xToTime(x), inPoint + 0.05))
        break
      case 'clip-start': {
        const clip = clips.find((c) => c.id === drag.clipId)
        if (!clip) break
        const value = Math.min(xToTime(x), clip.endSeconds - 0.05)
        patchClip(clip.id, { startSeconds: roundMs(Math.max(0, value)) }, { history: false })
        break
      }
      case 'clip-end': {
        const clip = clips.find((c) => c.id === drag.clipId)
        if (!clip) break
        const value = Math.max(xToTime(x), clip.startSeconds + 0.05)
        patchClip(clip.id, { endSeconds: roundMs(Math.min(duration, value)) }, { history: false })
        break
      }
      case 'clip-move': {
        const clip = clips.find((c) => c.id === drag.clipId)
        if (!clip) break
        const length = clip.endSeconds - clip.startSeconds
        let start = xToTime(x) - drag.grabOffset
        start = Math.max(0, Math.min(duration - length, start))
        patchClip(
          clip.id,
          { startSeconds: roundMs(start), endSeconds: roundMs(start + length) },
          { history: false }
        )
        break
      }
      default:
        break
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = { type: 'none' }
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const anchor = xToTime(e.clientX - rect.left)
    if (e.shiftKey) {
      setView(viewStart + (e.deltaY / 400) * viewSpan, viewSpan)
    } else {
      zoomBy(e.deltaY > 0 ? 1.25 : 0.8, anchor)
    }
  }

  function seekTo(seconds: number): void {
    const clamped = Math.max(0, Math.min(duration, seconds))
    playerBus.seek(clamped)
    useStore.getState().setCurrentTime(clamped)
  }

  const zoomLabel =
    viewSpan >= 3600
      ? `${(viewSpan / 3600).toFixed(1)} h visible`
      : viewSpan >= 60
        ? `${(viewSpan / 60).toFixed(1)} min visible`
        : `${viewSpan.toFixed(1)} s visible`

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-head">
        <strong>Timeline</strong>
        <span className="time">
          {formatTimecode(viewStart, { millis: false })} –{' '}
          {formatTimecode(Math.min(duration, viewStart + viewSpan), { millis: false })}
        </span>
        <span>{duration > 0 ? zoomLabel : 'No VOD loaded'}</span>
        {/* Rows dropped for want of height are said out loud: nine angles
            silently missing from a timeline that showed them a moment ago
            reads as a fault, not as a layout decision. */}
        {coverage.length > 1 && povBand(canvasHeight).povLaneHeight === 0 && (
          <span className="dim">
            {coverage.length} angles — drag the timeline taller to see who covered what
          </span>
        )}
        <span className="spacer" />
        {/* At nine angles the rows are too thin to carry a name, so the row
            under the pointer is named here instead of nowhere. */}
        {hoverPovId !== null && (
          <span className="timeline-hover-pov">
            <span className="timeline-hover-swatch" style={{ background: povColor(hoverPovId) }} />
            {(() => {
              const hovered = sources?.find((s) => s.id === hoverPovId)
              return hovered ? povLabel(hovered) : 'Unknown angle'
            })()}
            {hoverPovId !== activeSourceId && <span className="dim"> — click to watch</span>}
          </span>
        )}
        {hoverTime !== null && duration > 0 && (
          <span className="time dim">{formatTimecode(Math.max(0, hoverTime))}</span>
        )}
        <IconButton icon="plus" size="compact" label="Zoom in (=)" onClick={() => zoomBy(0.6)} />
        <IconButton icon="minus" size="compact" label="Zoom out (-)" onClick={() => zoomBy(1.6)} />
        <Button size="compact" onClick={() => setView(0, Math.max(1, duration))}>
          Fit
        </Button>
      </div>
      <div className="timeline-canvas-wrap" ref={wrapRef}>
        {/* Labelled flags over the canvas, sharing its view window so the two
            can never disagree about where a moment is. */}
        <MarkersLane
          markers={markers}
          viewStart={viewStart}
          viewSpan={viewSpan}
          onSeek={seekTo}
        />
        <canvas
          ref={canvasRef}
          style={{ height: canvasHeight }}
          role="slider"
          tabIndex={0}
          aria-label="VOD timeline. Drag with Shift to mark a selection."
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={formatTimecode(currentTime)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            setHoverTime(null)
            setHoverPovId(null)
          }}
          onWheel={onWheel}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') seekTo(currentTime - (e.shiftKey ? 30 : 5))
            if (e.key === 'ArrowRight') seekTo(currentTime + (e.shiftKey ? 30 : 5))
          }}
        />
      </div>
      <SelectionBar
        inPoint={inPoint}
        outPoint={outPoint}
        duration={duration}
        loop={loopSelection}
        onSetIn={setInPoint}
        onSetOut={setOutPoint}
        onSeek={seekTo}
        onToggleLoop={() => setLoopSelection(!loopSelection)}
        onAddClip={() => requestCreateClip()}
      />
    </section>
  )
}

/**
 * The range being marked, stated once.
 *
 * Mark in, mark out and add-clip used to live in three places at once — the
 * transport, the clip panel's empty state, and a coaching strip — while the
 * range they were building was only ever visible as two small numbers inside
 * two button labels. There was nowhere to read what you had marked, nowhere
 * to correct it by a frame, and nothing tying the buttons to the shaded
 * region on the timeline. This is that one place, directly under the region
 * it describes, and it is also what teaches the flow when nothing is marked
 * yet.
 */
function SelectionBar({
  inPoint,
  outPoint,
  duration,
  loop,
  onSetIn,
  onSetOut,
  onSeek,
  onToggleLoop,
  onAddClip
}: {
  inPoint: number | null
  outPoint: number | null
  duration: number
  loop: boolean
  onSetIn: (seconds: number | null) => void
  onSetOut: (seconds: number | null) => void
  onSeek: (seconds: number) => void
  onToggleLoop: () => void
  onAddClip: () => void
}): JSX.Element | null {
  if (duration <= 0) return null

  if (inPoint === null && outPoint === null) {
    return (
      <div className="selection-bar is-empty">
        <span className="selection-hint">
          <strong>I</strong> marks where a clip starts, <strong>O</strong> where it ends, then{' '}
          <strong>Enter</strong> adds it. Shift-drag on the timeline does all three at once.
        </span>
      </div>
    )
  }

  const complete = inPoint !== null && outPoint !== null && outPoint > inPoint
  const length = complete ? outPoint - inPoint : null

  return (
    <div className="selection-bar">
      <span className="selection-label">Marked range</span>

      <span className="selection-field">
        <span className="selection-field-label">In</span>
        {inPoint === null ? (
          <button className="selection-unset" onClick={() => onSetIn(0)}>
            not set
          </button>
        ) : (
          <TimeInput seconds={inPoint} max={duration} label="Clip start" onCommit={onSetIn} />
        )}
      </span>

      <span className="selection-field">
        <span className="selection-field-label">Out</span>
        {outPoint === null ? (
          <button className="selection-unset" onClick={() => onSetOut(duration)}>
            not set
          </button>
        ) : (
          <TimeInput seconds={outPoint} max={duration} label="Clip end" onCommit={onSetOut} />
        )}
      </span>

      <span className={`selection-length mono${complete ? '' : ' is-invalid'}`}>
        {length !== null ? formatDuration(length) : 'incomplete'}
      </span>

      <IconButton
        icon="chevron-left"
        size="compact"
        label="Jump to the start of the range"
        disabled={inPoint === null}
        onClick={() => inPoint !== null && onSeek(inPoint)}
      />
      <IconButton
        icon="loop"
        size="compact"
        label="Loop this range (P)"
        selected={loop}
        disabled={!complete}
        onClick={onToggleLoop}
      />
      <IconButton
        icon="chevron-right"
        size="compact"
        label="Jump to the end of the range"
        disabled={outPoint === null}
        onClick={() => outPoint !== null && onSeek(outPoint)}
      />

      <span className="spacer" />

      <Button
        size="compact"
        variant="primary"
        icon="plus"
        disabled={!complete}
        title={complete ? 'Add this range as a clip (Enter)' : 'Mark both ends first'}
        onClick={onAddClip}
      >
        Add clip
      </Button>
      <IconButton
        icon="close"
        size="compact"
        label="Clear the marked range"
        onClick={() => {
          onSetIn(null)
          onSetOut(null)
        }}
      />
    </div>
  )
}

function rowsNeeded(clips: ClipSegment[]): number {
  // Overlapping clips are stacked so both stay visible.
  let rows = 1
  for (let i = 1; i < clips.length; i++) {
    if (clips[i].startSeconds < clips[i - 1].endSeconds) rows = Math.min(4, rows + 1)
  }
  return rows
}

function statusGlyph(clip: ClipSegment): string {
  switch (clip.status) {
    case 'complete':
      return '✓ '
    case 'failed':
      return '! '
    case 'queued':
      return '· '
    case 'downloading':
    case 'processing':
    case 'verifying':
      return '↓ '
    default:
      return ''
  }
}

/** Warm bakery marker palette, distinguishable without relying on hue alone. Returns a token name, not a colour. */
function markerColor(marker: Marker): string {
  switch (marker.category) {
    case 'funny':
      return '--marker-funny'
    case 'reaction':
      return '--marker-reaction'
    case 'important':
      return '--marker-important'
    case 'idea':
      return '--marker-idea'
    default:
      return '--marker-default'
  }
}

/** Pick tick spacing that keeps labels readable at any zoom level. */
export function tickStep(spanSeconds: number, widthPx: number): { step: number; minor: number } {
  const targetPx = 110
  const targetSeconds = (spanSeconds / Math.max(1, widthPx)) * targetPx
  const candidates = [
    0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
    43200, 86400
  ]
  const step = candidates.find((c) => c >= targetSeconds) ?? candidates[candidates.length - 1]
  const minorIndex = Math.max(0, candidates.indexOf(step) - 1)
  return { step, minor: candidates[minorIndex] }
}

function labelFor(seconds: number, step: number): string {
  return step < 1 ? formatTimecode(seconds) : formatDuration(seconds)
}
