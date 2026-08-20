import { useCallback, useEffect, useState } from 'react'
import { coverageLabel } from '@shared/eventStreams'
import type { EventOverlapReply } from '@shared/ipc'
import { formatTimecode } from '@shared/time'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import { Badge, Button, EmptyState, Notice, Spinner, StatusBadge } from '../ui/index.js'

/**
 * Who else was live during this moment.
 *
 * The comparison is on the wall clock — the event's real-world range against
 * each saved broadcast's own start and length — because two VODs that both read
 * "01:12:30" were not in the same place at the same time. A broadcast that only
 * covers part of the clip says so; one that does not cover it is not offered as
 * a POV at all.
 */
export default function EventStreams({
  onLoadVod
}: {
  onLoadVod: (url: string) => Promise<void>
}): JSX.Element | null {
  const project = useStore((s) => s.project)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const toast = useStore((s) => s.toast)

  const [result, setResult] = useState<EventOverlapReply | null>(null)
  const [loading, setLoading] = useState(false)
  // Optimistic: a click flips its row to "Added" immediately instead of
  // waiting on the load to finish, so importing several POVs back to back
  // never blocks on the slowest one. Reverted only if the load actually fails.
  const [added, setAdded] = useState<Set<string>>(new Set())

  const clip =
    project?.clips.find((c) => c.id === selectedClipId) ?? project?.clips[0] ?? null
  const eventStart = clip?.eventStartTime ?? null
  const eventEnd = clip?.eventEndTime ?? null

  const search = useCallback(async (): Promise<void> => {
    if (eventStart === null || eventEnd === null || !project) return
    setLoading(true)
    try {
      setResult(
        await window.api.streamersCoveringEvent({
          eventStartSeconds: eventStart,
          eventEndSeconds: eventEnd,
          loadedUrls: project.sources.map((s) => s.url)
        })
      )
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not search'), message: message(err) })
    } finally {
      setLoading(false)
    }
  }, [eventStart, eventEnd, project, toast])

  useEffect(() => {
    setResult(null)
  }, [clip?.id])

  if (!clip) return null

  if (eventStart === null || eventEnd === null) {
    return (
      <section className="panel-section">
        <h3>Who else was live</h3>
        <Notice tone="info">
          This clip has no real-world time yet, so there is nothing to compare other broadcasts
          against. Align the POV it was made in and this fills itself in.
        </Notice>
      </section>
    )
  }

  const loadedUrls = new Set(project?.sources.map((s) => s.url) ?? [])

  /** Fires the load in the background; the row flips to "Added" right away. */
  const importOne = (url: string): void => {
    if (loadedUrls.has(url) || added.has(url)) return
    setAdded((prev) => new Set(prev).add(url))
    void onLoadVod(url).then(() => {
      const stillMissing = !useStore.getState().project?.sources.some((s) => s.url === url)
      if (stillMissing) {
        setAdded((prev) => {
          const next = new Set(prev)
          next.delete(url)
          return next
        })
      }
    })
  }

  return (
    <section className="panel-section">
      <h3>Who else was live</h3>
      <div className="hint">
        {new Date(eventStart * 1000).toLocaleString()} — {clip.name}
      </div>

      {!result && !loading && (
        <Button icon="search" onClick={() => void search()}>
          Check saved streamers
        </Button>
      )}
      {loading && <Spinner label="Asking each saved channel…" />}

      {result && result.streams.length === 0 && (
        <EmptyState
          icon="users"
          title="Nobody else was live"
          description="None of your saved streamers has a broadcast covering this moment. Their VODs may have expired, or they were not streaming."
        />
      )}

      {result && result.streams.length > 0 && (
        <div className="stream-list">
          {result.streams.some(
            (entry) =>
              !(entry.availability === 'loaded' || loadedUrls.has(entry.vod.url)) &&
              !added.has(entry.vod.url)
          ) && (
            <Button
              size="compact"
              icon="plus"
              onClick={() => {
                for (const entry of result.streams) importOne(entry.vod.url)
              }}
            >
              Import all
            </Button>
          )}
          {result.streams.map((entry) => {
            const loaded =
              entry.availability === 'loaded' ||
              loadedUrls.has(entry.vod.url) ||
              added.has(entry.vod.url)
            const povId = project?.sources.find((s) => s.url === entry.vod.url)?.id
            return (
              <div className="stream-row" key={`${entry.streamerId}-${entry.vod.url}`}>
                <div className="stream-who">
                  <div className="stream-name">{entry.streamerName}</div>
                  <div className="stream-meta">
                    <span className="tag">{entry.platform}</span>
                    <span>{coverageLabel(entry.coverage)}</span>
                    {entry.coverage.certain && (
                      <span className="mono">
                        {formatTimecode(entry.coverage.offsetSeconds, { millis: false })} in
                      </span>
                    )}
                  </div>
                </div>

                {entry.coverage.complete ? (
                  <StatusBadge status="complete" label="Full coverage" />
                ) : (
                  <Badge tone="warning" glyph="▲">
                    Partial
                  </Badge>
                )}

                {povId ? (
                  <Button
                    size="compact"
                    icon="play"
                    onClick={() => setActiveSource(povId)}
                  >
                    Open POV
                  </Button>
                ) : loaded ? (
                  <Button size="compact" icon="check" disabled>
                    Added
                  </Button>
                ) : (
                  <Button
                    size="compact"
                    variant="primary"
                    icon="plus"
                    onClick={() => importOne(entry.vod.url)}
                  >
                    Add POV
                  </Button>
                )}
              </div>
            )
          })}
          <Button size="compact" variant="ghost" icon="refresh" onClick={() => void search()}>
            Check again
          </Button>
        </div>
      )}

      {result && result.unreachable.length > 0 && (
        <Notice tone="warning">
          Could not reach {result.unreachable.join(', ')}, so this list may be incomplete.
        </Notice>
      )}
    </section>
  )
}
