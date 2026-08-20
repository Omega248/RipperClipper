import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDuration, formatTimecode, roundMs } from '@shared/time'
import type { ClipSegment, Marker } from '@shared/types'
import { useActiveClips, useActiveMarkers, useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import { Button, IconButton } from '../ui/index.js'

const RULER_H = 20
const MARKER_H = 16
const EDGE_GRAB_PX = 6

type DragKind =
  | { type: 'none' }
  | { type: 'seek' }
  | { type: 'pan'; startX: number; startView: number }
  | { type: 'select'; anchorSeconds: number }
  | { type: 'clip-start'; clipId: string }
  | { type: 'clip-end'; clipId: string }
  | { type: 'clip-move'; clipId: string; grabOffset: number }

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
  const followPlayhead = useStore((s) => s.settings?.ui.timelineFollowPlayhead ?? true)

  const size = useRef({ width: 800, height: 132 })

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
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const dpr = window.devicePixelRatio || 1
    const width = wrap.clientWidth
    const height = wrap.clientHeight
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

    const laneTop = RULER_H + 6
    const laneHeight = height - RULER_H - MARKER_H - 12

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
  }, [clips, markers, currentTime, duration, viewStart, viewSpan, inPoint, outPoint, selectedClipId])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const onResize = (): void => draw()
    window.addEventListener('resize', onResize)
    const observer = new ResizeObserver(onResize)
    if (wrapRef.current) observer.observe(wrapRef.current)
    return () => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
    }
  }, [draw])

  // Keep the playhead visible while playing.
  useEffect(() => {
    if (!followPlayhead) return
    if (currentTime < viewStart || currentTime > viewStart + viewSpan) {
      setView(currentTime - viewSpan / 3, viewSpan)
    }
  }, [currentTime, viewStart, viewSpan, followPlayhead, setView])

  // ------------------------------------------------------- interaction ---
  const hitTest = useCallback(
    (x: number, y: number): DragKind => {
      const laneTop = RULER_H + 6
      const laneHeight = size.current.height - RULER_H - MARKER_H - 12
      if (y < laneTop || y > laneTop + laneHeight) return { type: 'none' }

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
    [clips, timeToX, xToTime]
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

    const hit = hitTest(x, y)
    if (hit.type !== 'none') {
      if ('clipId' in hit) selectClip(hit.clipId)
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
    const drag = dragRef.current
    if (drag.type === 'none') {
      const hit = hitTest(x, y)
      e.currentTarget.style.cursor =
        hit.type === 'clip-start' || hit.type === 'clip-end'
          ? 'ew-resize'
          : hit.type === 'clip-move'
            ? 'grab'
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
      case 'clip-start': {
        const clip = clips.find((c) => c.id === drag.clipId)
        if (!clip) break
        const value = Math.min(xToTime(x), clip.endSeconds - 0.05)
        patchClip(clip.id, { startSeconds: roundMs(Math.max(0, value)) })
        break
      }
      case 'clip-end': {
        const clip = clips.find((c) => c.id === drag.clipId)
        if (!clip) break
        const value = Math.max(xToTime(x), clip.startSeconds + 0.05)
        patchClip(clip.id, { endSeconds: roundMs(Math.min(duration, value)) })
        break
      }
      case 'clip-move': {
        const clip = clips.find((c) => c.id === drag.clipId)
        if (!clip) break
        const length = clip.endSeconds - clip.startSeconds
        let start = xToTime(x) - drag.grabOffset
        start = Math.max(0, Math.min(duration - length, start))
        patchClip(clip.id, {
          startSeconds: roundMs(start),
          endSeconds: roundMs(start + length)
        })
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
        <span className="spacer" />
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
        <canvas
          ref={canvasRef}
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
          onPointerLeave={() => setHoverTime(null)}
          onWheel={onWheel}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') seekTo(currentTime - (e.shiftKey ? 30 : 5))
            if (e.key === 'ArrowRight') seekTo(currentTime + (e.shiftKey ? 30 : 5))
          }}
        />
      </div>
    </section>
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
