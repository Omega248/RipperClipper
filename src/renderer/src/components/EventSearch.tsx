import { useEffect, useMemo, useState } from 'react'
import { searchEvent } from '@shared/search'
import type { SearchResult } from '@shared/search'
import { searchTranscripts, transcriptsAtEventTime } from '@shared/transcript'
import type { Transcript } from '@shared/transcript'
import { eventToLocal, isSynced } from '@shared/sync'
import { formatTimecode } from '@shared/time'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { message, title } from './QualityPanel.js'
import { Badge, Button, Dialog, EmptyState, SearchInput, Spinner } from '../ui/index.js'

/**
 * Find anything in this event (§10, §11, §12).
 *
 * Clips, POVs, collections, moments and spoken dialogue all answer the same
 * box, because "find the bank thing" should not require first deciding what
 * kind of thing the bank thing is.
 *
 * The transcript half is the interesting one. A line is stored in its POV's
 * own local time and projected onto the event clock to be shown, so hits from
 * three different VODs sort into one chronological account of the event. Act
 * on one and every *other* POV can be positioned at the same real-world
 * instant — searching dialogue once and then inspecting the moment from every
 * angle, which is §12.
 */

const KIND_LABEL: Record<SearchResult['kind'], string> = {
  clip: 'Clip',
  pov: 'POV',
  collection: 'Collection',
  moment: 'Moment',
  transcript: 'Said'
}

export default function EventSearch({ onClose }: { onClose: () => void }): JSX.Element {
  const project = useStore((s) => s.project)
  const selectClip = useStore((s) => s.selectClip)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  const [query, setQuery] = useState('')
  const [transcripts, setTranscripts] = useState<Transcript[] | null>(null)
  const [loadingTranscripts, setLoadingTranscripts] = useState(false)
  const [alsoAt, setAlsoAt] = useState<{ eventTime: number; hits: ReturnType<typeof transcriptsAtEventTime> } | null>(
    null
  )

  const sources = project?.sources ?? []
  const mappingFor = useMemo(
    () => (sourceId: string) => sources.find((s) => s.id === sourceId)?.syncMapping,
    [sources]
  )

  /**
   * Transcripts are fetched once, on demand, rather than when the project
   * opens: for a Twitch-only event there is nothing to fetch, and for a
   * YouTube-heavy one it is several network round trips nobody asked for
   * until they actually search dialogue.
   */
  const loadTranscripts = async (): Promise<void> => {
    if (transcripts !== null || loadingTranscripts) return
    setLoadingTranscripts(true)
    try {
      setTranscripts(await window.api.transcriptsFor(sources))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not load transcripts'), message: message(err) })
      setTranscripts([])
    } finally {
      setLoadingTranscripts(false)
    }
  }

  // Once transcripts exist they stay for the session; refetching per keystroke
  // would be pointless since the words never change.
  useEffect(() => {
    if (query.trim().length >= 3 && transcripts === null && !loadingTranscripts) void loadTranscripts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const transcriptHits = useMemo(
    () => (transcripts ? searchTranscripts(transcripts, query, mappingFor, 40) : []),
    [transcripts, query, mappingFor]
  )

  const results = useMemo(() => {
    if (!project) return []
    return searchEvent(
      {
        project,
        transcript: transcriptHits,
        povName: (source) => povLabel(source, sources.indexOf(source))
      },
      query
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, query, transcriptHits])

  /** Take the editor to whatever this result actually is. */
  const open = (result: SearchResult): void => {
    if (result.kind === 'clip') {
      selectClip(result.id)
      setPage('video')
      onClose()
      return
    }
    if (result.kind === 'pov') {
      setActiveSource(result.id)
      setPage('video')
      onClose()
      return
    }
    if (result.kind === 'transcript' && result.sourceId) {
      jumpToSpoken(result.sourceId, result.eventTimeSeconds)
      return
    }
    if (result.kind === 'moment' && result.eventTimeSeconds !== undefined) {
      // A moment belongs to the event, not a POV, so it opens in whichever
      // angle can actually show it.
      const source = sources.find((s) => s.syncMapping && isSynced(s.syncMapping))
      if (source) jumpToSpoken(source.id, result.eventTimeSeconds)
      return
    }
    setPage('event')
    onClose()
  }

  const jumpToSpoken = (sourceId: string, eventTime: number | undefined): void => {
    const source = sources.find((s) => s.id === sourceId)
    if (!source?.syncMapping || !isSynced(source.syncMapping)) return
    const local =
      eventTime !== undefined ? eventToLocal(source.syncMapping, eventTime) : null
    setActiveSource(sourceId)
    if (local !== null) setCurrentTime(local)
    // Offer the same instant in every other POV — §12's actual payoff.
    if (eventTime !== undefined && transcripts) {
      setAlsoAt({ eventTime, hits: transcriptsAtEventTime(transcripts, eventTime, mappingFor) })
    }
  }

  return (
    <Dialog
      title="Search this event"
      description="Clips, POVs, collections, moments and anything said on camera."
      size="large"
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <SearchInput
        value={query}
        onChange={setQuery}
        autoFocus
        placeholder="Search clips, POVs, or what was said…"
      />

      {loadingTranscripts && (
        <div className="discovery-running">
          <Spinner /> Fetching transcripts…
        </div>
      )}

      {query.trim() === '' ? (
        <EmptyState
          icon="search"
          title="Start typing."
          description="Dialogue is searched too, where the platform publishes captions — YouTube does; Twitch and Kick do not."
        />
      ) : results.length === 0 ? (
        <EmptyState icon="search" title={`Nothing matches "${query}".`} />
      ) : (
        <ul className="search-results">
          {results.map((result) => (
            <li key={`${result.kind}:${result.id}`}>
              <button className="search-result" onClick={() => open(result)}>
                <Badge>{KIND_LABEL[result.kind]}</Badge>
                <span className="search-result-title ellipsis">{result.title}</span>
                {result.subtitle && <span className="search-result-sub ellipsis">{result.subtitle}</span>}
                {result.eventTimeSeconds !== undefined && (
                  <span className="mono search-result-time">
                    {new Date(result.eventTimeSeconds * 1000).toLocaleTimeString()}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* §12: one search, then the same instant from every angle. */}
      {alsoAt && alsoAt.hits.length > 0 && (
        <div className="search-cross-pov">
          <h4>
            Also said at {new Date(alsoAt.eventTime * 1000).toLocaleTimeString()}
            <Button size="compact" onClick={() => setAlsoAt(null)}>
              Dismiss
            </Button>
          </h4>
          <ul>
            {alsoAt.hits.map((hit, i) => {
              const source = sources.find((s) => s.id === hit.sourceId)
              return (
                <li key={`${hit.sourceId}:${i}`}>
                  <button onClick={() => jumpToSpoken(hit.sourceId, hit.eventTimeSeconds ?? undefined)}>
                    <strong>{source ? povLabel(source, sources.indexOf(source)) : hit.sourceId}</strong>
                    <span className="mono">{formatTimecode(hit.startSeconds, { millis: false })}</span>
                    <span className="ellipsis">{hit.text}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </Dialog>
  )
}
