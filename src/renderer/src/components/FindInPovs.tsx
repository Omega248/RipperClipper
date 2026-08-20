import { useMemo } from 'react'
import { formatTimecode } from '@shared/time'
import { findMomentInPovs, isSynced, localToEvent } from '@shared/sync'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { Dialog, EmptyState } from '../ui/index.js'

/**
 * The same real-world instant, in every POV. This is the move the whole
 * multi-POV workflow is built around: watch one angle, then jump to what
 * everyone else was doing at that exact second.
 */
export default function FindInPovs({ onClose }: { onClose: () => void }): JSX.Element {
  const sources = useStore((s) => s.project?.sources) ?? []
  const activeSourceId = useStore((s) => s.activeSourceId)
  const currentTime = useStore((s) => s.currentTime)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setCurrentTime = useStore((s) => s.setCurrentTime)

  const active = sources.find((s) => s.id === activeSourceId) ?? null

  const moments = useMemo(() => {
    if (!active?.syncMapping || !isSynced(active.syncMapping)) return null
    const eventTime = localToEvent(active.syncMapping, currentTime)
    if (eventTime === null) return null
    const found = findMomentInPovs(
      eventTime,
      sources
        .filter((s) => s.syncMapping)
        .map((s) => ({ mapping: s.syncMapping!, durationSeconds: s.durationSeconds }))
    )
    return { eventTime, found }
  }, [active, currentTime, sources])

  return (
    <Dialog
      title="Find this moment in every POV"
      description="The same real-world instant, wherever it falls in each angle's own recording."
      onClose={onClose}
    >
      {!moments ? (
        <EmptyState
          icon="target"
          title="This POV has no real-world timing yet"
          description="The angle you are watching has no known start time, so the same instant cannot be located in the others. Use Align POVs to line one up by its sound."
        />
      ) : (
        <>
          <p className="hint mono">
            {new Date(moments.eventTime * 1000).toLocaleString()} — event time
          </p>
          <div className="moment-list">
            {moments.found.map((moment) => {
              const index = sources.findIndex((s) => s.id === moment.vodId)
              const source = sources[index]
              if (!source) return null
              return (
                <button
                  key={moment.vodId}
                  className={`moment${moment.vodId === activeSourceId ? ' current' : ''}`}
                  disabled={!moment.withinVod}
                  title={
                    moment.withinVod
                      ? `Switch to ${source.title} at this moment`
                      : 'This POV was not recording at that moment'
                  }
                  onClick={() => {
                    setActiveSource(moment.vodId)
                    setCurrentTime(moment.localTime)
                    onClose()
                  }}
                >
                  <span className="moment-name">{povLabel(source, index)}</span>
                  <span className="mono">
                    {moment.withinVod ? formatTimecode(moment.localTime) : 'Not recording'}
                  </span>
                  <span className="pct">{Math.round(moment.confidence * 100)}% confidence</span>
                </button>
              )
            })}
          </div>
          {moments.found.length <= 1 && (
            <p className="hint">
              Only this POV has real-world timing so far. Add another angle of the same event and it
              will appear here.
            </p>
          )}
        </>
      )}
    </Dialog>
  )
}
