import type { Marker, MarkerCategory } from '@shared/types'
import { formatTimecode } from '@shared/time'

/**
 * The markers lane: named moments, readable at a glance.
 *
 * Markers have been drawn on the timeline canvas for a while as small
 * unlabelled diamonds, which tells you *that* something was flagged but never
 * what — so finding a particular one meant hovering along the whole track.
 * Rendering them as DOM flags instead means each one can carry its own label
 * and be clicked directly, which is the entire point of having marked it.
 *
 * Positions come from the same view window the canvas uses, so a flag and the
 * diamond beneath it can never disagree about where a moment is.
 */

/** The app's own category tokens — never raw hexes. */
const CATEGORY_TOKEN: Record<MarkerCategory, string> = {
  funny: '--marker-funny',
  reaction: '--marker-reaction',
  important: '--marker-important',
  idea: '--marker-idea',
  other: '--marker-default'
}

const CATEGORY_LABEL: Record<MarkerCategory, string> = {
  funny: 'Funny',
  reaction: 'Reaction',
  important: 'Important',
  idea: 'Idea',
  other: 'Marker'
}

export default function MarkersLane({
  markers,
  viewStart,
  viewSpan,
  onSeek
}: {
  markers: Marker[]
  viewStart: number
  viewSpan: number
  onSeek: (seconds: number) => void
}): JSX.Element | null {
  if (markers.length === 0 || viewSpan <= 0) return null

  return (
    <div className="markers-lane" role="list" aria-label="Markers">
      {markers.map((marker) => {
        const at = (marker.timeSeconds - viewStart) / viewSpan
        // Off-screen markers are dropped rather than clamped: a flag pinned to
        // the edge would claim a position it does not have.
        if (at < 0 || at > 1) return null
        const token = CATEGORY_TOKEN[marker.category] ?? CATEGORY_TOKEN.other

        return (
          <button
            key={marker.id}
            type="button"
            role="listitem"
            className="marker-flag"
            style={{
              left: `${at * 100}%`,
              color: `var(${token})`,
              background: `color-mix(in srgb, var(${token}) 16%, transparent)`,
              borderColor: `color-mix(in srgb, var(${token}) 42%, transparent)`
            }}
            title={`${CATEGORY_LABEL[marker.category] ?? 'Marker'} marker · ${formatTimecode(marker.timeSeconds, { millis: false })}`}
            onClick={() => onSeek(marker.timeSeconds)}
          >
            <span className="marker-pin" style={{ background: `var(${token})` }} aria-hidden="true" />
            <span className="marker-label ellipsis">{marker.label}</span>
          </button>
        )
      })}
    </div>
  )
}
