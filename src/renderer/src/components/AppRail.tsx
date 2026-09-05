import { useEffect } from 'react'
import type { AppRoute } from '../store.js'
import { useStore } from '../store.js'
import { isFailed, isSettled } from '@shared/jobs'
import type { ProjectFile } from '@shared/types'
import { Icon, Tooltip } from '../ui/index.js'
import type { IconName } from '../ui/index.js'

/**
 * The app's permanent left rail.
 *
 * Everything above it in the old shell was a tab strip *inside* one project,
 * which left the app with nowhere to stand when no project was open. The rail
 * is chrome: it is the same in every state, so "where am I" and "what else is
 * there" are answerable without opening anything.
 *
 * It is also the *only* navigation. A title-bar strip for Video / Properties /
 * Export survived the first pass and turned out to be worse than redundant:
 * two controls could disagree about where you were — the rail reading VODs
 * while the strip read Export — and neither was wrong, because they tracked
 * different state. There is one axis now, and this is it.
 *
 * Two zones. The items used to render as identical peers, but they were two
 * different kinds of thing — libraries that exist whether or not anything is
 * open, and views of the currently open event. Library above, the open event
 * below, named. With no project open the second zone is absent entirely, which
 * is more informative than three destinations that dead-end.
 *
 * What changed in the redesign:
 *
 *  - The bottom of the rail was a Settings row followed by a bare chevron
 *    floating in its own right-aligned footer. It read as a stray control
 *    rather than part of the list, and it hid Diagnostics — which the live
 *    workflow needs often enough to deserve a destination. Settings,
 *    Diagnostics and Collapse are now three peers in the same row shape as
 *    every other item, under a rule that marks them as chrome rather than
 *    content. Collapse carries a label when there is room for one; a control
 *    whose whole job is to change the layout should not be the one thing in
 *    the rail you have to hover to identify.
 *
 *  - The brand is the product mark rather than an abstract accent bar, at a
 *    size that survives the collapsed rail (where it is the only thing left).
 *
 * It collapses to icons below a threshold width — but a collapse the editor
 * asked for outranks the window, so dragging back to full width never undoes
 * a deliberate choice.
 */

/** Below this, the rail is icons only unless the editor says otherwise. */
const COLLAPSE_WIDTH = 1440

interface RailItem {
  route: AppRoute
  label: string
  icon: IconName
  /** A count worth knowing without opening the page. Zero and undefined both hide it. */
  count?: number
  /**
   * Something needs attention here. Deliberately not the same thing as the
   * collapsed count dot: that one means "there is something here", this means
   * "something failed". Both can be true at once, so they cannot share a mark.
   */
  flag?: boolean
  /** Live media is attached to this destination right now. */
  live?: boolean
}

