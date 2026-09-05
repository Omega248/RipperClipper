import { useMemo, useState } from 'react'
import { byUrgency, estimateExpiry, expiryShort } from '@shared/expiry'
import type { ExpiryEstimate } from '@shared/expiry'
import { isSynced } from '@shared/sync'
import { povColor } from '@shared/povColors'
import { formatTimecode } from '@shared/time'
import type { PlatformId, VodSource } from '@shared/types'
import { useStore } from '../store.js'
import EventDiscovery from './EventDiscovery.js'
import { message, title as errTitle } from './QualityPanel.js'
import { Badge, Button, EmptyState, Icon, Input } from '../ui/index.js'

/**
 * The footage: what is loaded, and what could be.
 *
 * A row leads with the thing that decides what to do next — whether it is
 * aligned to the event clock, and how long the platform will keep it. Twitch
 * drops VODs after a fortnight, so "18h" is more actionable than any amount of
 * metadata.
 *
 * What changed in v2, and why:
 *
 * **Retrieval.** A platform dropdown was the whole story, which at 812 rows
 * narrows a list of eight hundred to a list of five hundred. Search leads the
 * header now, platform is chips beside it, and the default sort is expiry —
 * the deadline, not the upload date.
 *
 * **Density.** Rows were three lines and a thumbnail, about 76px, so a 1080p
 * window showed nine rows of a list that wants to be scanned in dozens. The
 * facts were not wrong, they were stacked: nothing could be compared down a
 * column. Two lines and aligned columns puts twenty-two in the same space and
 * makes expiry readable top to bottom.
 *
 * **Receipts.** A resolve used to be a spinner on a button and, on failure, a
 * toast and nothing else — paste ten links and you could not tell which two
 * failed. Every paste appends a row immediately: skeleton, then the real row,
 * or an error row that states the reason and offers a retry. The row is the
 * record; the toast is still the notification.
 *
 * TODO(SHELL-V2 §4.1): the design's "In this event" scope switch turns this
 * list library-wide. That needs the same `ProjectSummary` work as §0, so the
 * chip is not rendered rather than faked — the page shows the open event.
 */
