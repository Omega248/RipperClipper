import { useMemo, useState } from 'react'
import {
  DEFAULT_EVENT_MINUTES,
  eventCoverageFraction,
  eventWindow,
  participantSummary,
  sortedMoments
} from '@shared/event'
import { CLIP_WORKFLOW_LABEL, CLIP_WORKFLOW_ORDER } from '@shared/types'
import { workflowOf } from '@shared/collections'
import { attentionLine, summariseProject } from '@shared/dashboard'
import { message, title } from './QualityPanel.js'
import { isSynced, localToEvent } from '@shared/sync'
import { useStore } from '../store.js'
import EventTimeline from './EventTimeline.js'
import EventDiscovery from './EventDiscovery.js'
import MomentDetail from './MomentDetail.js'
import { Badge, Button, Field, Input, PageHeader, Section } from '../ui/index.js'

/**
 * The event, as one view (§21).
 *
 * This is the page that makes the product's actual model visible:
 *
 *     EVENT → PEOPLE → STREAMS → POVs → MOMENTS → CLIPS
 *
 * rather than a list of VODs with timestamps. Everything on it derives from
 * the real-world clock, so it is correct the moment a POV is synced and
 * needs no separate "refresh" step.
 */

/** A datetime-local input value for an epoch-seconds instant, in local time. */
function toLocalInput(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number') return ''
  const d = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(value: string): number | null {
  if (value === '') return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms / 1000 : null
}

export default function EventPage({ onLoadVod }: { onLoadVod: (url: string) => Promise<void> }): JSX.Element {
  const project = useStore((s) => s.project)
  const setEventInfo = useStore((s) => s.setEventInfo)
  const addEventMoment = useStore((s) => s.addEventMoment)
  const removeEventMoment = useStore((s) => s.removeEventMoment)
  const toast = useStore((s) => s.toast)
  const [showDiscovery, setShowDiscovery] = useState(false)
  const [momentName, setMomentName] = useState('')
  const [openMomentId, setOpenMomentId] = useState<string | null>(null)

  const eventRange = useMemo(() => (project ? eventWindow(project) : null), [project])
  const participants = useMemo(() => (project ? participantSummary(project) : null), [project])
  const coverage = useMemo(() => (project ? eventCoverageFraction(project) : 0), [project])
  const moments = useMemo(() => sortedMoments(project?.event), [project?.event])
  const summary = useMemo(() => (project ? summariseProject(project) : null), [project])

  const workflowCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const clip of project?.clips ?? []) {
      const state = workflowOf(clip)
      counts.set(state, (counts.get(state) ?? 0) + 1)
    }
    return counts
  }, [project?.clips])

  /**
   * §20 — write the work out as one portable file. The main process owns the
   * save dialog and the actual write; nothing here knows a path.
   */
  const exportPackage = async (): Promise<void> => {
    if (!project) return
    try {
      const result = await window.api.packageExport({
        project,
        options: { includeExportPaths: true }
      })
      if (!result) return // cancelled
      toast({
        kind: 'success',
        title: 'Package exported',
        message: `${result.clips} clip${result.clips === 1 ? '' : 's'} and ${result.povs} POV${result.povs === 1 ? '' : 's'}. The VODs are referenced, not copied.`
      })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not export package'), message: message(err) })
    }
  }

  if (!project) return <></>
  const event = project.event

  return (
    <div className="page event-page">
      <PageHeader
        title={event?.name?.trim() || project.name}
        description="Everything known about this real-world event: who filmed it, what they covered, and every moment cut from it."
        meta={summary ? <span className="event-attention">{attentionLine(summary)}</span> : undefined}
        actions={
          <>
            <Button
              icon="download"
              title="Save this event's work — clips, sync, edits, watermarks — as one portable file. The VODs are named, not copied."
              onClick={() => void exportPackage()}
            >
              Export package
            </Button>
            <Button variant="primary" icon="search" onClick={() => setShowDiscovery(true)}>
              Find POVs by time
            </Button>
          </>
        }
      />

      <Section title="Event details">
        <div className="event-details">
          <Field label="Event name">
            <Input
              value={event?.name ?? ''}
              placeholder={project.name}
              onChange={(e) => setEventInfo({ name: e.target.value === '' ? null : e.target.value })}
            />
          </Field>
          <Field
            label="Started"
            hint="The real-world time. Every POV is matched against this, never against VOD timestamps."
          >
            <Input
              type="datetime-local"
              value={toLocalInput(event?.startSeconds)}
              onChange={(e) => setEventInfo({ startSeconds: fromLocalInput(e.target.value) })}
            />
          </Field>
          <Field label="Ended" hint={`Optional — ${DEFAULT_EVENT_MINUTES} minutes is assumed.`}>
            <Input
              type="datetime-local"
              value={toLocalInput(event?.endSeconds)}
              onChange={(e) => setEventInfo({ endSeconds: fromLocalInput(e.target.value) })}
            />
          </Field>
        </div>
      </Section>

      <Section title="At a glance">
        <div className="event-stats">
          <Stat label="Participants" value={String(participants?.loaded ?? 0)} hint="POVs loaded" />
          <Stat
            label="Event coverage"
            value={`${Math.round(coverage * 100)}%`}
            hint="Of the window at least one POV can show"
          />
          <Stat label="Clips" value={String(project.clips.length)} />
          <Stat label="Collections" value={String(event?.collections.length ?? 0)} />
        </div>

        {participants && (
          <div className="event-participant-breakdown">
            <Badge tone="success">{participants.fullCoverage} full coverage</Badge>
            {participants.partialCoverage > 0 && <Badge tone="warning">{participants.partialCoverage} partial</Badge>}
            {participants.missing > 0 && <Badge tone="neutral">{participants.missing} not recording</Badge>}
            {/* Kept distinct from "not recording" on purpose: this one is work
                still to do, not a fact about the event. */}
            {participants.unknown > 0 && <Badge tone="danger">{participants.unknown} not aligned yet</Badge>}
          </div>
        )}

        <div className="event-workflow-breakdown">
          {CLIP_WORKFLOW_ORDER.filter((state) => (workflowCounts.get(state) ?? 0) > 0).map((state) => (
            <span key={state} className="event-workflow-chip">
              <strong>{workflowCounts.get(state)}</strong> {CLIP_WORKFLOW_LABEL[state]}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Event timeline">
        <EventTimeline />
      </Section>

      <Section title="Notable moments">
        <div className="event-moment-add">
          <Input
            value={momentName}
            placeholder="Name this moment, e.g. Police arrive"
            onChange={(e) => setMomentName(e.target.value)}
          />
          <Button
            icon="plus"
            disabled={momentName.trim() === '' || !eventRange}
            title="Marks the current playhead position on the event clock"
            onClick={() => {
              const state = useStore.getState()
              const source = state.project?.sources.find((s) => s.id === state.activeSourceId)
              // A moment is a real-world instant, so it is placed through the
              // POV's own mapping — the same projection clips use — rather
              // than from a VOD timestamp. Falls back to the event start when
              // the active POV isn't on the event clock yet.
              const at =
                source?.syncMapping && isSynced(source.syncMapping)
                  ? (localToEvent(source.syncMapping, state.currentTime) ?? eventRange?.startSeconds ?? 0)
                  : (eventRange?.startSeconds ?? 0)
              addEventMoment({ timeSeconds: at, name: momentName.trim() })
              setMomentName('')
            }}
          >
            Add at playhead
          </Button>
        </div>
        {moments.length === 0 ? (
          <p className="hint">
            Nothing marked yet. Moments show up on the timeline above and give the event a readable shape.
          </p>
        ) : (
          <ul className="event-moment-list">
            {moments.map((m) => (
              <li key={m.id}>
                <span className="mono">{new Date(m.timeSeconds * 1000).toLocaleTimeString()}</span>
                <span className="ellipsis">{m.name}</span>
                <Button size="compact" icon="trash" onClick={() => removeEventMoment(m.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {openMomentId && moments.find((m) => m.id === openMomentId) && (
        <MomentDetail
          moment={moments.find((m) => m.id === openMomentId)!}
          onClose={() => setOpenMomentId(null)}
        />
      )}

      {showDiscovery && (
        <EventDiscovery onClose={() => setShowDiscovery(false)} onLoadVod={onLoadVod} />
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="event-stat">
      <span className="event-stat-value">{value}</span>
      <span className="event-stat-label">{label}</span>
      {hint && <span className="event-stat-hint">{hint}</span>}
    </div>
  )
}
