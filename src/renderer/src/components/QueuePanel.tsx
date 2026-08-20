import { useState } from 'react'
import { formatBytes } from '@shared/errors'
import { jobStatus, STATUS } from '@shared/status'
import { formatDuration } from '@shared/time'
import type { ExportJob } from '@shared/types'
import { useStore } from '../store.js'
import { Button, IconButton, ProgressBar, StatusBadge } from '../ui/index.js'

/**
 * The export queue.
 *
 * Every job says the same four things in the same order: what it is, how far
 * along, how big or how fast, and what can be done about it. Failures show the
 * plain sentence; the exit code and the command behind it stay in the log.
 */
export default function QueuePanel(): JSX.Element {
  const jobs = useStore((s) => s.jobs)
  const [collapsed, setCollapsed] = useState(false)
  const [paused, setPaused] = useState(false)

  const active = jobs.filter((j) => !isFinished(j)).length
  const failed = jobs.filter((j) => j.progress.stage === 'failed').length

  return (
    <section className="queue" aria-label="Export queue">
      <div className="queue-head">
        <h3>Exports</h3>
        <span className="job-stat">
          {jobs.length === 0
            ? 'Nothing queued'
            : `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${active} active${
                failed > 0 ? ` · ${failed} failed` : ''
              }`}
        </span>
        <span className="spacer" />
        <Button
          size="compact"
          icon={paused ? 'play' : 'pause'}
          disabled={jobs.length === 0}
          selected={paused}
          onClick={() => {
            if (paused) void window.api.resumeQueue()
            else void window.api.pauseQueue()
            setPaused(!paused)
          }}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          size="compact"
          icon="refresh"
          disabled={failed === 0}
          onClick={() => void window.api.retryAllFailed()}
        >
          Retry failed
        </Button>
        <Button
          size="compact"
          disabled={jobs.length === 0}
          onClick={() => void window.api.clearFinished()}
        >
          Clear finished
        </Button>
        {jobs.length > 0 && (
          <IconButton
            icon={collapsed ? 'chevron-up' : 'chevron-down'}
            label={collapsed ? 'Show the queue' : 'Hide the queue'}
            size="compact"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          />
        )}
      </div>
      {/*
        * An empty queue is one line, not a panel: on the Video page this dock
        * sits under the timeline, and a permanent 150px of "nothing here" is
        * height taken from the picture.
        */}
      {!collapsed && jobs.length > 0 && (
        <div className="queue-list">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </section>
  )
}

function JobRow({ job }: { job: ExportJob }): JSX.Element {
  const stage = job.progress.stage
  const status = jobStatus(stage)
  const fraction = stage === 'complete' ? 1 : job.progress.overallProgress
  const pct = Math.round(job.progress.overallProgress * 100)

  return (
    <div className="job">
      <StatusBadge status={status} />
      <span className="job-name" title={job.outputPath ?? job.clipName}>
        {job.clipName}
      </span>
      <div>
        <ProgressBar
          value={fraction}
          tone={stage === 'complete' ? 'success' : stage === 'failed' ? 'danger' : 'accent'}
          label={`${job.clipName} progress`}
        />
        <div className="job-msg">
          {stage === 'failed' && job.error ? job.error.message : job.progress.message}
          {job.verification && !job.verification.ok && ` — ${job.verification.problems.join('; ')}`}
        </div>
      </div>
      <span className="job-stat">
        {stage === 'complete'
          ? `${formatBytes(job.verification?.sizeBytes ?? 0)} · ${formatDuration(job.verification?.durationSeconds ?? 0)}`
          : STATUS[status].busy
            ? `${pct}%${job.progress.bytesPerSecond > 0 ? ` · ${formatBytes(job.progress.bytesPerSecond)}/s` : ''}${
                job.progress.etaSeconds ? ` · ${formatDuration(job.progress.etaSeconds)} left` : ''
              }`
            : ''}
      </span>
      <span style={{ display: 'flex', gap: 2, whiteSpace: 'nowrap' }}>
        {stage === 'complete' && job.outputPath && (
          <>
            <IconButton
              icon="play"
              size="compact"
              label="Play the exported file"
              onClick={() => void window.api.openPath(job.outputPath!)}
            />
            <IconButton
              icon="folder"
              size="compact"
              label="Show in folder"
              onClick={() => void window.api.revealPath(job.outputPath!)}
            />
          </>
        )}
        {(stage === 'failed' || stage === 'cancelled') && (
          <Button size="compact" icon="refresh" onClick={() => void window.api.retryJob(job.id)}>
            Retry
          </Button>
        )}
        {!isFinished(job) && (
          <IconButton
            icon="close"
            size="compact"
            label="Cancel this export"
            onClick={() => void window.api.cancelJob(job.id)}
          />
        )}
      </span>
    </div>
  )
}

function isFinished(job: ExportJob): boolean {
  const s = job.progress.stage
  return s === 'complete' || s === 'failed' || s === 'cancelled'
}
