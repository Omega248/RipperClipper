import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store.js'
import { isFailed, isSettled } from '@shared/jobs'
import type { MenuItem } from '../ui/index.js'
import { Icon, IconButton, Menu, Tooltip } from '../ui/index.js'
import type { ThemeMode } from '@shared/types'

/**
 * The window's top strip: identity, project commands, undo, global find,
 * theme, help — and the window controls, because in a frameless Electron
 * window this row *is* the title bar and has to keep the drag region.
 *
 * What this replaces, and why:
 *
 *  - **The Video / Editor / Properties / Export tab strip is gone.** It was a
 *    second navigation axis sitting directly above the rail, and the two could
 *    disagree — the rail reading VODs while the strip read Export, neither of
 *    them wrong, because they tracked different state. The rail's own comment
 *    already identifies this as the failure it was built to end; the strip
 *    outlived that decision. Video is Watch, Properties is an inspector beside
 *    the clip list, Export is a rail destination. Editor stays reachable from
 *    Watch, where the clip it edits is selected.
 *
 *  - **The save pill and the queue summary moved to the status bar.** They are
 *    standing facts, not controls, and they were the two widest things in a row
 *    that has to survive a 1280px window without wrapping.
 *
 *  - **Streamers and Settings lost their buttons.** Both are rail destinations.
 *    A button that duplicates a nav item is a third opinion about where you are.
 *
 * What is new: the live count, which is the one place in the shell with room to
 * say *how many* sources are live rather than merely that some are, and the
 * theme switch, which belongs somewhere reachable without opening Settings
 * because it is the one setting people change by time of day.
 *
 * The Project menu's items are passed in rather than built here: every one of
 * them closes over App.tsx's own save/open/recover handlers, and moving those
 * would mean either moving half of App.tsx or threading a dozen callbacks.
 * One prop is the smaller seam.
 */
export default function AppHeader({
  projectMenu,
  projectName,
  projectMeta,
  onCommandPalette,
  onGuide,
  windowMaximized,
  children
}: {
  projectMenu: MenuItem[]
  projectName: string
  projectMeta: string
  onCommandPalette: () => void
  onGuide: () => void
  windowMaximized: boolean
  /** Anything a page wants in the strip. Almost always nothing. */
  children?: ReactNode
}): JSX.Element {
  /*
   * Only the fields this header actually reads.
   *
   * `useStore()` with no selector returns the whole state object, so this
   * subscribed to every write in the app — including `currentTime`, which
   * lands several times a second while anything is playing. Nothing here is
   * memoised, so that re-rendered the rail, every POV tile, the transport,
   * the clip list and the timeline on every tick. Naming the fields, compared
   * shallowly, means a re-render only when one of them actually changes.
   */
  const store = useStore(
    useShallow((s) => ({
      future: s.future,
      past: s.past,
      patchSettings: s.patchSettings,
      project: s.project,
      redo: s.redo,
      undo: s.undo
    }))
  )
  const settings = useStore((s) => s.settings)
  const setRoute = useStore((s) => s.setRoute)

  const liveCount = (store.project?.sources ?? []).filter((s) => s.live?.state === 'live').length
  const theme = settings?.ui.theme ?? 'system'

  const setTheme = (mode: ThemeMode): void => {
    if (!settings) return
    // Repaints on this frame; the write to disk catches up behind it.
    void store.patchSettings({ ui: { ...settings.ui, theme: mode } })
  }

  return (
    <header
      className="topbar"
      onDoubleClick={(e) => {
        // Only the drag region itself, not a double-click that landed on a
        // button inside it — standard titlebar behaviour, not a shortcut that
        // happens to fire from anywhere in the strip.
        const el = e.target as HTMLElement
        if (e.target === e.currentTarget || el.classList.contains('spacer')) {
          void window.api.toggleMaximizeWindow()
        }
      }}
    >
      <Menu
        label="Project"
        icon="file"
        triggerClassName="topbar-project"
        trigger={
          <>
            <Icon name="file" size={15} className="topbar-project-icon" />
            <span className="topbar-project-lines">
              <span className="topbar-project-name ellipsis">{projectName}</span>
              <span className="topbar-project-meta">{projectMeta}</span>
            </span>
          </>
        }
        items={projectMenu}
      />

      <span className="topbar-divider" />

      <IconButton
        icon="undo"
        label="Undo (Ctrl+Z)"
        onClick={() => store.undo()}
        disabled={store.past.length === 0}
      />
      <IconButton
        icon="redo"
        label="Redo (Ctrl+Shift+Z)"
        onClick={() => store.redo()}
        disabled={store.future.length === 0}
      />

      {/* Shaped as a field because that is what makes it read as a search
          surface rather than an action — but it is a button, not an input. A
          focusable text field that swallows the first keystroke and then
          reopens itself as a dialog elsewhere is the worst of both. It is the
          app's global find, so it must work with nothing open: no `disabled`. */}
      <button
        type="button"
        className="app-omnibox"
        onClick={onCommandPalette}
        title="Search events, VODs, streamers and clips (Ctrl+K)"
      >
        <Icon name="search" size={14} />
        <span className="app-omnibox-label">Search events, VODs, streamers, clips…</span>
        <kbd className="app-omnibox-key">Ctrl K</kbd>
      </button>

      <span className="spacer" />

      {children}

      {liveCount > 0 && (
        <button
          type="button"
          className="app-live-count"
          onClick={() => setRoute('vods')}
          title="Go to the live sources"
        >
          <span className="ui-live-dot" aria-hidden="true" />
          {liveCount} live now
        </button>
      )}

      <ThemeSwitch value={theme} onChange={setTheme} />

      <IconButton icon="help" label="How Ripper Clipper works" onClick={onGuide} />

      <span className="topbar-divider" />

      <div className="window-controls">
        <IconButton
          icon="window-minimize"
          label="Minimize"
          onClick={() => void window.api.minimizeWindow()}
        />
        <IconButton
          icon={windowMaximized ? 'window-restore' : 'window-maximize'}
          label={windowMaximized ? 'Restore' : 'Maximize'}
          onClick={() => void window.api.toggleMaximizeWindow()}
        />
        <IconButton
          icon="close"
          label="Close"
          className="close"
          onClick={() => void window.api.closeWindow()}
        />
      </div>
    </header>
  )
}

