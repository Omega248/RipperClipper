import { useEffect, useRef, useState } from 'react'
import type { VodSource } from '@shared/types'

/**
 * Frames of the broadcast, spread along the timeline.
 *
 * A four-hour ruler is otherwise a row of numbers: nothing in it says where
 * the raid was, where the stream sat in a menu for twenty minutes, or where
 * the scene changed. A dozen frames answer all three at a glance, which is the
 * difference between scrubbing to find a moment and pointing at it.
 *
 * Three rules keep this from being expensive:
 *
 *   - **One frame per request, two seconds wide.** The main process fetches
 *     only the segments that window touches, so a frame from 03:12:00 costs
 *     one segment, not three hours of video. Asking for a filmstrip *across*
 *     the whole view would download the whole view.
 *   - **Sample times sit on a grid.** Times are rounded to the slot width, so
 *     panning re-asks for times that were already fetched and the main
 *     process's disk cache answers them without touching the network.
 *   - **One at a time, newest view wins.** A zoom mid-flight abandons the old
 *     view's queue rather than racing it.
 */

/** A frame is fetched two seconds wide; one is all we keep. */
const SAMPLE_SECONDS = 2
/** Frame width asked of the encoder. Drawn smaller; this is for sharpness. */
const FRAME_WIDTH = 192

const images = new Map<string, HTMLImageElement>()
/** Times that came back with nothing, so a dead spot is not asked for forever. */
const barren = new Set<string>()

function keyOf(sourceId: string, seconds: number): string {
  return `${sourceId}:${seconds.toFixed(1)}`
}

/** The grid times covering a view, earliest first. */
export function filmstripTimes(
  viewStart: number,
  viewSpan: number,
  durationSeconds: number,
  slots: number
): number[] {
  if (!(viewSpan > 0) || !(durationSeconds > 0) || slots <= 0) return []
  const step = viewSpan / slots
  const first = Math.floor(Math.max(0, viewStart) / step) * step
  const out: number[] = []
  for (let i = 0; i <= slots + 1; i++) {
    const t = first + i * step
    if (t > viewStart + viewSpan) break
    if (t >= durationSeconds) break
    out.push(Math.round(t * 10) / 10)
  }
  return out
}

export interface Filmstrip {
  /** Seconds between frames — also how wide each one is drawn. */
  step: number
  /** Grid time to decoded image, for the times that have arrived. */
  frames: Map<number, HTMLImageElement>
}

export function useTimelineFilmstrip(
  source: VodSource | null,
  viewStart: number,
  viewSpan: number,
  widthPx: number,
  enabled: boolean
): Filmstrip {
  const [, bump] = useState(0)
  const generation = useRef(0)

  const slots = Math.max(1, Math.min(24, Math.round(widthPx / 132)))
  const step = viewSpan > 0 ? viewSpan / slots : 0
  const duration = source?.durationSeconds ?? 0
  const times = enabled && source ? filmstripTimes(viewStart, viewSpan, duration, slots) : []
  const wanted = times.join(',')
  const sourceId = source?.id ?? ''

  useEffect(() => {
    if (!enabled || !source || times.length === 0) return
    generation.current += 1
    const mine = generation.current
    let stopped = false

    const run = async (): Promise<void> => {
      for (const t of times) {
        if (stopped || generation.current !== mine) return
        const key = keyOf(source.id, t)
        if (images.has(key) || barren.has(key)) continue
        try {
          const reply = await window.api.filmstrip({
            source,
            startSeconds: t,
            endSeconds: Math.min(duration, t + SAMPLE_SECONDS),
            frameCount: 1,
            width: FRAME_WIDTH
          })
          const first = reply.frames[0]
          if (!first) {
            barren.add(key)
            continue
          }
          const img = new Image()
          img.src = first
          await img.decode().catch(() => undefined)
          images.set(key, img)
        } catch {
          // A frame the source will not give up is not an error worth showing:
          // the band simply stays empty there. Remembered so the next pan does
          // not ask again.
          barren.add(key)
        }
        if (!stopped && generation.current === mine) bump((n) => n + 1)
      }
    }
    void run()
    return () => {
      stopped = true
    }
    // `wanted` is the grid, as a string: the array identity changes every
    // render and the times themselves are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sourceId, wanted, duration])

  const frames = new Map<number, HTMLImageElement>()
  for (const t of times) {
    const img = images.get(keyOf(sourceId, t))
    if (img) frames.set(t, img)
  }
  return { step, frames }
}
