import { useMemo, useState } from 'react'
import { filterDiscoveries, sortDiscoveries } from '@shared/discovery'
import type { DiscoveredStream, DiscoverySort } from '@shared/discovery'
import type { EventDiscoveryReply } from '@shared/ipc'
import type { PlatformId } from '@shared/types'
import { parseLocalDateTime } from '@shared/vodSearch'
import { atRisk, estimateExpiry } from '@shared/expiry'
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

/** A datetime-local input value for an epoch-seconds instant, in local time. */
function toLocalInput(seconds: number): string {
  const d = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
  const [linkText, setLinkText] = useState('')
  const [resolvingLink, setResolvingLink] = useState(false)
  const [archiving, setArchiving] = useState<string | null>(null)

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

  /**
   * Turn a clip or timestamped VOD link into the event window.
   *
   * This is the fast way in: you almost never know the wall-clock time a
   * scene happened, but you usually have somebody's clip of it, and that
   * link already carries the answer.
   */
  const resolveLink = async (): Promise<void> => {
    if (linkText.trim() === '') return
    setResolvingLink(true)
    try {
      const result = await window.api.resolveMoment(linkText.trim())
      if (result.momentSeconds === null) {
        toast({ kind: 'error', title: 'Could not place that link', message: result.note })
        return
      }
      // Centre a window on the moment rather than starting at it: a scene
      // builds up before the part somebody chose to clip.
      setStartText(toLocalInput(result.momentSeconds - 5 * 60))
      setEndText(toLocalInput(result.momentSeconds + 10 * 60))
      toast({ kind: 'success', title: 'Found the moment', message: result.note })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not read that link'), message: message(err) })
    } finally {
      setResolvingLink(false)
    }
  }

  /**
   * Keep a POV's scene range on disk before the platform deletes it.
   *
   * The POV is not added to the project: archiving is about not losing the
   * footage, which is a separate decision from committing to use it.
   */
  const archive = async (stream: DiscoveredStream): Promise<void> => {
    const startMs = parseLocalDateTime(startText)
    if (startMs === null || !stream.vod.publishedAt) return
    const started = Date.parse(stream.vod.publishedAt) / 1000
    const from = Math.max(0, startMs / 1000 - started)
    const endMs = parseLocalDateTime(endText)
    const to = endMs !== null ? endMs / 1000 - started : from + DEFAULT_WINDOW_MINUTES * 60
    setArchiving(stream.vod.url)
    try {
      const source = await window.api.resolveSource(stream.vod.url)
      const result = await window.api.archiveRange({
        source,
        startSeconds: from,
        endSeconds: Math.max(from + 10, to)
      })
      toast({
        kind: 'success',
        title: `Kept ${stream.streamerName}`,
        message: `${(result.bytes / 1e6).toFixed(0)}MB saved locally. It stays even if the VOD is deleted.`
      })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not archive it'), message: message(err) })
    } finally {
      setArchiving(null)
    }
  }

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
      <div className="discovery-link">
        <Field
          label="Start from a link"
          hint="Paste a clip, highlight or timestamped VOD link and the time fills itself in."
        >
          <div className="discovery-link-row">
            <Input
              value={linkText}
              placeholder="https://clips.twitch.tv/... or a VOD link with ?t="
              onChange={(e) => setLinkText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void resolveLink()
              }}
            />
            <Button
              icon="target"
              loading={resolvingLink}
              disabled={linkText.trim() === ''}
              onClick={() => void resolveLink()}
            >
              Find the moment
            </Button>
          </div>
        </Field>
      </div>

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
                    onArchive={() => void archive(stream)}
                    archiving={archiving === stream.vod.url}
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
  onToggle,
  onArchive,
  archiving
}: {
  stream: DiscoveredStream
  checked: boolean
  busy: boolean
  onToggle: () => void
  onArchive: () => void
  archiving: boolean
}): JSX.Element {
  const alreadyLoaded = stream.source === 'loaded'
  const pct = Math.round(stream.coverage.fraction * 100)
  const started = stream.vod.publishedAt ? new Date(stream.vod.publishedAt) : null
  // Twitch drops VODs after a fortnight, so what is about to vanish is the
  // most useful thing on the row after coverage itself.
  const expiry = estimateExpiry(stream.platform, stream.vod.publishedAt)

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
          {/* What is about to vanish is the most useful thing on this row
              after coverage: Twitch drops VODs after a fortnight. */}
          {atRisk(expiry) && (
            <Badge tone={expiry.urgency === 'gone' ? 'danger' : 'warning'}>{expiry.label}</Badge>
          )}
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
      <div className="discovery-row-coverage">
        <div className="discovery-coverage-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="mono">{pct}%</span>
        <Button
          size="compact"
          loading={archiving}
          title={`Fetch and keep this range on disk now. ${expiry.note}`}
          onClick={onArchive}
        >
          Keep
        </Button>
      </div>
    </li>
  )
}
