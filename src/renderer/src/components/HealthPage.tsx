import { useCallback, useEffect, useState } from 'react'
import { povCoverage } from '@shared/event'
import type { CoverageState } from '@shared/event'
import { isSynced } from '@shared/sync'
import { eventWindow } from '@shared/event'
import type { EventOverlapReply, StorageReport } from '@shared/ipc'
import { coverageLabel } from '@shared/eventStreams'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import TranscribePanel from './TranscribePanel.js'
import { message, title } from './QualityPanel.js'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Notice,
  PageHeader,
  Section,
  Spinner,
} from '../ui/index.js'

/**
 * What still needs attention (§15, §16, §17).
 *
 * Three questions that all mean "is this event actually finished?":
 * are my sources healthy, is there footage I have not found, and is the disk
 * filling up. They share a page because in practice they are answered in one
 * sitting, at the end of gathering and before editing.
 */

const STATE_TONE: Record<CoverageState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  available: 'success',
  partial: 'warning',
  missing: 'neutral',
  unknown: 'danger'
}

const STATE_TEXT: Record<CoverageState, string> = {
  available: 'Full coverage',
  partial: 'Partial coverage',
  missing: 'Was not recording',
  unknown: 'Not aligned to the event clock'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export default function HealthPage({
  onLoadVod
}: {
  onLoadVod: (url: string) => Promise<void>
}): JSX.Element {
  const project = useStore((s) => s.project)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  const [storage, setStorage] = useState<StorageReport | null>(null)
  const [clearing, setClearing] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState<{ id: string; label: string; consequence: string } | null>(
    null
  )
  const [missed, setMissed] = useState<EventOverlapReply | null>(null)
  const [findingMissed, setFindingMissed] = useState(false)
  const [loadingVod, setLoadingVod] = useState<string | null>(null)

  const refreshStorage = useCallback(async (): Promise<void> => {
    try {
      setStorage(await window.api.storageReport())
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not read storage'), message: message(err) })
    }
  }, [toast])

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage])

  /**
   * §15 — who was live for this event that is not loaded.
   *
   * Reuses the existing saved-streamer overlap sweep rather than a second
   * mechanism, then filters to exactly the broadcasts that are not already
   * POVs. Those are the ones representing footage nobody has looked at.
   */
  const findMissed = async (): Promise<void> => {
    if (!project) return
    const window_ = eventWindow(project)
    if (!window_) {
      toast({
        kind: 'info',
        title: 'No event window yet',
        message: 'Set when the event happened on the Event page first.'
      })
      return
    }
    setFindingMissed(true)
    try {
      const reply = await window.api.streamersCoveringEvent({
        eventStartSeconds: window_.startSeconds,
        eventEndSeconds: window_.endSeconds,
        loadedUrls: project.sources.map((s) => s.url)
      })
      setMissed({ ...reply, streams: reply.streams.filter((s) => s.availability !== 'loaded') })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not check'), message: message(err) })
    } finally {
      setFindingMissed(false)
    }
  }

  if (!project) return <EmptyState icon="grid" title="Open a project to see its health." />

  const coverage = povCoverage(project)
  const problems = coverage.filter((c) => c.state === 'unknown' || c.state === 'partial')

  return (
    <div className="page health-page">
      <PageHeader
        title="Project health"
        description="Whether this event is actually finished: sources, footage you might still be missing, and disk."
      />

      <Section
        title="Sources"
        description={
          problems.length === 0
            ? 'Every loaded POV is aligned and accounted for.'
            : `${problems.length} of ${coverage.length} need attention.`
        }
      >
        <ul className="health-list">
          {project.sources.map((source, index) => {
            const state = coverage.find((c) => c.sourceId === source.id)?.state ?? 'unknown'
            const synced = source.syncMapping && isSynced(source.syncMapping)
            return (
              <li key={source.id}>
                <button
                  className="health-row"
                  onClick={() => {
                    setActiveSource(source.id)
                    setPage('video')
                  }}
                  title="Open this POV"
                >
                  <span className={`ui-dot is-${STATE_TONE[state]}`} aria-hidden="true" />
                  <span className="ellipsis">{povLabel(source, index)}</span>
                  <Badge tone={STATE_TONE[state]}>{STATE_TEXT[state]}</Badge>
                  {!synced && <Badge tone="danger">Needs aligning</Badge>}
                  <span className="health-row-meta mono">{source.platform}</span>
                </button>
              </li>
            )
          })}
        </ul>
        {project.sources.length === 0 && <p className="hint">No POVs loaded yet.</p>}
      </Section>
      <TranscribePanel />


      <Section
        title="What did I miss?"
        description="Saved streamers who were broadcasting during this event but are not loaded as POVs."
        actions={
          <Button icon="search" loading={findingMissed} onClick={() => void findMissed()}>
            Check
          </Button>
        }
      >
        {missed === null ? (
          <p className="hint">Nothing checked yet.</p>
        ) : missed.streams.length === 0 ? (
          <Notice tone="success">
            Every saved streamer who covered this event is already loaded.
          </Notice>
        ) : (
          <>
            {missed.unreachable.length > 0 && (
              <Notice tone="warning">
                Could not reach {missed.unreachable.join(', ')} — there may be more.
              </Notice>
            )}
            <ul className="health-list">
              {missed.streams.map((stream) => (
                <li key={stream.vod.url}>
                  <div className="health-row">
                    <span className="ui-dot is-warning" aria-hidden="true" />
                    <span className="ellipsis">{stream.streamerName}</span>
                    <Badge>{stream.platform}</Badge>
                    <span className="health-row-meta">{coverageLabel(stream.coverage)}</span>
                    <Button
                      size="compact"
                      loading={loadingVod === stream.vod.url}
                      onClick={() => {
                        setLoadingVod(stream.vod.url)
                        void onLoadVod(stream.vod.url)
                          .catch((err) =>
                            toast({
                              kind: 'error',
                              title: title(err, 'Could not load'),
                              message: message(err)
                            })
                          )
                          .finally(() => setLoadingVod(null))
                      }}
                    >
                      Load POV
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section
        title="Storage"
        description={storage ? `${formatBytes(storage.totalBytes)} in total.` : undefined}
        actions={
          <Button icon="refresh" onClick={() => void refreshStorage()}>
            Refresh
          </Button>
        }
      >
        {!storage ? (
          <div className="discovery-running">
            <Spinner /> Measuring…
          </div>
        ) : (
          <ul className="health-list">
            {storage.areas.map((area) => (
              <li key={area.id}>
                <div className="health-row">
                  <span className="ellipsis">{area.label}</span>
                  <span className="health-row-meta mono">{formatBytes(area.sizeBytes)}</span>
                  <span className="health-row-note ellipsis" title={area.path}>
                    {area.consequence}
                  </span>
                  {area.clearable ? (
                    <Button
                      size="compact"
                      loading={clearing === area.id}
                      disabled={area.sizeBytes === 0}
                      onClick={() =>
                        setConfirmClear({ id: area.id, label: area.label, consequence: area.consequence })
                      }
                    >
                      Clear
                    </Button>
                  ) : (
                    // Never offered, and the main process refuses it anyway —
                    // these are the only files here that cannot be rebuilt.
                    <Badge tone="neutral">Protected</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {confirmClear && (
        <ConfirmDialog
          title={`Clear ${confirmClear.label.toLowerCase()}?`}
          description={confirmClear.consequence}
          confirmLabel="Clear"
          onCancel={() => setConfirmClear(null)}
          onConfirm={() => {
            const area = confirmClear
            setConfirmClear(null)
            setClearing(area.id)
            void window.api
              .storageClear(area.id)
              .then((next) => {
                setStorage(next)
                toast({ kind: 'success', title: 'Cleared', message: `${area.label} is now empty.` })
              })
              .catch((err) =>
                toast({ kind: 'error', title: title(err, 'Could not clear'), message: message(err) })
              )
              .finally(() => setClearing(null))
          }}
        />
      )}
    </div>
  )
}