/**
 * System / Light / Dark as three icons in one segment.
 *
 * A three-way is a segment, not a toggle: a two-state switch cannot express
 * "follow the OS", and dropping that option means the app is wrong twice a day
 * for anyone whose system theme changes on a schedule. It stays a radiogroup so
 * arrow keys move within it and Tab moves past it.
 */
function ThemeSwitch({
  value,
  onChange
}: {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}): JSX.Element {
  const options: Array<{ id: ThemeMode; label: string; icon: 'monitor' | 'sun' | 'moon' }> = [
    { id: 'system', label: 'Match the system theme', icon: 'monitor' },
    { id: 'light', label: 'Light theme', icon: 'sun' },
    { id: 'dark', label: 'Dark theme', icon: 'moon' }
  ]

  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {options.map((o) => (
        <Tooltip key={o.id} content={o.label} placement="bottom">
          <button
            type="button"
            role="radio"
            aria-checked={value === o.id}
            className={`theme-switch-opt${value === o.id ? ' on' : ''}`}
            onClick={() => onChange(o.id)}
          >
            <Icon name={o.icon} size={14} />
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * The bottom strip: what the app is doing, in words.
 *
 * Everything here is a standing fact — how many downloads are open, how deep
 * the queue is, which encoder is live, whether the project is saved. None of it
 * is a control and none of it animates. Deliberately no progress bars: a bar
 * per job in a 28px strip is unreadable, and the queue page owns per-job
 * progress.
 *
 * It exists so the header does not have to carry facts, and so "is my work
 * written to disk" is answerable without looking for a pill among nine buttons.
 */
export function AppStatusBar(): JSX.Element {
  const jobs = useStore((s) => s.jobs)
  const dirty = useStore((s) => s.dirty)
  const projectPath = useStore((s) => s.projectPath)
  const project = useStore((s) => s.project)
  const setRoute = useStore((s) => s.setRoute)

  const downloading = jobs.filter(
    (j) => j.progress.stage === 'downloading-video' || j.progress.stage === 'downloading-audio'
  ).length
  const inFlight = jobs.filter((j) => !isSettled(j.progress.stage)).length
  const failures = jobs.filter((j) => isFailed(j.progress.stage)).length

  /*
   * Nothing is said about a quiet queue, and nothing at all is said about the
   * encoder.
   *
   * "No downloads · Queue empty · h264_nvenc ready · software fallback armed"
   * was three facts that never change and one that is not a fact about the
   * work — it is a fact about the machine, phrased for whoever was debugging
   * the exporter. A status bar earns its row by saying what is happening now;
   * when nothing is, the honest thing is to be empty. Which encoder was used
   * still belongs somewhere, and that somewhere is Diagnostics.
   */
  return (
    <footer className="app-status">
      {downloading > 0 && (
        <span className="app-status-item">
          <Icon name="download" size={13} />
          {downloading} downloading
        </span>
      )}

      {(inFlight > 0 || failures > 0) && (
        <span className="app-status-item">
          <Icon name="queue" size={13} />
          {inFlight === 0 ? 'Exports finished' : `${inFlight} in the export queue`}
          {/* A failure is the one thing here allowed to be coloured, because it
              is the one thing that changes what you should do next. */}
          {failures > 0 && (
            <button type="button" className="app-status-fail" onClick={() => setRoute('export')}>
              {failures} failed
            </button>
          )}
        </span>
      )}

      <span className="spacer" />

      <span className="app-status-project ellipsis">
        {project ? `${projectPath ?? project.name}${dirty ? ' · unsaved changes' : ' · saved'}` : 'No project open'}
      </span>

    </footer>
  )
}
