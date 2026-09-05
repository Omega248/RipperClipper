import { useEffect, useMemo, useState } from 'react'
import { workflowOf } from '@shared/collections'
import { atRisk, byUrgency, estimateExpiry, expiryShort } from '@shared/expiry'
import type { ExpiryEstimate } from '@shared/expiry'
import { isFailed } from '@shared/jobs'
import { povColor } from '@shared/povColors'
import { timeAgo } from '@shared/time'
import type { ClipSegment, ExportJob, ProjectFile, VodSource } from '@shared/types'
import type { SavedStreamer } from '@shared/ipc'
import { personAvatar, personName } from '@shared/people'
import { useStore } from '../store.js'
import { openClip } from '../navigate.js'
import { eventLabel } from './AppRail.js'
import StreamerAvatar from './StreamerAvatar.js'
import { Button, EmptyState, Icon, Spinner } from '../ui/index.js'

/**
 * Where the app opens: the work that is waiting.
 *
 * This replaced a launcher. The old Home showed a continue card, the last four
 * clips and four buttons — a good page for someone resuming one thing, and the
 * wrong page for this job. At a hundred streamers and thousands of clips the
 * work is a queue, a slice of three recents is a peephole onto it, and the
 * only signal about volume was a sentence with nothing to click.
 *
 * So the page is ordered by the only deadline the app actually has: Twitch
 * deletes VODs after a fortnight. Three bands, each a queue you can enter and
 * advance through — expiring, cut but not exported, failed. Resume survives as
 * one row, because that is how much value it was carrying.
 *
 * Every band label states a real total, never the length of what is rendered.
 * A count you cannot trust is worse than no count.
 *
 * TODO(SHELL-V2 §0): the design leads with expiry across the whole *library*,
 * which needs `ProjectSummary` to carry each project's soonest-expiring source
 * — the summary pass would already have `parsed.sources` in hand. Neither
 * `ProjectSummary` nor a summaries IPC exists yet, so every band below is
 * scoped to the open project. Footage in a project nobody has opened this week
 * still expires with no warning here; that is the gap, and it is infrastructure
 * rather than design.
 */
