import { useMemo } from 'react'
import { clipSpan, eventWindow, povCoverage, sortedMoments } from '@shared/event'
import type { CoverageState } from '@shared/event'
import { povLabel } from './PovBar.js'
import { useStore } from '../store.js'
import { EmptyState } from '../ui/index.js'

/**
 * The event on one horizontal clock (§3, §4).
 *
 * Every POV is a bar showing exactly where its footage sits inside the event
 * window, and every clip is a mark at the moment it covers. Both are placed
 * from real-world time — a POV that joined half an hour late starts half way
 * along, which is the single most useful thing to see at a glance and is
 * impossible to read off a list of VOD timestamps.
 *
 * States are deliberately four, not two: "not synced yet" and "was not
 * recording" look identical on a coverage bar but mean completely different
 * things — one is work still to do, the other is a fact about the world.
 */

const STATE_LABEL: Record<CoverageState, string> = {
  available: 'Covers the whole event',
  partial: 'Covers part of the event',
  missing: 'Was not recording',
  unknown: 'Not aligned to the event clock yet'
}

export default function EventTimeline(): JSX.Element {
  const project = useStore((s) => s.project)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const selectClip = useStore((s) => s.selectClip)
  const selectedClipId = useStore((s) => s.selectedClipId)

  const window = useMemo(() => (project ? eventWindow(project) : null), [project])
  const coverage = useMemo(() => (project ? povCoverage(project) : []), [project])
  const moments = useMemo(() => sortedMoments(project?.event), [project?.event])

  if (!project) return <EmptyState icon="grid" title="Open a project to see its event." />
  if (!window) {
    return (
      <EmptyState
        icon="target"
        title="No event window yet."
        description="Set when the event happened in Event details, or mark a clip — the timeline builds itself from the real-world clock either way."
      />
    )
  }

  const span = window.endSeconds - window.startSeconds
  const label = (seconds: number): string => new Date(seconds * 1000).toLocaleTimeString()

  return (
    <div className="event-timeline">
      <div className="event-timeline-head">
        <span className="mono">{label(window.startSeconds)}</span>
        <span className="event-timeline-span mono">
          {Math.round(span / 60)} min
        </span>
        <span className="mono">{label(window.endSeconds)}</span>
      </div>

      {/* Notable moments (§21) sit above every POV bar, since they describe
          the event itself rather than any one angle. */}
      {moments.length > 0 && (
        <div className="event-moments" role="list">
          {moments.map((m) => {
            const at = (m.timeSeconds - window.startSeconds) / span
            if (at < 0 || at > 1) return null
            return (
              <span
                key={m.id}
                role="listitem"
                className="event-moment"
                style={{ left: `${at * 100}%` }}
                title={`${label(m.timeSeconds)} — ${m.name}`}
              >
                <span className="event-moment-dot" />
                <span className="event-moment-name ellipsis">{m.name}</span>
              </span>
            )
          })}
        </div>
      )}

      <div className="event-rows">
        {project.sources.map((source, index) => {
          const cov = coverage.find((c) => c.sourceId === source.id)
          const state: CoverageState = cov?.state ?? 'unknown'
          return (
            <div className="event-row" key={source.id}>
              <button
                className="event-row-name ellipsis"
                onClick={() => setActiveSource(source.id)}
                title={`Watch ${povLabel(source, index)} — ${STATE_LABEL[state]}`}
              >
                {povLabel(source, index)}
              </button>
              <div className={`event-row-track is-${state}`} title={STATE_LABEL[state]}>
                {cov?.spans.map((s, i) => (
                  <span
                    key={i}
                    className={`event-row-span is-${state}`}
                    style={{ left: `${s.from * 100}%`, width: `${Math.max(0.5, (s.to - s.from) * 100)}%` }}
                  />
                ))}
                {state === 'missing' && <span className="event-row-note">not recording</span>}
                {state === 'unknown' && <span className="event-row-note">not aligned</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Clips run along the bottom against the same clock, so "which POVs
          cover this moment" is answered by reading straight up the column. */}
      <div className="event-clips">
        <span className="event-clips-label">Clips</span>
        <div className="event-clips-track">
          {project.clips.map((clip) => {
            const s = clipSpan(clip, window)
            if (!s) return null
            return (
              <button
                key={clip.id}
                className={`event-clip${clip.id === selectedClipId ? ' on' : ''}`}
                style={{ left: `${s.from * 100}%`, width: `${Math.max(0.8, (s.to - s.from) * 100)}%` }}
                onClick={() => selectClip(clip.id)}
                title={`${clip.name} — ${label(clip.eventStartTime ?? 0)}`}
              >
                <span className="ellipsis">{clip.name}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
