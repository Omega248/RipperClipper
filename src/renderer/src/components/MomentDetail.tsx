import { useMemo } from 'react'
import { findMomentInPovs, eventToLocal, isSynced } from '@shared/sync'
import { formatTimecode } from '@shared/time'
import type { EventMoment } from '@shared/types'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { Badge, Button, Section } from '../ui/index.js'

/**
 * Everything known about one instant of the event (§21).
 *
 * This is the intelligence layer's actual payload: pick a moment and see who
 * can show it, exactly where it falls in each of their recordings, and which
 * clips already cover it. `findMomentInPovs` is the same function the Find in
 * all POVs dialog uses — the answer to "where is this instant in every angle"
 * has one implementation, so this panel can never disagree with that dialog.
 */
export default function MomentDetail({
  moment,
  onClose
}: {
  moment: EventMoment
  onClose: () => void
}): JSX.Element {
  const sources = useStore((s) => s.project?.sources) ?? []
  const clips = useStore((s) => s.project?.clips) ?? []
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setPage = useStore((s) => s.setPage)
  const selectClip = useStore((s) => s.selectClip)

  const found = useMemo(
    () =>
      findMomentInPovs(
        moment.timeSeconds,
        sources
          .filter((s) => s.syncMapping)
          .map((s) => ({ mapping: s.syncMapping!, durationSeconds: s.durationSeconds }))
      ),
    [moment.timeSeconds, sources]
  )

  // Clips whose real-world range contains this instant — what has already
  // been cut from it, so the same moment is not marked twice.
  const covering = clips.filter(
    (c) =>
      typeof c.eventStartTime === 'number' &&
      typeof c.eventEndTime === 'number' &&
      moment.timeSeconds >= c.eventStartTime &&
      moment.timeSeconds <= c.eventEndTime
  )

  /** Watch this instant in one POV, through that POV's own mapping. */
  const watchIn = (sourceId: string): void => {
    const source = sources.find((s) => s.id === sourceId)
    if (!source?.syncMapping || !isSynced(source.syncMapping)) return
    const local = eventToLocal(source.syncMapping, moment.timeSeconds)
    setActiveSource(sourceId)
    if (local !== null) setCurrentTime(local)
    setPage('video')
  }

  return (
    <Section
      title={moment.name}
      description={`${new Date(moment.timeSeconds * 1000).toLocaleTimeString()} — who can show this instant.`}
      actions={<Button size="compact" onClick={onClose}>Close</Button>}
    >
      <ul className="moment-povs">
        {sources.map((source, index) => {
          // findMomentInPovs keys by the mapping's vodId, which for a loaded
          // POV is that source's own id.
          const hit = found.find((f) => f.vodId === source.syncMapping?.vodId)
          const available = Boolean(hit?.withinVod)
          return (
            <li key={source.id}>
              <button
                className="moment-pov"
                disabled={!available}
                onClick={() => watchIn(source.id)}
                title={available ? 'Watch this instant here' : 'This POV cannot show this instant'}
              >
                <span className="ellipsis">{povLabel(source, index)}</span>
                {available ? (
                  <>
                    <Badge tone="success">Available</Badge>
                    {/* Where this instant actually falls in *this* recording —
                        different in every POV, which is the whole point. */}
                    <span className="mono">{formatTimecode(hit!.localTime, { millis: false })}</span>
                  </>
                ) : (
                  <Badge tone={hit ? 'neutral' : 'danger'}>
                    {hit ? 'Not recording' : 'Not aligned'}
                  </Badge>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      {covering.length > 0 && (
        <p className="hint">
          Already cut here:{' '}
          {covering.map((clip, i) => (
            <span key={clip.id}>
              {i > 0 && ', '}
              <button className="link-button" onClick={() => selectClip(clip.id)}>
                {clip.name}
              </button>
            </span>
          ))}
        </p>
      )}
    </Section>
  )
}