export default function VodsPage({
  onLoadVod
}: {
  onLoadVod: (url: string) => Promise<void>
}): JSX.Element {
  const project = useStore((s) => s.project)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setRoute = useStore((s) => s.setRoute)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  const [urls, setUrls] = useState('')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [showDiscovery, setShowDiscovery] = useState(false)
  /** Rows for links being resolved right now, keyed by the pasted URL. */
  const [pending, setPending] = useState<PendingRow[]>([])

  const sources = project?.sources ?? []

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = sources.filter((s) => {
      if (platform !== 'all' && s.platform !== platform) return false
      if (needle === '') return true
      return (
        s.title.toLowerCase().includes(needle) || (s.creator ?? '').toLowerCase().includes(needle)
      )
    })

    // Expiry first: the point of the page is what is about to disappear.
    const rows = matched
      .map((source) => ({ source, estimate: estimateExpiry(source.platform, source.createdAt) }))
      .sort((a, b) => byUrgency(a.estimate, b.estimate))

    const byDate = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = dateKey(row.source.createdAt)
      const list = byDate.get(key)
      if (list) list.push(row)
      else byDate.set(key, [row])
    }
    return [...byDate.entries()].map(([label, items]) => ({ label, items }))
  }, [sources, query, platform])

  /**
   * One paste, one row per link. Splitting on whitespace is what makes a
   * multi-paste auditable — ten links, ten rows, and the two that failed stay
   * on screen saying why.
   */
  const load = async (): Promise<void> => {
    const list = urls
      .split(/\s+/)
      .map((u) => u.trim())
      .filter((u) => u !== '')
    if (list.length === 0) return
    setUrls('')
    setPending((p) => [...p, ...list.map((url) => ({ url, error: null as string | null }))])

    for (const url of list) {
      try {
        await onLoadVod(url)
        setPending((p) => p.filter((row) => row.url !== url))
      } catch (err) {
        const reason = message(err)
        // The toast is the notification; the row is the record. Both.
        toast({ kind: 'error', title: errTitle(err, 'Could not load that VOD'), message: reason })
        setPending((p) => p.map((row) => (row.url === url ? { ...row, error: reason } : row)))
      }
    }
  }

  const open = (source: VodSource): void => {
    setActiveSource(source.id)
    setRoute('workspace')
    setPage('video')
  }

  return (
    <div className="page vods-page">
      <div className="vods-head">
        <div className="vods-head-row">
          <h1 className="vods-title">VODs</h1>

          {/* A real input that filters this list. Not the palette trigger in
              the top bar, which is a button shaped like a field — two controls,
              two jobs, and merging them was the old bug. */}
          <label className="vods-search">
            <Icon name="search" size={15} />
            <input
              value={query}
              placeholder={`Search ${sources.length} VODs by title or streamer`}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <span className="spacer" />

          <Input
            value={urls}
            placeholder="Paste one or more links"
            onChange={(e) => setUrls(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load()
            }}
          />
          <Button variant="primary" icon="plus" onClick={() => void load()}>
            Add angle
          </Button>
        </div>

        <div className="vods-filters">
          {(['all', 'twitch', 'kick', 'youtube'] as const).map((id) => (
            <button
              type="button"
              key={id}
              className="ui-chip"
              aria-pressed={platform === id}
              onClick={() => setPlatform(id)}
            >
              {id === 'all' ? 'All platforms' : id}
            </button>
          ))}
          <span className="vods-filter-divider" aria-hidden="true" />
          <Badge tone="neutral">Expiring first</Badge>
          <Button size="compact" icon="search" onClick={() => setShowDiscovery(true)}>
            Find angles by time
          </Button>
          <span className="vods-filter-note">
            Sorted by expiry · {sources.length} row{sources.length === 1 ? '' : 's'}
          </span>
        </div>

        {/* Column heads. Without them an aligned row is a row with gaps. */}
        <div className="vod-cols" aria-hidden="true">
          <span />
          <span>VOD</span>
          <span>Platform</span>
          <span>Started</span>
          <span>Length</span>
          <span>State</span>
          <span style={{ textAlign: 'right' }}>Expires</span>
          <span />
        </div>
      </div>

      <div className="vods-scroll">
        {sources.length === 0 && pending.length === 0 ? (
          <EmptyState
            icon="monitor"
            title="No angles loaded yet."
            description='Paste a link above, or use "Find angles by time" to sweep for everyone who was live.'
          />
        ) : (
          <div className={`vods-list${sources.length > 200 ? ' is-long' : ''}`}>
            {pending.length > 0 && (
              <div className="vod-group-rows">
                {pending.map((row) => (
                  <PendingVodRow
                    key={row.url}
                    row={row}
                    onRetry={() => {
                      setPending((p) => p.filter((r) => r.url !== row.url))
                      setUrls(row.url)
                    }}
                  />
                ))}
              </div>
            )}

            {groups.map((group) => (
              <div key={group.label}>
                <div className="vod-group-head">
                  <span className="vod-group-date">{group.label}</span>
                  <span className="vod-group-note">
                    {group.items.length} of {sources.length} loaded
                  </span>
                </div>
                <div className="vod-group-rows">
                  {group.items.map(({ source, estimate }) => (
                    <VodRow
                      key={source.id}
                      source={source}
                      estimate={estimate}
                      onOpen={() => open(source)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showDiscovery && (
        <EventDiscovery onClose={() => setShowDiscovery(false)} onLoadVod={onLoadVod} />
      )}
    </div>
  )
}

interface PendingRow {
  url: string
  error: string | null
}

function VodRow({
  source,
  estimate,
  onOpen
}: {
  source: VodSource
  estimate: ExpiryEstimate
  onOpen: () => void
}): JSX.Element {
  const synced = source.syncMapping ? isSynced(source.syncMapping) : false
  const state = synced
    ? { dot: 'is-loaded', label: 'In event' }
    : { dot: 'is-align', label: 'Needs align' }

  // A div rather than a button: the row carries its own Open button, and a
  // button inside a button is invalid markup that React will not render as
  // written. The keyboard handling a real button would have given is restored
  // explicitly rather than dropped.
  return (
    <div
      className="vod-row"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <span
        className="vod-row-thumb"
        aria-hidden="true"
        style={{
          background: `linear-gradient(140deg, color-mix(in srgb, var(--stage) 78%, ${povColor(
            source.id
          )}), var(--stage))`
        }}
      />
      <span className="vod-row-main">
        <span className="vod-row-title ellipsis">{source.title}</span>
        <span className="vod-row-sub ellipsis">{source.creator ?? ''}</span>
      </span>
      {/* The word, not a coloured pill: at this density a pill per row is
          noise, and .streamer-platform keeps its job on the sparser pages. */}
      <span className="vod-row-plat">{source.platform}</span>
      <span className="vod-row-mono">
        {source.createdAt
          ? new Date(source.createdAt).toLocaleTimeString(undefined, { hour12: false })
          : '—'}
      </span>
      <span className="vod-row-mono">
        {formatTimecode(source.durationSeconds, { millis: false })}
      </span>
      <span className="vod-row-state">
        <span className={`vod-row-dot ${state.dot}`} aria-hidden="true" />
        {state.label}
      </span>
      <span className={`vod-row-expiry ${urgencyClass(estimate)}`} title={estimate.note}>
        {expiryShort(estimate)}
      </span>
      <Button
        size="compact"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        Open
      </Button>
    </div>
  )
}

/**
 * A link that is still resolving, or one that failed.
 *
 * It occupies the same grid as a real row so the list does not jump when it
 * fills in, and a failure keeps its place until dismissed — the receipt for a
 * paste that did not work.
 */
function PendingVodRow({ row, onRetry }: { row: PendingRow; onRetry: () => void }): JSX.Element {
  if (row.error) {
    return (
      <div className="vod-row is-failed">
        <span className="vod-row-thumb" aria-hidden="true" />
        <span className="vod-row-main">
          <span className="vod-row-title ellipsis">{row.url}</span>
          <span className="vod-row-sub ellipsis">{row.error}</span>
        </span>
        <span className="vod-row-plat" />
        <span className="vod-row-mono" />
        <span className="vod-row-mono" />
        <span className="vod-row-state">
          <span className="vod-row-dot is-failed" aria-hidden="true" />
          Failed
        </span>
        <span className="vod-row-expiry" />
        <Button size="compact" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="vod-row is-resolving">
      <span className="vod-row-thumb" aria-hidden="true" />
      <span className="vod-row-main">
        <span className="vod-skel vod-skel-title" />
        <span className="vod-skel vod-skel-sub" />
      </span>
      <span className="vod-row-plat" />
      <span className="vod-row-mono" />
      <span className="vod-row-mono" />
      <span className="vod-row-state">
        <span className="vod-row-dot is-resolving" aria-hidden="true" />
        Resolving
      </span>
      <span className="vod-row-expiry" />
      <span />
    </div>
  )
}

function urgencyClass(estimate: ExpiryEstimate): string {
  if (estimate.urgency === 'gone' || estimate.urgency === 'critical') return 'is-critical'
  if (estimate.urgency === 'soon') return 'is-soon'
  return ''
}

/** Group label: "Today · 21 Aug 2026". Undated VODs group together, last. */
function dateKey(createdAt: string | undefined): string {
  if (!createdAt) return 'Date unknown'
  const date = new Date(createdAt)
  const full = date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
  const today = new Date()
  const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  if (sameDay(date, today)) return `Today · ${full}`
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (sameDay(date, yesterday)) return `Yesterday · ${full}`
  return full
}