export default function AppRail(): JSX.Element {
  const route = useStore((s) => s.route)
  const setRoute = useStore((s) => s.setRoute)
  const collapsed = useStore((s) => s.railCollapsed)
  const toggleRail = useStore((s) => s.toggleRail)
  const setByWidth = useStore((s) => s.setRailCollapsedByWidth)
  const project = useStore((s) => s.project)
  const streamers = useStore((s) => s.streamers)
  const jobs = useStore((s) => s.jobs)

  // The window decides the default; `setRailCollapsedByWidth` is what keeps a
  // user override winning over it.
  useEffect(() => {
    const apply = (): void => setByWidth(window.innerWidth < COLLAPSE_WIDTH)
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [setByWidth])

  // The old count was `stage !== 'complete'`, which counts failed and
  // cancelled jobs as pending — so two cancelled exports read as "2" on Export
  // forever, and a badge that is never right is a badge you learn to ignore.
  // In-flight is the number; failure is the flag.
  const inFlight = jobs.filter((j) => !isSettled(j.progress.stage)).length
  const failures = jobs.filter((j) => isFailed(j.progress.stage)).length

  // A source is live if it is a live source that has not ended. The rail only
  // needs to know whether *any* of them is, so this stays a boolean — the
  // count belongs in the header chip, where there is room to say whose.
  const anyLive = (project?.sources ?? []).some((s) => s.live?.state === 'live')

  const library: RailItem[] = [
    { route: 'home', label: 'Backlog', icon: 'target', flag: failures > 0 },
    { route: 'projects', label: 'Events', icon: 'folder' },
    { route: 'streamers', label: 'Streamers', icon: 'users', count: streamers.length },
    // TODO(SHELL-V2 §0): this count is library-wide in the design. Until
    // ProjectSummary carries the source facts, the open project is all the
    // renderer can see, so it counts that rather than inventing a number.
    {
      route: 'vods',
      label: 'VODs & live',
      icon: 'monitor',
      count: project?.sources.length,
      live: anyLive
    }
  ]

  // Views of the open event. Properties is deliberately absent: it describes
  // whatever is selected in the workspace, so arriving at it with nothing
  // selected dead-ends — it belongs beside the clip list as an inspector, not
  // in the rail.
  const event: RailItem[] = [
    { route: 'workspace', label: 'Watch', icon: 'play', live: anyLive },
    { route: 'clips', label: 'Clips', icon: 'scissors', count: project?.clips.length },
    { route: 'export', label: 'Export', icon: 'download', count: inFlight, flag: failures > 0 }
  ]

  return (
    <nav className={`app-rail${collapsed ? ' is-collapsed' : ''}`} aria-label="Sections">
      <div className="app-rail-brand">
        <RailMark />
        {!collapsed && <span className="app-rail-word">RIPPER CLIPPER</span>}
      </div>

      {!collapsed && <span className="app-rail-zone">Library</span>}
      <ul className="app-rail-items">
        {library.map((item) => (
          <li key={item.route}>
            <RailButton
              item={item}
              active={route === item.route}
              collapsed={collapsed}
              onGo={setRoute}
            />
          </li>
        ))}
      </ul>

      {/* With nothing open there is no second zone at all — no header, no
          items, not even the rule. The absence is the information. */}
      {project && (
        <>
          <span className="app-rail-zone-rule" aria-hidden="true" />

          {!collapsed && (
            <span className="app-rail-event">
              <span className="app-rail-zone">Open event</span>
              <span className="app-rail-event-name ellipsis">{eventLabel(project)}</span>
              <span className="app-rail-event-meta">{eventMeta(project)}</span>
            </span>
          )}

          <ul className="app-rail-items">
            {event.map((item) => (
              <li key={item.route}>
                <RailButton
                  item={item}
                  active={route === item.route}
                  collapsed={collapsed}
                  onGo={setRoute}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <span className="spacer" />

      {/*
        Chrome, not content. The rule is what separates "places in your work"
        from "the app itself" — without it Settings reads as one more library.

        Collapse is a peer here rather than a floating chevron in its own
        footer: it is the same size and shape as the rows above it, so the
        column has one silhouette instead of a list plus an outlier.
      */}
      <span className="app-rail-zone-rule" aria-hidden="true" />
      <ul className="app-rail-items app-rail-chrome">
        <li>
          <RailButton
            item={{ route: 'settings', label: 'Settings', icon: 'settings' }}
            active={route === 'settings'}
            collapsed={collapsed}
            onGo={setRoute}
          />
        </li>
        <li>
          <RailButton
            item={{ route: 'settings', label: 'Diagnostics', icon: 'activity' }}
            active={false}
            collapsed={collapsed}
            onGo={() => {
              // Diagnostics is a tab of Settings, not a route of its own —
              // giving it a route would make the rail and the tab strip
              // disagree about where you are, which is the exact failure the
              // old title-bar strip had.
              useStore.getState().setSettingsTab('diagnostics')
              setRoute('settings')
            }}
          />
        </li>
        <li>
          <button
            type="button"
            className="app-rail-item"
            onClick={toggleRail}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          >
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
            {!collapsed && <span className="app-rail-label ellipsis">Collapse</span>}
          </button>
        </li>
      </ul>
    </nav>
  )
}

/**
 * The product mark: a player frame with the selected range beneath it — the
 * two things the app is, drawn on a 24-unit grid so it holds at 16px in a
 * title bar. `currentColor` so the rail decides the tint and the same file can
 * be reused reversed over video in the watermark preview.
 */
export function RailMark({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="app-rail-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Ripper Clipper"
    >
      <rect
        x="3.2"
        y="4.2"
        width="17.6"
        height="10.4"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M10.2 7.4v4.2l3.8-2.1z" fill="currentColor" />
      <rect x="3.2" y="17.6" width="17.6" height="2.6" rx="1.3" fill="currentColor" opacity=".28" />
      <rect x="7.4" y="17.6" width="8" height="2.6" rx="1.3" fill="currentColor" />
    </svg>
  )
}

/**
 * What to call the open project.
 *
 * `eventName || name` was being decided independently in the rail, the top bar
 * and Home — which is how "project" and "event" ended up meaning the same
 * thing under two names. One helper, used everywhere, or it drifts again.
 */
export function eventLabel(project: ProjectFile): string {
  return project.event?.name || project.name
}

function eventMeta(project: ProjectFile): string {
  const angles = project.sources.length
  const start = project.event?.startSeconds
  const date =
    typeof start === 'number'
      ? new Date(start * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : null
  const count = `${angles} angle${angles === 1 ? '' : 's'}`
  return date ? `${date} · ${count}` : count
}

function RailButton({
  item,
  active,
  collapsed,
  onGo
}: {
  item: RailItem
  active: boolean
  collapsed: boolean
  onGo: (route: AppRoute) => void
}): JSX.Element {
  const showCount = typeof item.count === 'number' && item.count > 0

  const button = (
    <button
      type="button"
      className={`app-rail-item${active ? ' on' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => onGo(item.route)}
    >
      <Icon name={item.icon} size={16} />
      {!collapsed && <span className="app-rail-label ellipsis">{item.label}</span>}
      {/*
        Three marks that can each appear independently, so each has its own
        class and its own meaning:
          live  — there is live media behind this destination
          flag  — something behind it failed
          count — how many things are behind it
        Live and flag are both 5px and survive collapse; the count does not.
      */}
      {item.live && <span className="app-rail-live" aria-label="Live now" />}
      {item.flag && <span className="app-rail-flag" aria-label="Needs attention" />}
      {showCount &&
        (collapsed ? (
          <span className="app-rail-dot" aria-hidden="true" />
        ) : (
          <span className="app-rail-count mono">{item.count}</span>
        ))}
    </button>
  )

  // Collapsed there is no label, so the name has to come from somewhere.
  return collapsed ? (
    <Tooltip content={showCount ? `${item.label} · ${item.count}` : item.label} placement="bottom">
      {button}
    </Tooltip>
  ) : (
    button
  )
}
