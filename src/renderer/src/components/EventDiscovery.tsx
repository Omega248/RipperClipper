import { useMemo, useState } from 'react'
import { filterDiscoveries, sortDiscoveries } from '@shared/discovery'
import type { DiscoveredStream, DiscoverySort } from '@shared/discovery'
import type { EventDiscoveryReply } from '@shared/ipc'
import type { PlatformId } from '@shared/types'
import { parseLocalDateTime } from '@shared/vodSearch'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  SearchInput,
  Select,
  Spinner
} from '../ui/index.js'

/**
 * "This is when the event happened — find me everyone who filmed it."
 *
 * The whole multi-POV workflow starts from a real-world moment, not a VOD, so
 * this asks for the moment and sweeps the platforms for broadcasts that were
 * live during it. Coverage is computed on the wall clock (see
 * shared/discovery.ts), which is the same rule the rest of the app syncs by.
 *
 * What the sweep could *not* reach is shown as prominently as what it found:
 * Twitch and Kick expose no public search for past broadcasts, so those are
 * covered through the streamer library only. Presenting a partial sweep as a
 * complete one would stop the editor looking for a POV that is genuinely out
 * there, which is worse than admitting the gap.
 */

/** Default event length when the editor gives a start but no end. */
const DEFAULT_WINDOW_MINUTES = 30

