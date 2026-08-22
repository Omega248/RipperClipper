import { useEffect } from 'react'
import type { AppRoute } from '../store.js'
import { useStore } from '../store.js'
import { Icon, IconButton, Tooltip } from '../ui/index.js'
import type { IconName } from '../ui/index.js'

/**
 * The app's permanent left rail.
 *
 * Everything above it in the old shell was a tab strip *inside* one project,
 * which left the app with nowhere to stand when no project was open. The rail
 * is chrome: it is the same in every state, so "where am I" and "what else is
 * there" are answerable without opening anything.
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

  const items: RailItem[] = [
    { route: 'home', label: 'Home', icon: 'target' },
    { route: 'projects', label: 'Projects', icon: 'folder' },
    { route: 'streamers', label: 'Streamers', icon: 'users', count: streamers.length },
    { route: 'vods', label: 'VODs', icon: 'monitor', count: project?.sources.length },
    { route: 'clips', label: 'Clips', icon: 'scissors', count: project?.clips.length },
    {
      route: 'export',
      label: 'Export',
      icon: 'download',
      count: jobs.filter((j) => j.progress.stage !== 'complete').length
    }
  ]

  return (
    <nav className={`app-rail${collapsed ? ' is-collapsed' : ''}`} aria-label="Sections">
      <div className="app-rail-brand">
        <span className="app-rail-mark" aria-hidden="true" />
        {!collapsed && <span className="app-rail-word">RIPPER CLIPPER</span>}
      </div>

      <ul className="app-rail-items">
        {items.map((item) => (
          <li key={item.route}>
            <RailButton item={item} active={route === item.route} collapsed={collapsed} onGo={setRoute} />
          </li>
        ))}
      </ul>

      <span className="spacer" />

      <ul className="app-rail-items">
        <li>
          <RailButton
            item={{ route: 'settings', label: 'Settings', icon: 'settings' }}
            active={route === 'settings'}
            collapsed={collapsed}
            onGo={setRoute}
          />
        </li>
      </ul>

      <div className="app-rail-foot">
        <IconButton
          icon={collapsed ? 'chevron-right' : 'chevron-left'}
          size="compact"
          label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          onClick={toggleRail}
        />
      </div>
    </nav>
  )
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
      {/* Collapsed, the count becomes a dot: the number is unreadable at that
          size, but "there is something here" still is. */}
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