export default function BacklogPage({
  onLoadVod
}: {
  /** Loads a channel or VOD URL into the open event. */
  onLoadVod?: (url: string) => Promise<void> | void
}): JSX.Element {
  const project = useStore((s) => s.project)
  const jobs = useStore((s) => s.jobs)
  const setRoute = useStore((s) => s.setRoute)
  const startReviewRun = useStore((s) => s.startReviewRun)
  const streamers = useStore((s) => s.streamers)
  // Shared, and already loaded at startup — this page draws its Live now band
  // on the first paint rather than a fetch later.
  const live = useStore((s) => s.liveNow)
  const setLiveNow = useStore((s) => s.setLiveNow)
  const [opening, setOpening] = useState<string | null>(null)

  /*
   * Who is on air, right now.
   *
   * The most time-critical thing this app knows and the one thing this page
   * did not say. Every band here is scoped to the *open project*, so with one
   * project open and nothing cut in it the page was empty while the library
   * held forty-five streamers — several of them broadcasting. A broadcast in
   * progress is also the only footage whose deadline you can still beat by
   * acting now, which is exactly what this page is ordered by.
   *
   * Read from the saved snapshot first because it is on disk and answers
   * instantly; the live check follows and overwrites it.
   */
  useEffect(() => {
    let cancelled = false
    const check = (): void => {
      void window.api
        .streamersLive()
        .then((next) => {
          if (!cancelled) setLiveNow(next)
        })
        .catch(() => undefined)
    }
    check()
    const timer = setInterval(check, 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [setLiveNow])

  /**
   * One row per person, not per account — the same rule the roster uses. A
   * restreamer on Kick and Twitch is one person going live, not two, and the
   * account that fronts the row is the one actually on air.
   */
  const liveRows = useMemo(() => {
    const loaded = new Set((project?.sources ?? []).map((s) => s.url))
    const byPerson = new Map<string, SavedStreamer[]>()
    for (const streamer of streamers) {
      const key = streamer.personId ?? streamer.id
      const group = byPerson.get(key)
      if (group) group.push(streamer)
      else byPerson.set(key, [streamer])
    }
    return [...byPerson.values()]
      .map((accounts) => {
        const onAir = accounts.filter((a) => live[a.id] !== undefined)
        if (onAir.length === 0) return null
        const primary = onAir[0]
        return {
          accounts,
          primary,
          now: live[primary.id],
          alreadyLoaded: loaded.has(primary.channelUrl)
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => (b.now.viewers ?? 0) - (a.now.viewers ?? 0))
  }, [streamers, live, project?.sources])

  const expiring = useMemo<ExpiringRow[]>(() => {
    if (!project) return []
    const rows: ExpiringRow[] = []
    for (const source of project.sources) {
      const estimate = estimateExpiry(source.platform, source.createdAt)
      if (!atRisk(estimate)) continue
      rows.push({
        key: source.id,
        sourceId: source.id,
        title: source.title,
        who: source.creator ?? '',
        event: eventLabel(project),
        clips: clipsCutIn(project.clips, source),
        estimate
      })
    }
    return rows.sort((a, b) => byUrgency(a.estimate, b.estimate))
  }, [project])

  const unexportedClips = useMemo(
    () => (project?.clips ?? []).filter((c) => workflowOf(c) !== 'exported'),
    [project]
  )
  const unexportedTotal = unexportedClips.length
  const failedJobs = jobs.filter((j) => isFailed(j.progress.stage))

  const nothingWaiting =
    expiring.length === 0 &&
    unexportedTotal === 0 &&
    failedJobs.length === 0 &&
    liveRows.length === 0

  return (
    <div className="page backlog-page">
      <div>
        <h1 className="home-title">Backlog</h1>
        <p className="home-sub">
          Ordered by the only deadline the app has — when the footage disappears.
        </p>

        {project && (
          <button type="button" className="backlog-resume" onClick={() => setRoute('workspace')}>
            <span className="backlog-resume-bar" aria-hidden="true" />
            <span className="backlog-resume-name">Resume — {eventLabel(project)}</span>
            <span className="backlog-resume-meta">{resumeMeta(project)}</span>
            <Icon name="chevron-right" size={15} className="icon-chevron" />
          </button>
        )}

        {nothingWaiting && (
          <EmptyState
            icon="check"
            title="Nothing waiting."
            description="No angles expiring, nothing cut but unexported, no failed exports."
          />
        )}

        {liveRows.length > 0 && (
          <section className="backlog-band">
            <header className="backlog-band-head">
              <span className="backlog-band-label is-live">
                <span className="backlog-live-dot" aria-hidden="true" />
                Live now · {liveRows.length}
              </span>
              <span className="backlog-band-rule" aria-hidden="true" />
              <Button size="compact" variant="ghost" onClick={() => setRoute('streamers')}>
                All streamers
              </Button>
            </header>

            <div className="backlog-rows">
              {liveRows.map(({ accounts, primary, now, alreadyLoaded }) => (
                <button
                  type="button"
                  key={primary.id}
                  className="backlog-row"
                  disabled={alreadyLoaded || opening !== null || !onLoadVod}
                  title={
                    alreadyLoaded
                      ? `${personName(accounts)} is already an angle in this event`
                      : `Load ${personName(accounts)}'s broadcast as an angle`
                  }
                  onClick={async () => {
                    if (!onLoadVod) return
                    setOpening(primary.id)
                    try {
                      await onLoadVod(primary.channelUrl)
                    } finally {
                      setOpening(null)
                    }
                  }}
                >
                  <StreamerAvatar
                    name={personName(accounts)}
                    platform={primary.platform}
                    url={personAvatar(accounts)}
                    size={34}
                  />
                  <span className="backlog-row-main">
                    <span className="backlog-row-title ellipsis">
                      {personName(accounts)}
                      <span className="backlog-row-platform">{primary.platform}</span>
                    </span>
                    <span className="backlog-row-sub ellipsis">{now.title ?? 'Broadcasting now'}</span>
                  </span>
                  <span className="backlog-row-clips">
                    {now.viewers !== undefined ? `${now.viewers.toLocaleString()} watching` : ''}
                  </span>
                  <span className="backlog-row-expiry is-live">
                    {opening === primary.id ? <Spinner /> : alreadyLoaded ? 'loaded' : 'live'}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* An empty band is omitted, never rendered as a zero. */}
        {expiring.length > 0 && (
          <section className="backlog-band">
            <header className="backlog-band-head">
              <span className="backlog-band-label is-urgent">Expiring · {expiring.length}</span>
              <span className="backlog-band-rule" aria-hidden="true" />
              <Button
                size="compact"
                variant="primary"
                disabled={unexportedClips.length === 0}
                onClick={() => {
                  startReviewRun(unexportedClips.map((c) => c.id))
                  const first = unexportedClips[0]
                  if (first) openClip(first.id)
                }}
              >
                Start a review run
              </Button>
            </header>

            <div className="backlog-rows">
              {expiring.map((row) => (
                <button
                  type="button"
                  key={row.key}
                  className="backlog-row"
                  onClick={() => setRoute('workspace')}
                >
                  <span
                    className="backlog-row-thumb"
                    aria-hidden="true"
                    style={{
                      background: `linear-gradient(140deg, color-mix(in srgb, var(--stage) 76%, ${povColor(
                        row.sourceId
                      )}), var(--stage))`
                    }}
                  />
                  <span className="backlog-row-main">
                    <span className="backlog-row-title ellipsis">{row.title}</span>
                    <span className="backlog-row-sub ellipsis">
                      {row.who ? `${row.who} · ` : ''}
                      {row.event}
                    </span>
                  </span>
                  <span className="backlog-row-clips">{row.clips}</span>
                  {/* Short form, not estimate.label: "About 3 days left" is
                      right in a VOD row and too long for a column you read
                      down. An unknown date shows as an em dash rather than
                      being hidden — a VOD nobody can place is worth checking. */}
                  <span
                    className={`backlog-row-expiry ${urgencyClass(row.estimate)}`}
                    title={row.estimate.note}
                  >
                    {expiryShort(row.estimate)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {unexportedTotal > 0 && (
          <section className="backlog-band">
            <header className="backlog-band-head">
              <span className="backlog-band-label">Cut, not exported · {unexportedTotal}</span>
              <span className="backlog-band-rule" aria-hidden="true" />
              <Button size="compact" icon="download" onClick={() => setRoute('export')}>
                Export all {unexportedTotal}
              </Button>
            </header>

            <div className="backlog-tiles">
              {unexportedClips.slice(0, 6).map((clip) => (
                <button
                  type="button"
                  key={clip.id}
                  className="backlog-tile"
                  onClick={() => openClip(clip.id)}
                >
                  <span
                    className="backlog-tile-thumb"
                    aria-hidden="true"
                    style={{
                      background: `linear-gradient(150deg, color-mix(in srgb, var(--stage) 66%, ${povColor(
                        clip.sourceId
                      )}), var(--stage))`
                    }}
                  />
                  <span className="backlog-tile-body">
                    <span className="backlog-tile-name ellipsis">{clip.name}</span>
                    <span className="backlog-tile-meta ellipsis">
                      {project ? eventLabel(project) : ''} · {coveringCount(clip)} angles
                    </span>
                  </span>
                </button>
              ))}

              {/* Capping the grid is only honest because the label above
                  carries the true total and this is a real destination. */}
              {unexportedTotal > 6 && (
                <button
                  type="button"
                  className="backlog-tile-more"
                  onClick={() => setRoute('clips')}
                >
                  + {unexportedTotal - 6} more
                </button>
              )}
            </div>
          </section>
        )}

        {failedJobs.length > 0 && (
          <section className="backlog-band">
            <header className="backlog-band-head">
              <span className="backlog-band-label is-urgent">
                Failed exports · {failedJobs.length}
              </span>
              <span className="backlog-band-rule" aria-hidden="true" />
              <Button size="compact" icon="refresh" onClick={() => setRoute('export')}>
                Retry {failedJobs.length === 2 ? 'both' : 'all'}
              </Button>
            </header>

            <div className="backlog-fails">
              {failedJobs.map((job) => (
                <div key={job.id} className="backlog-fail">
                  <Icon name="alert" size={15} />
                  <span className="backlog-fail-main">
                    <span className="backlog-fail-name ellipsis">{job.clipName}</span>
                    {/* The real reason, always. "Export failed" is a failure
                        you cannot act on, and the app already knows why. */}
                    <span className="backlog-fail-why ellipsis">
                      {job.error?.message ?? 'The export could not finish.'}
                    </span>
                  </span>
                  <span className="backlog-fail-when">
                    {job.finishedAt ? timeAgo(Date.parse(job.finishedAt)) : ''}
                  </span>
                  <Button size="compact" variant="ghost" onClick={() => setRoute('export')}>
                    Retry
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* The one part of the old Home that earned its place: it answers "what
          is the machine doing", which none of the bands do. */}
      <aside className="home-side">
        <h2 className="home-head">Now running</h2>
        <Activity jobs={jobs} />
        <Button size="compact" variant="ghost" onClick={() => setRoute('export')}>
          Open export queue
          <Icon name="chevron-right" size={13} />
        </Button>
      </aside>
    </div>
  )
}

interface ExpiringRow {
  key: string
  sourceId: string
  title: string
  who: string
  event: string
  clips: string
  estimate: ExpiryEstimate
}

function urgencyClass(estimate: ExpiryEstimate): string {
  if (estimate.urgency === 'gone' || estimate.urgency === 'critical') return 'is-critical'
  if (estimate.urgency === 'soon') return 'is-soon'
  return ''
}

function clipsCutIn(clips: ClipSegment[], source: VodSource): string {
  const n = clips.filter((c) => c.sourceId === source.id).length
  return n === 0 ? 'Nothing cut yet' : `${n} clip${n === 1 ? '' : 's'} cut`
}

function coveringCount(clip: ClipSegment): number {
  return (clip.povMappings ?? []).filter(
    (m) => m.status === 'available' || m.status === 'partial'
  ).length
}

function resumeMeta(project: ProjectFile): string {
  const angles = project.sources.length
  const clips = project.clips.length
  const unexported = project.clips.filter((c) => workflowOf(c) !== 'exported').length
  const parts = [
    `${angles} angle${angles === 1 ? '' : 's'}`,
    `${clips} clip${clips === 1 ? '' : 's'}`
  ]
  if (unexported > 0) parts.push(`${unexported} unexported`)
  if (project.updatedAt) parts.push(timeAgo(Date.parse(project.updatedAt)))
  return parts.join(' · ')
}

/**
 * What the app is doing without being asked.
 *
 * Failures are deliberately absent: the band above owns them, and a failure
 * that appears in two places at once is a failure you count twice.
 */
function Activity({ jobs }: { jobs: ExportJob[] }): JSX.Element {
  const items: Array<{ id: string; tone: string; title: string; body: string; progress?: number }> =
    []

  for (const job of jobs) {
    if (job.progress.stage === 'complete') continue
    if (job.progress.stage === 'failed') continue
    items.push({
      id: job.id,
      tone: 'accent',
      title: `Exporting ${job.clipName}`,
      body: `${job.progress.stage} · ${Math.round(job.progress.overallProgress * 100)}%`,
      progress: job.progress.overallProgress
    })
  }

  for (const job of jobs.filter((j) => j.progress.stage === 'complete').slice(-2)) {
    items.push({
      id: job.id,
      tone: 'success',
      title: `${job.clipName} exported`,
      body: job.outputPath ?? 'Written to the output folder'
    })
  }

  if (items.length === 0) {
    return <p className="home-quiet">Nothing running. Clips you export show up here.</p>
  }

  return (
    <div className="home-activity">
      {items.map((item) => (
        <div key={item.id} className={`home-activity-row is-${item.tone}`}>
          <span className="home-activity-dot" aria-hidden="true" />
          <span className="home-activity-text">
            <span className="home-activity-title ellipsis">{item.title}</span>
            <span className="home-activity-body ellipsis">{item.body}</span>
            {item.progress !== undefined && (
              <span className="home-activity-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