export default function EventDiscovery({
  onClose,
  onLoadVod
}: {
  onClose: () => void
  onLoadVod: (url: string) => Promise<void>
}): JSX.Element {
  const project = useStore((s) => s.project)
  const toast = useStore((s) => s.toast)

  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')
  const [name, setName] = useState('')
  const [includeSearch, setIncludeSearch] = useState(true)

  const [running, setRunning] = useState(false)
  const [reply, setReply] = useState<EventDiscoveryReply | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<string | null>(null)

  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [minCoverage, setMinCoverage] = useState(0)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<DiscoverySort>('confidence')

  const shown = useMemo(() => {
    if (!reply) return []
    return sortDiscoveries(
      filterDiscoveries(reply.streams, { platform, minCoverage, search }),
      sort
    )
  }, [reply, platform, minCoverage, search, sort])

  const run = async (): Promise<void> => {
    const startMs = parseLocalDateTime(startText)
    if (startMs === null) {
      toast({
        kind: 'error',
        title: 'Pick when the event happened',
        message: 'Choose a date and time first — that is what every POV is matched against.'
      })
      return
    }
    const endMs = parseLocalDateTime(endText)
    const startSeconds = startMs / 1000
    // An open-ended event still needs a finite window, or every coverage
    // fraction would be meaningless.
    const endSeconds =
      endMs !== null && endMs > startMs ? endMs / 1000 : startSeconds + DEFAULT_WINDOW_MINUTES * 60

    setRunning(true)
    setReply(null)
    try {
      const result = await window.api.discoverEvent({
        startSeconds,
        endSeconds,
        name: name.trim() === '' ? undefined : name.trim(),
        loadedUrls: (project?.sources ?? []).map((s) => s.url),
        includeSearch
      })
      setReply(result)
      setSelected(new Set())
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Discovery failed'), message: message(err) })
    } finally {
      setRunning(false)
    }
  }

  const toggle = (url: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  /**
   * Loads the chosen broadcasts as POVs, one at a time.
   *
   * Sequential rather than parallel on purpose: each load resolves a VOD
   * through yt-dlp and adds a source to the project, and firing ten of those
   * at once is how the resolver gets rate-limited. One failing is reported and
   * skipped rather than abandoning the rest.
   */
  const loadSelected = async (urls: string[]): Promise<void> => {
    const failed: string[] = []
    for (const url of urls) {
      setLoading(url)
      try {
        await onLoadVod(url)
      } catch {
        failed.push(url)
      }
    }
    setLoading(null)
    if (failed.length > 0) {
      toast({
        kind: 'error',
        title: `${failed.length} POV${failed.length === 1 ? '' : 's'} could not be loaded`,
        message: 'The rest were added. The platform may have removed those broadcasts.'
      })
    } else {
      toast({
        kind: 'success',
        title: `Loaded ${urls.length} POV${urls.length === 1 ? '' : 's'}`,
        message: 'They are synced onto the event clock as each one resolves.'
      })
      onClose()
    }
  }

  const selectable = shown.filter((s) => s.source !== 'loaded')

  return (
    <Dialog
      title="Find the POVs of an event"
      description="Give the real-world time it happened and Ripper Clipper will look for everyone who was live."
      size="large"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            disabled={selected.size === 0 || loading !== null}
            loading={loading !== null}
            onClick={() => void loadSelected([...selected])}
          >
            Load selected ({selected.size})
          </Button>
          <Button
            variant="primary"
            disabled={selectable.length === 0 || loading !== null}
            onClick={() => void loadSelected(selectable.map((s) => s.vod.url))}
          >
            Load all relevant ({selectable.length})
          </Button>
        </>
      }
    >
      <div className="discovery-query">
        <Field label="Event start">
          <Input
            type="datetime-local"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            aria-label="Event start date and time"
          />
        </Field>
        <Field label="Event end" hint="Optional — defaults to 30 minutes.">
          <Input
            type="datetime-local"
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            aria-label="Event end date and time"
          />
        </Field>
        <Field label="Event name" hint="Optional — improves relevance.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bank robbery"
          />
        </Field>
        <div className="discovery-query-actions">
          <Checkbox
            checked={includeSearch}
            onChange={setIncludeSearch}
            label="Also search platforms, not just my streamer library"
          />
          <Button variant="primary" icon="search" loading={running} onClick={() => void run()}>
            Find POVs
          </Button>
        </div>
      </div>

      {running && (
        <div className="discovery-running">
          <Spinner /> Sweeping for broadcasts that were live during the event…
        </div>
      )}

      {reply && !running && (
        <>
          {reply.notes.map((note) => (
            <Notice key={note} tone="info">
              {note}
            </Notice>
          ))}
          {reply.unreachable.length > 0 && (
            <Notice tone="warning">
              Could not reach {reply.unreachable.join(', ')} — results may be incomplete.
            </Notice>
          )}

          {reply.streams.length === 0 ? (
            <EmptyState
              icon="search"
              title="No broadcasts overlapped that time."
              description="Try widening the window, or add the streamers you expect to your library — Twitch and Kick can only be swept through channels you have saved."
            />
          ) : (
            <>
              <div className="discovery-filters">
                <SearchInput value={search} onChange={setSearch} placeholder="Filter by streamer…" />
                <Select
                  size="compact"
                  label="Platform"
                  value={platform}
                  options={[
                    { value: 'all', label: 'All platforms' },
                    { value: 'twitch', label: 'Twitch' },
                    { value: 'kick', label: 'Kick' },
                    { value: 'youtube', label: 'YouTube' }
                  ]}
                  onChange={(v) => setPlatform(v as PlatformId | 'all')}
                />
                <Select
                  size="compact"
                  label="Minimum coverage"
                  value={String(minCoverage)}
                  options={[
                    { value: '0', label: 'Any coverage' },
                    { value: '0.25', label: '25%+' },
                    { value: '0.5', label: '50%+' },
                    { value: '0.9', label: '90%+' }
                  ]}
                  onChange={(v) => setMinCoverage(Number(v))}
                />
                <Select
                  size="compact"
                  label="Sort by"
                  value={sort}
                  options={[
                    { value: 'confidence', label: 'Best match' },
                    { value: 'coverage', label: 'Most coverage' },
                    { value: 'start', label: 'Start time' },
                    { value: 'platform', label: 'Platform' },
                    { value: 'name', label: 'Streamer name' }
                  ]}
                  onChange={(v) => setSort(v as DiscoverySort)}
                />
                <span className="spacer" />
                <Button
                  size="compact"
                  onClick={() => setSelected(new Set(selectable.map((s) => s.vod.url)))}
                >
                  Select all
                </Button>
                <Button size="compact" onClick={() => setSelected(new Set())}>
                  Deselect
                </Button>
              </div>

              <ul className="discovery-results">
                {shown.map((stream) => (
                  <DiscoveryRow
                    key={`${stream.platform}:${stream.vod.url}`}
                    stream={stream}
                    checked={selected.has(stream.vod.url)}
                    busy={loading === stream.vod.url}
                    onToggle={() => toggle(stream.vod.url)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Dialog>
  )
}

/** How much of the event this broadcast can actually show, in words and a bar. */
function DiscoveryRow({
  stream,
  checked,
  busy,
  onToggle
}: {
  stream: DiscoveredStream
  checked: boolean
  busy: boolean
  onToggle: () => void
}): JSX.Element {
  const alreadyLoaded = stream.source === 'loaded'
  const pct = Math.round(stream.coverage.fraction * 100)
  const started = stream.vod.publishedAt ? new Date(stream.vod.publishedAt) : null

  return (
    <li className={`discovery-row${alreadyLoaded ? ' is-loaded' : ''}`}>
      <Checkbox
        checked={checked}
        disabled={alreadyLoaded || busy}
        onChange={onToggle}
        label={<span className="visually-hidden">{`Select ${stream.streamerName}`}</span>}
      />
      <div className="discovery-row-main">
        <div className="discovery-row-head">
          <strong className="ellipsis">{stream.streamerName}</strong>
          <Badge>{stream.platform}</Badge>
          {alreadyLoaded && <Badge tone="success">Already loaded</Badge>}
          {!stream.coverage.certain && <Badge tone="warning">Length unknown</Badge>}
        </div>
        <div className="discovery-row-title ellipsis" title={stream.vod.title}>
          {stream.vod.title}
        </div>
        <div className="discovery-row-meta mono">
          {started ? started.toLocaleString() : 'Start time unknown'}
          {' · '}
          {stream.coverage.complete ? 'Covers the whole event' : `${pct}% event coverage`}
        </div>
        {stream.reasons.length > 0 && (
          <div className="discovery-row-why" title={stream.reasons.join(' · ')}>
            {stream.reasons[0]}
          </div>
        )}
      </div>
      <div className="discovery-row-coverage" aria-hidden="true">
        <div className="discovery-coverage-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="mono">{pct}%</span>
      </div>
    </li>
  )
}
