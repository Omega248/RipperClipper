import { useEffect, useState } from 'react'
import { clipRangeInPov } from '@shared/povMapping'
import { povUsage } from '@shared/collections'
import type { ClipSegment, VodSource } from '@shared/types'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { Spinner } from '../ui/index.js'

/**
 * What this moment looked like, from every angle that has it (§9).
 *
 * A contact sheet rather than one picture, because the thing being identified
 * is a *moment in an event*, and a single frame from a single POV is often
 * the least recognisable version of it — the angle that happened to be
 * pointing at a wall.
 *
 * Frames come from the existing filmstrip pipeline (main/media/thumbnails.ts
 * via IPC.filmstrip), asking for exactly one frame at a small width. Nothing
 * full-resolution is written and nothing new is cached: that route already
 * fetches only the covering segments of the range and stores its output in
 * the managed media cache, which is precisely what §9 asks for.
 */

/** Thumbnail width in px. Small on purpose — this is for recognition, not review. */
const THUMB_WIDTH = 160

/** Frames are keyed by POV and range, so a re-render never refetches. */
const sheetCache = new Map<string, string | null>()

export default function ClipThumbnails({ clip }: { clip: ClipSegment }): JSX.Element | null {
  const sources = useStore((s) => s.project?.sources) ?? []
  const setActiveSource = useStore((s) => s.setActiveSource)

  // Only POVs that actually show this moment. An angle that was not recording
  // has no frame to contribute and must not appear as a blank tile.
  const covering = sources.filter((source) => povUsage(clip, source.id) !== 'unavailable')
  if (covering.length === 0) return null

  return (
    <div className="clip-sheet">
      {covering.map((source) => (
        <PovThumb
          key={source.id}
          clip={clip}
          source={source}
          label={povLabel(source, sources.indexOf(source))}
          used={povUsage(clip, source.id) === 'used'}
          onClick={() => setActiveSource(source.id)}
        />
      ))}
    </div>
  )
}

function PovThumb({
  clip,
  source,
  label,
  used,
  onClick
}: {
  clip: ClipSegment
  source: VodSource
  label: string
  used: boolean
  onClick: () => void
}): JSX.Element {
  // The clip's range *in this POV's own time* — the same projection the
  // exporter cuts from, so the frame shown is genuinely the frame that would
  // be exported rather than the authoring POV's timestamp applied blindly.
  const range = clipRangeInPov(clip, source)
  const at = range.coverage === 'none' ? null : range.localStart + (range.localEnd - range.localStart) / 2
  const key = `${source.id}:${at?.toFixed(1)}`

  const [frame, setFrame] = useState<string | null | undefined>(
    at === null ? null : sheetCache.get(key)
  )

  useEffect(() => {
    if (at === null || sheetCache.has(key)) return
    let cancelled = false
    window.api
      .filmstrip({
        source,
        startSeconds: at,
        // A hair of range rather than an instant: an exact-zero window makes
        // ffmpeg's frame selection ambiguous on some sources.
        endSeconds: at + 0.5,
        frameCount: 1,
        width: THUMB_WIDTH
      })
      .then((res) => {
        const first = res.frames[0] ?? null
        sheetCache.set(key, first)
        if (!cancelled) setFrame(first)
      })
      .catch(() => {
        // A POV that will not yield a frame still belongs on the sheet, as a
        // labelled tile — its absence is itself worth seeing.
        sheetCache.set(key, null)
        if (!cancelled) setFrame(null)
      })
    return () => {
      cancelled = true
    }
  }, [key, at, source])

  return (
    <button
      className={`clip-sheet-tile${used ? ' is-used' : ''}`}
      onClick={onClick}
      title={`${label}${used ? ' — used in this clip' : ' — available but not used'}`}
    >
      {frame === undefined ? (
        <span className="clip-sheet-loading">
          <Spinner />
        </span>
      ) : frame ? (
        <img src={frame} alt="" draggable={false} />
      ) : (
        <span className="clip-sheet-none">no frame</span>
      )}
      <span className="clip-sheet-label ellipsis">{label}</span>
    </button>
  )
}
