import { eventCoverageFraction, eventWindow } from '@shared/event'
import { workflowOf } from '@shared/collections'
import { povColor } from '@shared/povColors'
import { formatDuration } from '@shared/time'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { Button, EmptyState, Icon } from '../ui/index.js'

/**
 * Where the app opens.
 *
 * The old shell dropped you straight onto an empty video stage with no
 * project, which is the least useful thing it could show. Home exists to
 * answer one question — "pick it back up" — so the first thing on screen is
 * the work already in progress rather than an invitation to start from
 * nothing.
 */
export default function HomePage({
  onOpenProject,
  onNewProject,
  onFindVod
}: {
  onOpenProject: () => void
  onNewProject: () => void
  onFindVod: () => void
}): JSX.Element {
  const project = useStore((s) => s.project)
  const recent = useStore((s) => s.recentProjects)
  const setRoute = useStore((s) => s.setRoute)
  const setPage = useStore((s) => s.setPage)
  const selectClip = useStore((s) => s.selectClip)

  const window_ = project ? eventWindow(project) : null
  const coverage = project ? eventCoverageFraction(project) : 0
  const clips = project?.clips ?? []
  const unexported = clips.filter((c) => workflowOf(c) !== 'exported').length

  const openWorkspace = (): void => {
    setRoute('workspace')
    setPage('video')
  }

  return (
    <div className="page home-page">
      <div className="home-columns">
        <div className="home-main">
          <h1 className="home-title">
            {project ? 'Pick the event back up' : 'Start an event'}
          </h1>
          <p className="home-sub">
            {project
              ? unexported > 0
                ? `${unexported} clip${unexported === 1 ? '' : 's'} still to export.`
                : 'Everything here is exported.'
              : 'Load a VOD, or open a project you saved earlier.'}
          </p>

          {project ? (
            <button type="button" className="continue-card" onClick={openWorkspace}>
              <span className="continue-card-head">
                <span className="continue-name ellipsis">{project.event?.name || project.name}</span>
                <Icon name="chevron-right" size={16} />
              </span>

              <span className="continue-when mono">
                {window_
                  ? `${new Date(window_.startSeconds * 1000).toLocaleString()} · ${formatDuration(
                      window_.endSeconds - window_.startSeconds
                    )}`
                  : 'No event window set yet'}
              </span>

              <span className="continue-stats">
                {/* The POV stack says "how many angles" faster than a number. */}
                <span className="pov-stack" aria-hidden="true">
                  {project.sources.slice(0, 6).map((source) => (
                    <span
                      key={source.id}
                      className="pov-chip"
                      style={{ background: povColor(source.id) }}
                      title={povLabel(source, project.sources.indexOf(source))}
                    />
                  ))}
                </span>
                <span>
                  {project.sources.length} angle{project.sources.length === 1 ? '' : 's'}
                </span>
                <span className="dot-sep" aria-hidden="true">
                  ·
                </span>
                <span>
                  {clips.length} clip{clips.length === 1 ? '' : 's'}
                </span>
                <span className="dot-sep" aria-hidden="true">
                  ·
                </span>
                <span>{Math.round(coverage * 100)}% covered</span>
              </span>
            </button>
          ) : (
            <EmptyState
              icon="folder"
              title="Nothing open."
              description="Open a saved project, or paste a VOD link to begin a new one."
            />
          )}

          <div className="home-actions">
            <Button icon="search" onClick={onFindVod}>
              Find a VOD
            </Button>
            <Button icon="open" onClick={onOpenProject}>
              Open project
            </Button>
            <Button icon="users" onClick={() => setRoute('streamers')}>
              Add a streamer
            </Button>
            <Button icon="new" onClick={onNewProject}>
              New project
            </Button>
          </div>

          {clips.length > 0 && (
            <>
              <h2 className="home-section">Recent clips</h2>
              <div className="home-clips">
                {[...clips]
                  .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
                  .slice(0, 4)
                  .map((clip) => (
                    <button
                      key={clip.id}
                      type="button"
                      className="home-clip"
                      onClick={() => {
                        selectClip(clip.id)
                        setRoute('clips')
                      }}
                    >
                      <span
                        className="home-clip-thumb"
                        style={{
                          background: `linear-gradient(150deg, ${povColor(clip.sourceId)}44, var(--stage))`
                        }}
                      >
                        <span className="mono">{formatDuration(clip.durationSeconds)}</span>
                      </span>
                      <span className="home-clip-name ellipsis">{clip.name}</span>
                      <span className="home-clip-meta">
                        {(clip.povMappings?.length ?? 0)} angles · {workflowOf(clip)}
                      </span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </div>

        <aside className="home-side">
          <h2 className="home-section">Recent projects</h2>
          {recent.length === 0 ? (
            <p className="hint">Projects you save show up here.</p>
          ) : (
            <ul className="recent-list">
              {recent.slice(0, 8).map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="recent-item"
                    title={path}
                    onClick={() => void window.api.openProjectPath(path)}
                  >
                    <Icon name="file" size={14} />
                    <span className="ellipsis">{projectName(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  )
}

/** The file's own name, without its path or extension. */
function projectName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.[^.]+$/, '')
}
