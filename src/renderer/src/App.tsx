import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { formatTimecode } from '@shared/time'
import { projectNameFromSource, suggestedProjectName } from '@shared/projectNames'
import type { ClipSegment, ClipStatus, JobStage, VodSource } from '@shared/types'
import { resolveWatermark, streamerFor } from '@shared/watermark'
import type { ResolvedWatermark, WatermarkConfig } from '@shared/watermark'
import type {
  EnqueueRequest,
  EventOverlapReply,
  RecoveryInfo,
  TimelineExportSegment
} from '@shared/ipc'
import { planExport } from '@shared/povMapping'
import type { ExportPart } from '@shared/povMapping'
import { editsForPov } from '@shared/audioEdits'
import type { AudioEdit } from '@shared/audioEdits'
import { computeExportSegments } from '@shared/timeline'
import { crossCheckByAudio, hasAudioAnchor, strongestSyncedSibling } from './sync/audioCrossCheck.js'
import { stripHtml } from '@shared/htmlToText'
import { useActiveClips, useActiveSource, useStore } from './store.js'
import Timeline from './components/Timeline.js'
import ClipTimeline from './components/ClipTimeline.js'
import Transport from './components/Transport.js'
import ClipList from './components/ClipList.js'
import Properties from './components/Properties.js'
import MarkerPanel from './components/MarkerPanel.js'
import MediaLibrary from './components/MediaLibrary.js'
import PropertiesPage from './components/PropertiesPage.js'
import ExportPage from './components/ExportPage.js'
import AnglePicker from './components/AnglePicker.js'
import PovGrid from './components/PovGrid.js'
import type { GridLayout } from './components/PovGrid.js'
import QueuePanel from './components/QueuePanel.js'
import { message, title } from './components/QualityPanel.js'
import SettingsDialog from './components/SettingsDialog.js'
import QuickGuide from './components/QuickGuide.js'
import StreamersDialog from './components/StreamersDialog.js'
import FindPovsDialog from './components/FindPovsDialog.js'
import EditorExportWizard from './components/EditorExportWizard.js'
import VersionHistoryDialog from './components/VersionHistoryDialog.js'
import FindInPovs from './components/FindInPovs.js'
import WaveformSync from './components/WaveformSync.js'
import PovBar, { povLabel } from './components/PovBar.js'
import WatermarkEditor from './components/WatermarkEditor.js'
import WatermarkOverlay from './components/WatermarkOverlay.js'
import EventStreams from './components/EventStreams.js'
import EventDiscovery from './components/EventDiscovery.js'
import EventSearch from './components/EventSearch.js'
import AppRail from './components/AppRail.js'
import AppHeader, { AppStatusBar } from './components/AppHeader.js'
import HomePage from './components/HomePage.js'
import BacklogPage from './components/BacklogPage.js'
import ReviewRunStrip from './components/ReviewRunStrip.js'
import StreamersPage from './components/StreamersPage.js'
import VodsPage from './components/VodsPage.js'
import ClipsPage from './components/ClipsPage.js'
import SettingsPage from './components/SettingsPage.js'
import Toasts from './components/Toasts.js'
import CommandPalette from './components/CommandPalette.js'
import type { PaletteItem } from './components/CommandPalette.js'
import { playerBus } from './player/controller.js'
import { usePlayerViewport } from './player/usePlayerViewport.js'
import { useShortcuts } from './hooks/useShortcuts.js'
import { usePanelSize } from './usePanelSize.js'
import { ensureNameBadge } from './media/ensureNameBadge.js'
import { oneAnglePerStreamer, personKey } from '@shared/povPriority'
import { isInFlight } from '@shared/jobs'
import {
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Notice,
  PromptDialog,
  Resizer,
  Select,
  useTheme
} from './ui/index.js'
import type { MenuItem } from './ui/index.js'

type Tab = 'clips' | 'library' | 'edit' | 'markers'

/**
 * The Editor is a development-only feature — a production build must not
 * ship its UI at all, not merely hide it. `__EDITOR_ENABLED__` (see
 * electron.vite.config.ts) is replaced with a literal `true`/`false` at
 * build time, which lets Rollup prove the `import()` below is unreachable in
 * a production build and drop the whole module graph (Editor page,
 * Inspector, TimelineEditor, and everything only they use) from the built
 * output rather than just from what's rendered.
 */
const EditorPage = __EDITOR_ENABLED__ ? lazy(() => import('./components/EditorPage.js')) : null

/** What each component is called everywhere the editor can see it. */
const SETUP_NAME: Record<string, string> = {
  ffmpeg: 'the video engine',
  ytdlp: 'the VOD reader'
}

export default function App(): JSX.Element {
  /*
   * Only the fields the shell actually reads.
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
      activeSourceId: s.activeSourceId,
      addSource: s.addSource,
      clipNamePromptOpen: s.clipNamePromptOpen,
      closeClipNamePrompt: s.closeClipNamePrompt,
      createClip: s.createClip,
      env: s.env,
      patchSettings: s.patchSettings,
      project: s.project,
      projectPath: s.projectPath,
      recentProjects: s.recentProjects,
      requestCreateClip: s.requestCreateClip,
      selectClip: s.selectClip,
      selectedClipId: s.selectedClipId,
      sequenceIndex: s.sequenceIndex,
      setActiveSource: s.setActiveSource,
      setEnv: s.setEnv,
      setJobs: s.setJobs,
      setProject: s.setProject,
      setRecentProjects: s.setRecentProjects,
      setRoute: s.setRoute,
      setSequenceIndex: s.setSequenceIndex,
      setSettings: s.setSettings,
      setStreamers: s.setStreamers,
      settings: s.settings,
      streamers: s.streamers,
      toast: s.toast,
      toolProgress: s.toolProgress,
      updateStatus: s.updateStatus
    }))
  )
  const clips = useActiveClips()
  const source = useActiveSource()

  /**
   * The coach strip teaches once, not once per event. Keyed on a persisted
   * fact rather than on the open event having no clips — the latter is true
   * again every time a new event is started, forever.
   *
   * Recorded here rather than at the two `addClip` call sites in the store so
   * a third one cannot forget to.
   */
  const hasMadeAClip = store.settings?.ui.hasMadeAClip ?? true
  useEffect(() => {
    if (hasMadeAClip || clips.length === 0) return
    const settings = store.settings
    if (!settings) return
    void window.api
      .updateSettings({ ui: { ...settings.ui, hasMadeAClip: true } })
      .then(store.setSettings)
      .catch(() => undefined)
    // Fires once, on the transition. Re-running for every other settings edit
    // would be pointless work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMadeAClip, clips.length])
  const [tab, setTab] = useState<Tab>('clips')
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const route = useStore((s) => s.route)
  const setRoute = useStore((s) => s.setRoute)
  const [showAll, setShowAll] = useState(false)
  const [layout, setLayout] = useState<GridLayout>('auto')
  const [showAnglePicker, setShowAnglePicker] = useState(false)
  /*
   * An autosave found at startup.
   *
   * A dialog rather than a toast. Toasts dismiss themselves after six seconds
   * unless they are errors, and this one was telling people their unsaved work
   * still existed, that they had to go and find File → Recover themselves, and
   * that the copy would be overwritten by the next autosave. Step away while
   * the app starts and the only notice that the work survived a crash was gone
   * — and then overwritten. Recovering work is a decision, so it gets a
   * decision's UI and waits for an answer.
   */
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null)
  /** Angles actually on the wall, for the picker's button. */
  const shownAngles = (store.project?.sources ?? []).filter((s) => s.hiddenInWall !== true).length
  const [url, setUrl] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [showStreamers, setShowStreamers] = useState(false)
  const [showFind, setShowFind] = useState(false)
  const [showDiscovery, setShowDiscovery] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [timelineView, setTimelineView] = useState<'event' | 'clip'>('event')
  // 'pov' corrects the whole VOD; 'clip' corrects the selected clip only.
  const [showWaveform, setShowWaveform] = useState<'pov' | 'clip' | null>(null)
  const [loading, setLoading] = useState(false)
  const [combinePrompt, setCombinePrompt] = useState<string | null>(null)
  /** The suggested name, while the new-project dialog is open. Null = closed. */
  /** The clip whose other POVs are being looked for, if any. */
  const [findPovsFor, setFindPovsFor] = useState<{
    name: string
    startSeconds: number
    endSeconds: number
  } | null>(null)
  /** The clip being handed to an editing application, if any. */
  const [sendToEditor, setSendToEditor] = useState<string | null>(null)
  const [newProjectPrompt, setNewProjectPrompt] = useState<string | null>(null)
  const [sequenceExportPrompt, setSequenceExportPrompt] = useState<string | null>(null)
  const [confirmNewProject, setConfirmNewProject] = useState(false)
  const [showWatermark, setShowWatermark] = useState(false)
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  /** What quitting would cost, when it would cost anything. Null = just go. */
  const [confirmQuit, setConfirmQuit] = useState<{ dirty: boolean; running: number } | null>(null)
  // Carries the version/notes across 'available' -> 'downloading' ->
  // 'downloaded' so the popup keeps showing them even once the status
  // itself stops repeating them.
  const [pendingUpdate, setPendingUpdate] = useState<{ version: string; releaseNotes?: string } | null>(
    null
  )
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [windowMaximized, setWindowMaximized] = useState(false)
  /**
   * Who else was live during the selected clip, fetched the moment a clip
   * with a real-world time exists — not on demand when Streamers opens —
   * so the nav badge and the dialog both already have the answer instead
   * of making the editor wait on a click.
   */
  const [eventOverlap, setEventOverlap] = useState<EventOverlapReply | null>(null)
  const [eventOverlapLoading, setEventOverlapLoading] = useState(false)
  const urlRef = useRef<HTMLInputElement | null>(null)
  const autosaveTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // There's no explicit "close project" action — projects are just swapped
  // out for another. Watching the path itself catch every swap regardless of
  // which of the several open/new/recent code paths caused it.
  const lastClosedProjectPath = useRef<string | null>(null)
  const prevProjectPath = useRef<string | null>(null)
  useEffect(() => {
    if (prevProjectPath.current && prevProjectPath.current !== store.projectPath) {
      lastClosedProjectPath.current = prevProjectPath.current
    }
    prevProjectPath.current = store.projectPath
  }, [store.projectPath])

  const patchUiSettings = useCallback(
    (patch: Partial<NonNullable<typeof store.settings>['ui']>) => {
      if (!store.settings) return
      void store.patchSettings({ ui: { ...store.settings.ui, ...patch } })
    },
    [store.settings, store]
  )

  const sidePanel = usePanelSize({
    persisted: store.settings?.ui.sidePanelWidth,
    cssDefault: 340,
    min: 220,
    max: 640,
    viewportFraction: 0.5,
    axis: 'width',
    onCommit: (px) => patchUiSettings({ sidePanelWidth: Math.round(px) })
  })
  // The handle drags the boundary; the column is to its *left*, so moving
  // right (positive delta) should shrink it, not grow it.
  const onDragSidePanel = useCallback((deltaPx: number) => sidePanel.drag(-deltaPx), [sidePanel])

  const timelineStrip = usePanelSize({
    persisted: store.settings?.ui.timelineHeight,
    // The timeline is where the work happens, and it was sized like a
    // footnote: a ruler, a 14px clip bar and no room for the filmstrip. The
    // floor is what a usable strip actually costs — ruler, frames, a clips
    // lane whose edges can be grabbed, and the markers row.
    cssDefault: 340,
    min: 260,
    max: 720,
    viewportFraction: 0.6,
    axis: 'height',
    onCommit: (px) => patchUiSettings({ timelineHeight: Math.round(px) })
  })
  const onDragTimeline = useCallback(
    (deltaPx: number) => timelineStrip.drag(-deltaPx),
    [timelineStrip]
  )


  // exportEveryPov is defined further down this component, so the shortcut
  // reads it through a ref rather than capturing it before it exists.
  const exportEveryPovRef = useRef<(() => Promise<void>) | null>(null)
  useShortcuts(
    () => setShowFind(true),
    () => setShowCommandPalette(true),
    () => void exportEveryPovRef.current?.()
  )
  // One place decides what theme the whole application is in, and it repaints
  // everything at once because every colour comes from one variable block.
  useTheme(store.settings?.ui.theme)

  // There is no OS titlebar to report this, so the maximize/restore icon has
  // to ask directly and then listen for changes it did not cause itself
  // (double-clicking the drag region, Aero Snap, a window-manager shortcut).
  /**
   * Live state is pushed, never polled: a buffer strip on screen must not be
   * the reason a timer exists. Registered once for the app's lifetime.
   */
  useEffect(() => {
    const setLive = useStore.getState().setLive
    void window.api
      .liveStates()
      .then((snapshot) => {
        setLive(snapshot)
        /*
         * Adopt whatever the main process is already holding.
         *
         * `watchedLive` is a ref, so it starts empty on every mount — and a
         * renderer reload does not restart the main process. Buffers from
         * before the reload were therefore invisible to the reconciliation
         * below, which only unwatches ids the ref knows about: each kept its
         * poll timer and its held media, up to the whole live window per
         * angle, with nothing left that could stop it. The crash screen's own
         * Reload button is the likeliest way to reach it, which is the worst
         * of it — recover from a crash and the app leaks the wall it was
         * showing.
         *
         * Seeding the ref makes those orphans ordinary members of the set, so
         * the reconciliation drops any the reopened project does not want.
         * The bump is what makes that happen now rather than whenever the POV
         * list next changes.
         */
        const ids = Object.keys(snapshot.sources ?? {})
        if (ids.length === 0) return
        for (const id of ids) watchedLive.current.add(id)
        setAdoptedLive((n) => n + 1)
      })
      .catch(() => undefined)
    return window.api.onLive(setLive)
  }, [])

  useEffect(() => {
    void window.api.isWindowMaximized().then(setWindowMaximized)
    return window.api.onWindowMaximized(setWindowMaximized)
  }, [])

  /*
   * Hold media for every live POV in the open event, and for nothing else.
   *
   * Written as a reconciliation rather than as calls at the point a POV is
   * added, because there are several ways a source arrives (pasted link,
   * discovery, opening a project that already had one) and exactly one rule:
   * what is being held should match what is in the event. Closing a project,
   * removing a POV and swapping events then need no code of their own — the
   * set changes and the difference is applied.
   *
   * `liveWatch` is idempotent in the main process, and the ref means a slow
   * first call is not started twice by a re-render.
   */
  /*
   * Native playback: start the decoder, and keep it told which angles exist.
   *
   * Both halves are deliberately conditional on the setting. A frame server
   * that was never started binds no ports and spawns no ffmpeg, so an install
   * using the browser player pays nothing at all for this existing.
   */
  /*
   * Keep asking the platform how long each broadcast is now.
   *
   * A recording that is still being written has a length that is a floor, not
   * a limit, and both facts — the length and whether it is still going — are
   * only true for a moment. A project saved an hour ago holds neither, which is
   * why reopening a wall of live angles showed "Not recording at this moment"
   * on every tile but the focused one, and why the timeline stopped where each
   * broadcast was when it was added.
   *
   * Every source is asked once when the project opens — that is what heals a
   * saved project, whose angles were resolved before any of this existed — and
   * after that only the ones still on air are asked again. A project of
   * finished VODs settles into asking nothing at all.
   */
  const sourceKey = (store.project?.sources ?? []).map((s) => s.id).join('\u0000')
  useEffect(() => {
    let stopped = false
    const ask = async (first: boolean): Promise<void> => {
      const list = useStore.getState().project?.sources ?? []
      for (const source of list) {
        if (stopped) return
        // After the first sweep, only the ones that said they were still going.
        if (!first && source.stillRecording !== true) continue
        const status = await window.api.liveStatus(source).catch(() => null)
        if (status && !stopped) useStore.getState().setSourceLiveStatus(source.id, status)
      }
    }
    void ask(true)
    const timer = setInterval(() => void ask(false), 60_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [sourceKey])

  const watchedLive = useRef(new Set<string>())
  /** Bumped once buffers held from before a renderer reload have been adopted. */
  const [adoptedLive, setAdoptedLive] = useState(0)
  const liveSources = (store.project?.sources ?? []).filter((s) => s.isLive)
  const liveKey = liveSources.map((s) => s.id).join('\u0000')
  useEffect(() => {
    const wanted = new Set(liveSources.map((s) => s.id))

    for (const source of liveSources) {
      if (watchedLive.current.has(source.id)) continue
      watchedLive.current.add(source.id)
      void window.api.liveWatch(source).catch((err) => {
        watchedLive.current.delete(source.id)
        useStore.getState().toast({
          kind: 'error',
          title: title(err, `Could not follow ${source.creator}'s broadcast`),
          message: message(err)
        })
      })
    }

    for (const id of [...watchedLive.current]) {
      if (wanted.has(id)) continue
      watchedLive.current.delete(id)
      void window.api.liveUnwatch(id).catch(() => undefined)
    }
    // Deliberately keyed on the ids alone: a live source's own object changes
    // on every state push, and re-running this on each of those would be a
    // watch/unwatch cycle several times a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // adoptedLive: buffers inherited from before a renderer reload have to be
    // reconciled once the mount effect has made them known.
  }, [liveKey, adoptedLive])

  // The window doesn't actually close on its own — see main/index.ts's
  // `close` handler — so whatever triggered it (titlebar button, Alt+F4,
  // the taskbar) ends up here with a chance to check for unsaved work first.
  useEffect(() => {
    return window.api.onBeforeClose(() => {
      const state = useStore.getState()
      /*
       * Running exports count as work in progress too.
       *
       * This asked about the project only, so quitting with exports running
       * closed the window without a word — and quitting genuinely stops them
       * now (the main process aborts the queue on the way out, which is what
       * keeps ffmpeg from outliving the app). Something the person waited ten
       * minutes for should not end silently.
       */
      const running = state.jobs.filter((j) => isInFlight(j.progress.stage)).length
      if (state.dirty || running > 0) setConfirmQuit({ dirty: state.dirty, running })
      else void window.api.confirmClose()
    })
  }, [])

  /**
   * The switcher's second line. Answers "how much is in this project" from
   * data the project already carries — no new state, no new IPC.
   */
  const projectMeta = useMemo(() => {
    const p = store.project
    if (!p) return 'Nothing open'
    const start = p.event?.startSeconds
    const date =
      typeof start === 'number'
        ? new Date(start * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        : null
    const povs = `${p.sources.length} POV${p.sources.length === 1 ? '' : 's'}`
    const clipCount = `${p.clips.length} clip${p.clips.length === 1 ? '' : 's'}`
    return [date, povs, clipCount].filter(Boolean).join(' · ')
  }, [store.project])

  /**
   * The palette is the app's global find, so it is grouped by what a result
   * *is*, and actions come first: the fastest thing to reach should be the
   * thing you meant to do, not the first clip that happens to match.
   *
   * A heading is attached to the first item of each run. Filtering drops
   * items, so headings are re-attached after filtering in `CommandPalette`
   * rather than baked in here — otherwise a group whose first item is filtered
   * out loses its title.
   */
  const commandPaletteItems: PaletteItem[] = [
    {
      group: 'Actions',
      id: 'new-clip',
      label: 'New clip…',
      icon: 'plus' as const,
      onSelect: () => store.requestCreateClip()
    },
    {
      group: 'Actions',
      id: 'find-in-povs',
      label: 'Find in all POVs',
      icon: 'search' as const,
      onSelect: () => setShowFind(true)
    },
    {
      group: 'Actions',
      id: 'search-event',
      label: 'Search in this event',
      icon: 'search' as const,
      disabled: !store.project,
      onSelect: () => setShowSearch(true)
    },
    {
      group: 'Actions',
      id: 'version-history',
      label: 'Version history',
      icon: 'clock' as const,
      onSelect: () => setShowVersionHistory(true)
    },
    {
      group: 'Actions',
      id: 'quick-guide',
      label: 'Quick guide',
      icon: 'help' as const,
      onSelect: () => setShowGuide(true)
    },

    // Navigation mirrors the rail, so every destination is reachable from the
    // keyboard without learning a second vocabulary for the same places.
    ...([
      ['home', 'Backlog', 'target'],
      ['projects', 'Events', 'folder'],
      ['streamers', 'Streamers', 'users'],
      ['vods', 'VODs', 'monitor'],
      ['workspace', 'Watch', 'play'],
      ['clips', 'Clips', 'scissors'],
      ['export', 'Export', 'download'],
      ['settings', 'Settings', 'settings']
    ] as const).map(([route, label, icon]) => ({
      group: 'Go to',
      id: `route-${route}`,
      label,
      icon,
      onSelect: () => store.setRoute(route)
    })),

    ...clips.map((clip) => ({
      group: 'Clips',
      id: `clip-${clip.id}`,
      label: clip.name,
      icon: 'scissors' as const,
      onSelect: () => {
        store.setRoute('workspace')
        setPage('video')
        setTab('clips')
        store.selectClip(clip.id)
        playerBus.seek(clip.startSeconds)
      }
    })),

    ...store.streamers.map((s) => ({
      group: 'Streamers',
      id: `streamer-${s.id}`,
      label: s.displayName || s.handle,
      icon: 'users' as const,
      onSelect: () => store.setRoute('streamers')
    })),

    ...(store.project?.sources ?? []).map((source) => ({
      group: 'VODs',
      id: `vod-${source.id}`,
      label: source.title || source.url,
      icon: 'monitor' as const,
      onSelect: () => {
        store.setRoute('workspace')
        setPage('video')
        store.setActiveSource(source.id)
      }
    }))
  ]

  const selectedClip =
    store.project?.clips.find((c) => c.id === store.selectedClipId) ?? null

  // Falls back to the first clip, same as the Video page's own "Who else was
  // live" panel — a project with one clip and no explicit selection still
  // has an obvious clip to check other streamers against.
  const overlapClip = selectedClip ?? store.project?.clips[0] ?? null
  const overlapEventStart = overlapClip?.eventStartTime ?? null
  const overlapEventEnd = overlapClip?.eventEndTime ?? null

  const refreshEventOverlap = useCallback((): void => {
    const project = useStore.getState().project
    if (overlapEventStart === null || overlapEventEnd === null || !project) {
      setEventOverlap(null)
      return
    }
    setEventOverlapLoading(true)
    void window.api
      .streamersCoveringEvent({
        eventStartSeconds: overlapEventStart,
        eventEndSeconds: overlapEventEnd,
        loadedUrls: project.sources.map((s) => s.url)
      })
      .then(setEventOverlap)
      // Quiet: this is a proactive convenience fetch, not something the
      // editor asked for directly — Streamers' own manual refresh still
      // reports a failure there if they go looking.
      .catch(() => setEventOverlap(null))
      .finally(() => setEventOverlapLoading(false))
  }, [overlapEventStart, overlapEventEnd])

  useEffect(() => {
    refreshEventOverlap()
    // sources.length is enough to notice a POV being added/removed; the
    // effect does not need to re-run for every other project edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlapClip?.id, overlapEventStart, overlapEventEnd, store.project?.sources.length])

  /** Overlapping streamers not already loaded as a POV — the badge counts these. */
  /*
   * People, not broadcasts.
   *
   * Somebody on Twitch, Kick and YouTube covers the moment three times, and a
   * badge reading "(11)" for what turns out to be five people is a badge that
   * lies. The panel behind it offers one angle each, so the count has to be
   * the same thing it will show.
   */
  const overlapAvailableCount = useMemo(() => {
    const available = (eventOverlap?.streams ?? []).filter((s) => s.availability === 'available')
    const personOf = new Map(
      store.streamers.filter((s) => s.personId).map((s) => [s.id, s.personId as string])
    )
    return oneAnglePerStreamer(available, {
      key: (s) => personKey(s, (id) => personOf.get(id)),
      platform: (s) => s.platform,
      better: (a, b) => b.coverage.fraction - a.coverage.fraction
    }).length
  }, [eventOverlap, store.streamers])

  /** How many files "Download every POV" would actually produce. */
  const povExportCount = useMemo(() => {
    const project = store.project
    if (!project) return 0
    return project.clips.reduce(
      (total, clip) =>
        total +
        (clip.povMappings ?? []).filter(
          (m) => m.status === 'available' || m.status === 'partial' || m.status === 'sync_low_confidence'
        ).length,
      0
    )
  }, [store.project])

  // A new clip is a multi-POV object, so its own timeline is what the editor
  // wants to see the moment it exists.
  useEffect(() => {
    if (store.selectedClipId) setTimelineView('clip')
  }, [store.selectedClipId])

  // ------------------------------------------------------------- startup ---
  useEffect(() => {
    void (async () => {
      try {
        /*
         * Everything the first screen needs, in one round of calls.
         *
         * The app opens on the Backlog, and the Backlog wants the streamer
         * library and who is on air — both of which were being fetched by the
         * page itself on mount, so the Live now band appeared a beat after
         * arriving and the roster's badges rearranged themselves a second
         * after you looked at them. All of this is already on disk; asking
         * for it here costs one startup round-trip and makes every page that
         * uses it draw complete on its first paint.
         *
         * `.catch(() => …)` per call rather than one try around the lot: a
         * missing streamer library must not stop settings from loading.
         */
        /*
         * The tool versions are fetched alongside, not within.
         *
         * `env()` waits for the startup detection — three processes, and
         * yt-dlp alone takes well over a second to say its own version — so
         * having it in this batch held back six local file reads that were
         * already finished. The shell would be on screen with an empty
         * roster, an empty recents list and no jobs until the slowest
         * external program answered.
         *
         * `store.env` is null until it lands, and everything that reads it
         * already guards on that: an unknown environment shows nothing rather
         * than claiming the tools are missing.
         */
        void window.api
          .env()
          .then(store.setEnv)
          .catch(() => undefined)

        const [settings, jobs, streamers, recentProjects, liveNow, groups] = await Promise.all([
          window.api.getSettings(),
          window.api.listJobs(),
          // The streamer library is loaded up front because watermark defaults
          // resolve through it — a POV has to know whose logo it inherits.
          window.api.listStreamers().catch(() => []),
          window.api.recentProjects().catch(() => []),
          // The saved snapshot, not a live check: it is a file read, and the
          // pages that show it re-check for real once they are open.
          window.api.streamersLiveCached().catch(() => ({})),
          window.api.listStreamerGroups().catch(() => [])
        ])
        store.setSettings(settings)
        store.setJobs(jobs)
        store.setStreamers(streamers)
        store.setRecentProjects(recentProjects)
        // Not on the `store` selection above — this is startup, not render.
        useStore.getState().setLiveNow(liveNow)
        useStore.getState().setStreamerGroups(groups)

        // Audit 07: nothing is opened here. The launch sequence used to call
        // newProject('Untitled project') before anything else, so the app was
        // never honestly in the "nothing open" state — and that empty project
        // flowed into the switcher pill, the rail counts and the Home copy,
        // while startNewProject had to guard against discarding it. A project
        // is created by the first thing that needs one; see ensureProject.

        // A .cookieclip passed on the command line (double-clicked in Explorer).
        const startupPath = await window.api.startupProjectPath()
        if (startupPath) {
          const opened = await window.api.openProjectPath(startupPath)
          store.setProject(opened.project, opened.path)
        }

        const found = await window.api.checkRecovery()
        if (found.available && found.path) setRecovery(found)
      } catch (err) {
        store.toast({ kind: 'error', title: title(err, 'Startup problem'), message: message(err) })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update checks happen in the background (on launch, or from Settings), so
  // this listens for the whole session rather than only while Settings is
  // open — otherwise a launch-time check that finds something would have
  // nowhere to tell the user about it.
  useEffect(() => {
    return window.api.onUpdateStatus((status) => {
      const state = useStore.getState()
      state.setUpdateStatus(status)
      // A fresh check (launch, or a manual one from Settings) always gets a
      // chance to show the popup again, even if an earlier one this session
      // was dismissed with "Later" — that's what makes it reappear every
      // launch until the update is actually installed.
      if (status.state === 'checking') setUpdateDismissed(false)
      if (status.state === 'available' || status.state === 'downloaded') {
        setPendingUpdate({ version: status.version, releaseNotes: status.releaseNotes })
      }
      if (status.state === 'error') {
        state.toast({ kind: 'error', title: 'Update check failed', message: status.message })
      }
    })
  }, [])

  /**
   * Corroborate a POV's timing by audio the first time it's actually
   * opened in this session — the same cross-correlation the manual
   * "Align POVs" dialog already runs on request, just triggered
   * automatically instead of by hand. Covers a freshly loaded POV (which
   * becomes active immediately) and switching to an older one that was
   * never checked; each POV is only ever attempted once per session,
   * whether or not the match turns out confident.
   */
  const audioCrossCheckAttempted = useRef<Set<string>>(new Set())
  useEffect(() => {
    const state = useStore.getState()
    const activeId = state.activeSourceId
    const project = state.project
    if (!activeId || !project) return
    if (audioCrossCheckAttempted.current.has(activeId)) return
    const active = project.sources.find((s) => s.id === activeId)
    if (!active || hasAudioAnchor(project.syncAnchors ?? [], activeId)) return
    const sibling = strongestSyncedSibling(project.sources, activeId)
    if (!sibling) return

    audioCrossCheckAttempted.current.add(activeId)
    void crossCheckByAudio(sibling, active).then((outcome) => {
      if (!outcome?.anchors) return
      const latest = useStore.getState()
      latest.addSyncAnchors(outcome.anchors)
      const sources = latest.project?.sources ?? project.sources
      latest.toast({
        kind: 'info',
        title: 'Timing cross-checked by audio',
        message: `${povLabel(active, sources.indexOf(active))}'s timing was confirmed against ${povLabel(sibling, sources.indexOf(sibling))} by matching sound.`
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.activeSourceId, store.project?.sources.length])

  // Job updates -> clip status, and completion notices.
  const batchTally = useRef({ total: 0, failed: 0 })
  useEffect(() => {
    const off = window.api.onJobs((jobs) => {
      const previous = useStore.getState().jobs
      const activeBefore = previous.some((j) => isInFlight(j.progress.stage))
      const activeAfter = jobs.some((j) => isInFlight(j.progress.stage))
      useStore.setState({ jobs })
      const state = useStore.getState()
      if (!state.project) return

      const statusByClip = new Map<string, { status: ClipStatus; path?: string; message?: string }>()
      for (const job of jobs) {
        statusByClip.set(job.clipId, {
          status: clipStatusFor(job.progress.stage),
          path: job.progress.stage === 'complete' ? (job.outputPath ?? undefined) : undefined,
          message:
            job.progress.stage === 'complete' || job.progress.stage === 'failed'
              ? job.progress.message
              : undefined
        })
      }

      const nextClips = state.project.clips.map((clip) => {
        const update = statusByClip.get(clip.id)
        if (!update) return clip
        if (
          clip.status === update.status &&
          clip.exportedPath === (update.path ?? clip.exportedPath)
        ) {
          return clip
        }
        return {
          ...clip,
          status: update.status,
          exportedPath: update.path ?? clip.exportedPath,
          lastMessage: update.message ?? clip.lastMessage
        }
      })
      useStore.setState({ project: { ...state.project, clips: nextClips } })

      // A new batch starting from idle begins a fresh tally; one already in
      // flight keeps accumulating across however many onJobs calls it takes.
      if (!activeBefore && activeAfter) batchTally.current = { total: 0, failed: 0 }

      for (const job of jobs) {
        const before = previous.find((p) => p.id === job.id)
        if (before?.progress.stage === job.progress.stage) continue
        if (job.progress.stage === 'complete') {
          batchTally.current.total += 1
          state.toast({
            kind: job.verification?.ok === false ? 'warning' : 'success',
            title: job.verification?.ok === false ? 'Exported with warnings' : 'Export complete',
            message:
              job.verification?.ok === false
                ? `${job.clipName}: ${job.verification.problems.join('; ')}`
                : `${job.clipName} → ${job.outputPath ?? ''}`
          })
        } else if (job.progress.stage === 'failed' && job.error) {
          batchTally.current.total += 1
          batchTally.current.failed += 1
          state.toast({ kind: 'error', title: job.error.title, message: job.error.message })
        }
      }

      if (activeBefore && !activeAfter) {
        const { total, failed } = batchTally.current
        const succeeded = total - failed
        const summary =
          failed === 0
            ? `All ${total} clip${total === 1 ? '' : 's'} exported.`
            : succeeded === 0
              ? `All ${total} clip${total === 1 ? '' : 's'} failed.`
              : `${succeeded} of ${total} clips exported, ${failed} failed.`

        // Only a real batch earns a toast of its own — a lone export already
        // has its own clear toast above, and a second one would just be noise.
        if (total > 1) {
          state.toast({
            kind: failed === 0 ? 'success' : succeeded === 0 ? 'error' : 'warning',
            title: 'Export batch finished',
            message: summary
          })
        }

        // A native OS notification too, but only when nobody's actually
        // watching the in-app toast — the whole point is being told once the
        // window's minimized or in the background for a long batch.
        if (total > 0 && !document.hasFocus() && Notification.permission !== 'denied') {
          void Notification.requestPermission().then((permission) => {
            if (permission === 'granted') {
              new Notification('Ripper Clipper', { body: summary, silent: failed === 0 })
            }
          })
        }

        // Synthesised, not a bundled file — one short tone, no asset to ship.
        if (total > 0 && state.settings?.ui.exportCompletionSound) {
          try {
            const ctx = new AudioContext()
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.frequency.value = failed === 0 ? 880 : 440
            gain.gain.setValueAtTime(0.15, ctx.currentTime)
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
            osc.connect(gain)
            gain.connect(ctx.destination)
            osc.start()
            osc.stop(ctx.currentTime + 0.4)
            osc.onended = () => void ctx.close()
          } catch {
            // Audio isn't available in every environment; the toast/notification still fired.
          }
        }

        batchTally.current = { total: 0, failed: 0 }
      }
    })
    return off
  }, [])

  // Tool installs report here, for the banner and the Settings panel.
  useEffect(() => {
    return window.api.onToolProgress((progress) => {
      useStore.getState().setToolProgress(progress)
    })
  }, [])

  // A second launch with a project file hands it to this window.
  useEffect(() => {
    return window.api.onOpenProject((path) => {
      void window.api
        .openProjectPath(path)
        .then((result) => useStore.getState().setProject(result.project, result.path))
        .catch((err) =>
          useStore.getState().toast({ kind: 'error', title: title(err, 'Open failed'), message: message(err) })
        )
    })
  }, [])

  // Autosave every 20s while there are unsaved changes.
  useEffect(() => {
    if (autosaveTimer.current) clearInterval(autosaveTimer.current)
    autosaveTimer.current = setInterval(() => {
      const state = useStore.getState()
      if (state.project && state.dirty) void window.api.autosave(state.project)
    }, 20_000)
    return () => {
      if (autosaveTimer.current) clearInterval(autosaveTimer.current)
    }
  }, [])


  // --------------------------------------------------------------- actions --
  /** One path for every way a VOD enters the project: paste, or streamer pick. */
  /**
   * A project, created only if this is the first thing that needs one.
   *
   * Pairs with audit 07: the app opens on the Backlog with nothing open, and
   * pasting a link is one of the two things that genuinely requires a project
   * to exist (entering a review run is the other). Creating it here rather
   * than at launch is what makes "nothing open" a real state instead of one
   * the app pretends it can never be in.
   */
  const ensureProject = async (namedAfter?: {
    creator?: string | null
    title?: string | null
    createdAt?: string | null
  }): Promise<void> => {
    const state = useStore.getState()
    if (state.project) return
    // Named after the VOD going into it rather than "Untitled project": this
    // path is how most projects actually get created (paste a link), so it is
    // the one that produced a recent-projects list of identical names.
    const project = await window.api.newProject(
      namedAfter ? projectNameFromSource(namedAfter) : suggestedProjectName()
    )
    if (state.settings) {
      project.exportSettings =
        state.settings.exportPresets.find((p) => p.isDefault)?.settings ?? state.settings.export
      project.outputDirectory = state.settings.outputDirectory
    }
    store.setProject(project, null)
  }

  const loadVod = async (target: string): Promise<void> => {
    if (target.trim() === '') return
    setLoading(true)
    try {
      // Naming the event this POV is being loaded into is what lets the
      // streamer library record who has worked on what (§13).
      const current = useStore.getState().project
      const resolved = await window.api.resolveSource(
        target.trim(),
        current
          ? {
              projectId: current.id,
              projectName: current.name,
              ...(current.event?.name ? { eventName: current.event.name } : {})
            }
          : undefined
      )
      const existing = useStore.getState().project?.sources.find((s) => s.id === resolved.id)
      if (existing) {
        store.setActiveSource(existing.id)
        store.toast({
          kind: 'info',
          title: 'Already in your library',
          message: `${existing.title} is already loaded — switched to it instead of adding a duplicate.`
        })
        return
      }
      // addSource is a no-op without a project, so the source would otherwise
      // resolve and then be dropped on the floor.
      await ensureProject(resolved)
      store.addSource(resolved)
      /*
       * A POV you just loaded is the one you want to watch.
       *
       * Without this it arrives as a follower: a small muted tile whose player
       * caps its quality to the tile's own size. So the angle you just added
       * spent its first seconds picking a rendition for a postage stamp, and
       * clicking it to focus meant tearing that down and climbing from wherever
       * the abandoned one had got to. Focusing it up front means the full-size
       * player is the one that establishes the quality, once.
       */
      store.setActiveSource(resolved.id)
      /*
       * The generated "whose angle is this" badge, baked into the exported
       * file so an editor never has to place one by hand.
       *
       * On unless it has been turned off. It does cost an encode — a redrawn
       * frame cannot be copied — which is why that encode composites on the
       * GPU where the machine allows it rather than dragging every frame
       * through system memory. Settings → Exports has the switch for anyone
       * who would rather have the copy.
       */
      if (store.settings?.ui.autoNameBadge !== false) void ensureNameBadge(resolved)
      store.toast({
        kind: 'success',
        title: resolved.isLive ? 'Live POV added' : 'VOD loaded',
        message: resolved.isLive
          ? `${resolved.title} — holding the last few minutes so you can clip what just happened.`
          : `${resolved.title} — ${formatTimecode(resolved.durationSeconds, { millis: false })}`
      })
    } catch (err) {
      store.toast({ kind: 'error', title: title(err, 'Could not load VOD'), message: message(err) })
    } finally {
      setLoading(false)
    }
  }

  const loadUrl = (): Promise<void> => loadVod(url)

  /**
   * The watermark that applies to the POV supplying the picture.
   *
   * Resolved here, once, and handed to the exporter — the VOD's own override
   * first, then the streamer's default. Doing it at the call site is what makes
   * "Player A's logo never lands on Player B's video" a property of the code
   * rather than a thing to remember: the config travels with the POV that was
   * chosen for the picture.
   */
  const watermarkFor = useCallback(
    async (
      videoSource: VodSource,
      itemOverride?: WatermarkConfig | 'none'
    ): Promise<ResolvedWatermark | undefined> => {
      if (itemOverride === 'none') return undefined
      const state = useStore.getState()
      const streamer = streamerFor(state.streamers, videoSource)
      const resolved = resolveWatermark(itemOverride ?? videoSource.watermark, streamer?.watermark)
      if (!resolved) return undefined
      const images = await window.api.listWatermarkImages().catch(() => [])
      const image = images.find((i) => i.id === resolved.config.imageId)
      if (!image) return undefined
      return {
        config: resolved.config,
        imagePath: image.path,
        imageWidth: image.width,
        imageHeight: image.height
      }
    },
    []
  )

  const exportClips = useCallback(
    async (targets: ClipSegment[]): Promise<void> => {
      const state = useStore.getState()
      if (!state.project || !source) return
      if (targets.length === 0) {
        state.toast({ kind: 'info', title: 'Nothing to export', message: 'Create a clip first.' })
        return
      }
      // Each clip is cut from the POV it is set to use, so one request per
      // video POV. The ranges are the mapped ones, not the authoring POV's.
      const byPov = new Map<string, { source: VodSource; clips: EnqueueRequest['clips'] }>()
      const warnings: string[] = []
      const padding = state.project.exportSettings.uncertainPaddingSeconds
      for (const clip of targets) {
        const plan = planExport(clip, state.project.sources, { paddingSeconds: padding })
        if (!plan) continue
        warnings.push(...plan.warnings)
        const group = byPov.get(plan.video.source.id) ?? { source: plan.video.source, clips: [] }
        group.clips.push({
          id: clip.id,
          name: clip.name,
          startSeconds: plan.video.startSeconds,
          endSeconds: plan.video.endSeconds,
          audio: plan.audio
            ? {
                source: plan.audio.source,
                startSeconds: plan.audio.startSeconds,
                endSeconds: plan.audio.endSeconds
              }
            : undefined,
          audioEdits: editsToExport(clip, plan.audio ?? plan.video)
        })
        byPov.set(plan.video.source.id, group)
      }

      if (byPov.size === 0) {
        state.toast({
          kind: 'error',
          title: 'Nothing could be exported',
          message: 'None of the selected clips map onto a POV that covers them.'
        })
        return
      }

      try {
        for (const group of byPov.values()) {
          await window.api.enqueueExports({
            source: group.source,
            projectName: state.project.name,
            clips: group.clips,
            settings: state.project.exportSettings,
            watermark: await watermarkFor(group.source),
            outputDirectory: state.project.outputDirectory ?? state.settings!.outputDirectory
          })
        }
        if (warnings.length > 0) {
          state.toast({ kind: 'warning', title: 'Exporting with changes', message: warnings.join(' ') })
        }
      } catch (err) {
        state.toast({ kind: 'error', title: title(err, 'Export failed'), message: message(err) })
      }
    },
    [source, watermarkFor]
  )

  /**
   * Every clip, from every POV that can actually show it.
   *
   * Filenames carry the streamer and date, so one event's worth of angles lands
   * in the folder as distinct files rather than overwriting each other.
   */
  const exportEveryPov = useCallback(async (): Promise<void> => {
    const state = useStore.getState()
    if (!state.project || state.project.clips.length === 0) {
      state.toast({ kind: 'info', title: 'Nothing to export', message: 'Create a clip first.' })
      return
    }
    const padding = state.project.exportSettings.uncertainPaddingSeconds
    const byPov = new Map<string, { source: VodSource; clips: EnqueueRequest['clips'] }>()
    let skipped = 0

    for (const clip of state.project.clips) {
      for (const source of state.project.sources) {
        // Ask the planner for this specific POV so padding, clamping and the
        // per-clip corrections all apply exactly as they do for one export.
        const plan = planExport({ ...clip, videoSourceId: source.id, audioSourceId: undefined }, state.project.sources, {
          paddingSeconds: padding
        })
        if (!plan || plan.video.source.id !== source.id) {
          skipped += 1
          continue
        }
        const group = byPov.get(source.id) ?? { source, clips: [] }
        group.clips.push({
          id: `${clip.id}-${source.id}`,
          name: clip.name,
          startSeconds: plan.video.startSeconds,
          endSeconds: plan.video.endSeconds
        })
        byPov.set(source.id, group)
      }
    }

    const total = [...byPov.values()].reduce((n, g) => n + g.clips.length, 0)
    if (total === 0) {
      state.toast({
        kind: 'error',
        title: 'Nothing could be exported',
        message: 'No POV covers any of these clips.'
      })
      return
    }

    try {
      for (const group of byPov.values()) {
        await window.api.enqueueExports({
          source: group.source,
          projectName: state.project.name,
          clips: group.clips,
          settings: state.project.exportSettings,
          // Each POV brings its own watermark; nothing is shared between them.
          watermark: await watermarkFor(group.source),
          outputDirectory: state.project.outputDirectory ?? state.settings!.outputDirectory
        })
      }
      state.toast({
        kind: 'success',
        title: `Queued ${total} export${total === 1 ? '' : 's'}`,
        message: `${state.project.clips.length} clip${state.project.clips.length === 1 ? '' : 's'} across ${byPov.size} POV${byPov.size === 1 ? '' : 's'}${
          skipped > 0 ? `. ${skipped} POV/clip pair${skipped === 1 ? '' : 's'} skipped — not covered.` : '.'
        }`
      })
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Export failed'), message: message(err) })
    }
  }, [watermarkFor])

  // Hand it to the E shortcut, which is bound above this point.
  exportEveryPovRef.current = exportEveryPov

  const combineClips = async (name: string): Promise<void> => {
    const state = useStore.getState()
    if (!state.project || !source || clips.length === 0 || name === '') return
    try {
      await window.api.enqueueCombined({
        source,
        watermark: await watermarkFor(source),
        projectName: state.project.name,
        clips: clips.map((c) => ({
          id: c.id,
          name: c.name,
          startSeconds: c.startSeconds,
          endSeconds: c.endSeconds
        })),
        settings: state.project.exportSettings,
        outputDirectory: state.project.outputDirectory ?? state.settings!.outputDirectory,
        outputName: name
      })
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Combine failed'), message: message(err) })
    }
  }

  /**
   * Renders the Editor's multi-track timeline: every segment (see
   * shared/timeline.ts's `computeExportSegments`) becomes one real cut, each
   * from whichever POV was actually on top there, then all of them are
   * joined into one file — the same combine step a plain multi-clip
   * combine uses, just fed segments that can each come from a different POV.
   */
  const exportTimelineSequence = async (outputName: string): Promise<void> => {
    const state = useStore.getState()
    const project = state.project
    if (!project?.timeline || outputName === '') return
    const segments = computeExportSegments(project.timeline)
    if (segments.length === 0) {
      state.toast({
        kind: 'info',
        title: 'Nothing to export',
        message: 'Drag a clip onto the Sequence timeline first.'
      })
      return
    }
    try {
      const withWatermark: TimelineExportSegment[] = []
      for (const seg of segments) {
        const videoSource = project.sources.find((s) => s.id === seg.videoSourceId)
        if (!videoSource) continue
        const audioSource = seg.audioSourceId
          ? (project.sources.find((s) => s.id === seg.audioSourceId) ?? null)
          : null
        // A pip inset whose POV no longer exists in the project just drops
        // silently — the background segment still exports, it simply loses
        // the inset rather than failing the whole export.
        const pipSource = seg.pip ? project.sources.find((s) => s.id === seg.pip!.sourceId) : undefined
        withWatermark.push({
          durationSeconds: seg.durationSeconds,
          videoSource,
          videoStartSeconds: seg.videoStartSeconds,
          videoEndSeconds: seg.videoEndSeconds,
          audioSource,
          audioStartSeconds: seg.audioStartSeconds,
          audioEndSeconds: seg.audioEndSeconds,
          audioEdits: seg.audioEdits,
          watermark: await watermarkFor(videoSource, seg.watermarkOverride),
          transform: seg.transform,
          opacity: seg.opacity,
          audioGain: seg.audioGain,
          pip:
            seg.pip && pipSource
              ? {
                  source: pipSource,
                  startSeconds: seg.pip.startSeconds,
                  endSeconds: seg.pip.endSeconds,
                  transform: seg.pip.transform
                }
              : undefined
        })
      }
      if (withWatermark.length === 0) {
        state.toast({
          kind: 'error',
          title: 'Nothing could be exported',
          message: 'None of the sequence resolved to a POV that still exists in this project.'
        })
        return
      }
      await window.api.exportTimeline({
        segments: withWatermark,
        projectName: project.name,
        settings: project.exportSettings,
        outputDirectory: project.outputDirectory ?? state.settings!.outputDirectory,
        outputName
      })
      state.toast({
        kind: 'success',
        title: 'Sequence queued',
        message: `${withWatermark.length} segment${withWatermark.length === 1 ? '' : 's'} across the sequence.`
      })
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Export failed'), message: message(err) })
    }
  }

  /**
   * Write the project out as one portable file: the clips, sync, edits and
   * watermarks, with the VODs referenced by URL rather than copied.
   */
  const exportPackage = async (): Promise<void> => {
    const state = useStore.getState()
    if (!state.project) return
    try {
      const result = await window.api.packageExport({
        project: state.project,
        options: { includeExportPaths: true }
      })
      if (!result) return // cancelled
      state.toast({
        kind: 'success',
        title: 'Package exported',
        message: `${result.clips} clip${result.clips === 1 ? '' : 's'} and ${result.povs} POV${result.povs === 1 ? '' : 's'}. The VODs are referenced, not copied.`
      })
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Could not export package'), message: message(err) })
    }
  }

  /**
   * Open a package somebody sent.
   *
   * The other half of `exportPackage`, and it was missing: the IPC handler,
   * the preload binding and `readPackage` all existed and were tested, but
   * nothing in the interface called them. The entry point had been on the
   * Event page, and when that page was removed only the export was moved to
   * this menu — so the app could write a `.ripperpack` it could not open.
   *
   * It arrives as a project with no path of its own, which is the honest
   * state: it is unsaved work until the person chooses where it lives.
   */
  const importPackage = async (): Promise<void> => {
    const state = useStore.getState()
    try {
      const result = await window.api.packageImport()
      if (!result) return // cancelled
      store.setProject(result.project, null)
      state.toast({
        kind: 'success',
        title: 'Package opened',
        message: `${result.project.clips.length} clip${
          result.project.clips.length === 1 ? '' : 's'
        } and ${result.project.sources.length} POV${
          result.project.sources.length === 1 ? '' : 's'
        }. The VODs are referenced by URL — save the project to keep it.`
      })
    } catch (err) {
      state.toast({
        kind: 'error',
        title: title(err, 'Could not open that package'),
        message: message(err)
      })
    }
  }

  const saveProject = async (as: boolean): Promise<void> => {
    const state = useStore.getState()
    if (!state.project) return
    try {
      const result = as
        ? await window.api.saveProjectAs(state.project)
        : await window.api.saveProject(state.project, state.projectPath ?? undefined)
      if (!result) return
      useStore.setState({ project: result.project, projectPath: result.path, dirty: false })
      state.toast({ kind: 'success', title: 'Project saved', message: result.path })
      void window.api.recentProjects().then(store.setRecentProjects)
    } catch (err) {
      if (message(err).includes('cancelled')) return
      state.toast({ kind: 'error', title: title(err, 'Save failed'), message: message(err) })
    }
  }

  /** Guarded by the caller: `startNewProject` asks first when work would be lost. */
  const newProject = async (name: string): Promise<void> => {
    const state = useStore.getState()
    try {
      const project = await window.api.newProject(name)
      if (state.settings) {
        project.exportSettings =
          state.settings.exportPresets.find((p) => p.isDefault)?.settings ?? state.settings.export
        project.outputDirectory = state.settings.outputDirectory
      }
      store.setProject(project, null)
      setUrl('')
      state.toast({
        kind: 'success',
        title: 'New project',
        message: 'Paste a VOD link, or pick a streamer to load one of their recent VODs.'
      })
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Could not start a project'), message: message(err) })
    }
  }

  const startNewProject = (): void => {
    const state = useStore.getState()
    if (state.dirty && state.project && state.project.clips.length > 0) {
      setConfirmNewProject(true)
      return
    }
    setNewProjectPrompt(suggestedProjectName())
  }

  const openProject = async (): Promise<void> => {
    const state = useStore.getState()
    try {
      const result = await window.api.openProject()
      if (!result) return
      store.setProject(result.project, result.path)
      state.toast({
        kind: 'success',
        title: 'Project opened',
        message: `${result.project.clips.length} clip${result.project.clips.length === 1 ? '' : 's'} restored.`
      })
      void window.api.recentProjects().then(store.setRecentProjects)
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Open failed'), message: message(err) })
    }
  }

  const openRecentProject = async (path: string): Promise<void> => {
    const state = useStore.getState()
    try {
      const result = await window.api.openProjectPath(path)
      store.setProject(result.project, result.path)
      state.toast({
        kind: 'success',
        title: 'Project opened',
        message: `${result.project.clips.length} clip${result.project.clips.length === 1 ? '' : 's'} restored.`
      })
      void window.api.recentProjects().then(store.setRecentProjects)
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Could not open that project'), message: message(err) })
      // The file may have moved or been deleted since it was last opened.
      void window.api.recentProjects().then(store.setRecentProjects)
    }
  }

  const recoverProject = async (): Promise<void> => {
    const state = useStore.getState()
    try {
      const info = await window.api.checkRecovery()
      if (!info.available || !info.path) {
        state.toast({
          kind: 'info',
          title: 'Nothing to recover',
          message: 'No autosave was found for this installation.'
        })
        return
      }
      const result = await window.api.openProjectPath(info.path)
      store.setProject(result.project, null)
      state.toast({
        kind: 'success',
        title: 'Autosave recovered',
        message: 'Save the project to keep it — the recovery copy is overwritten periodically.'
      })
    } catch (err) {
      state.toast({ kind: 'error', title: title(err, 'Recovery failed'), message: message(err) })
    }
  }

  // ----------------------------------------------------------------- view --
  const env = store.env
  const toolsMissing = env && (!env.ffmpeg.available || !env.resolver.available)

  /** One line describing whatever the installer is doing right now. */
  const installLine = useMemo(() => {
    const active = Object.values(store.toolProgress).filter(
      (p) => p.stage !== 'done' && p.stage !== 'failed'
    )
    if (active.length === 0) return null
    const p = active[active.length - 1]
    const pct = p.totalBytes ? ` — ${Math.round((p.receivedBytes / p.totalBytes) * 100)}%` : ''
    // The installer reports by tool id; the editor is told what is being set up
    // in the same words the rest of the application uses for it.
    return `Setting up ${SETUP_NAME[p.id] ?? 'the last few pieces'}${pct}`
  }, [store.toolProgress])

  const { element: player } = usePlayerViewport({
    onShowGuide: () => setShowGuide(true)
  })

  /**
   * The Project menu, built here rather than in AppHeader: every entry closes
   * over this component's own save/open/recover handlers and its recent-project
   * list. One prop is a smaller seam than relocating half of this file.
   */
  const projectMenu: MenuItem[] = [
    { id: 'new', label: 'New project', icon: 'new', onSelect: startNewProject },
    { id: 'open', label: 'Open project…', icon: 'open', onSelect: () => void openProject() },
    {
      id: 'reopen-last-closed',
      label: lastClosedProjectPath.current
        ? `Reopen "${projectFileName(lastClosedProjectPath.current)}"`
        : 'Reopen last closed project',
      icon: 'undo',
      disabled: !lastClosedProjectPath.current,
      onSelect: () => void openRecentProject(lastClosedProjectPath.current!)
    },
    ...store.recentProjects.slice(0, 6).map((path, i) => ({
      id: `recent-${path}`,
      label: projectFileName(path),
      separatorBefore: i === 0,
      onSelect: () => void openRecentProject(path)
    })),
    {
      id: 'save',
      label: 'Save',
      icon: 'save',
      shortcut: 'Ctrl+S',
      disabled: !store.project,
      onSelect: () => void saveProject(false),
      separatorBefore: true
    },
    {
      id: 'saveas',
      label: 'Save as…',
      disabled: !store.project,
      onSelect: () => void saveProject(true)
    },
    {
      // Its only entry point used to be the Event page; kept here so
      // removing that page did not quietly remove packaging with it.
      id: 'package',
      label: 'Export package…',
      icon: 'download',
      disabled: !store.project,
      onSelect: () => void exportPackage()
    },
    {
      // The other half. Moving the export here left this behind, so a
      // package could be written and never opened again.
      id: 'package-open',
      label: 'Open package…',
      icon: 'folder',
      onSelect: () => void importPackage()
    },
    {
      id: 'recover',
      label: 'Recover autosave',
      icon: 'refresh',
      separatorBefore: true,
      onSelect: () => void recoverProject()
    },
    {
      id: 'history',
      label: 'Version history…',
      icon: 'refresh',
      disabled: !store.projectPath,
      onSelect: () => setShowVersionHistory(true)
    }
  ]

  return (
    <div className="app-shell">
      <AppRail />
      <div className="app">
      <AppHeader
        projectName={store.project?.name ?? 'No project'}
        projectMeta={projectMeta}
        windowMaximized={windowMaximized}
        onCommandPalette={() => setShowCommandPalette(true)}
        onGuide={() => setShowGuide(true)}
        projectMenu={projectMenu}
      />

      {/* One row of the `.app` grid. Everything a page puts on screen lives
          here, so the header and the status bar keep their own rows and cannot
          be pushed out of the viewport by a notice or a coach strip. */}
      <div className="app-body">

      {/*
        * Setup problems are stated as what the editor cannot do, with the one
        * button that fixes it. The names of the missing programs are not the
        * point and are not shown.
        */}
      {toolsMissing && (
        <div style={{ padding: 'var(--space-3) var(--space-3) 0' }}>
          <Notice
            tone="danger"
            title="Ripper Clipper is not finished setting up"
            actions={
              <>
                <Button
                  variant="primary"
                  loading={installLine !== null}
                  onClick={async () => {
                    try {
                      const missing = (await window.api.toolStatus())
                        .filter((t) => !t.installed && !t.unsupported && t.required)
                        .map((t) => t.id)
                      store.setEnv(await window.api.installTools(missing))
                    } catch (err) {
                      store.toast({
                        kind: 'error',
                        title: title(err, 'Setup did not finish'),
                        message: message(err)
                      })
                    }
                  }}
                >
                  Finish setup
                </Button>
                <Button onClick={() => setShowSettings(true)}>Open Settings</Button>
              </>
            }
          >
            {!env?.ffmpeg.available && <div>Clips cannot be exported until setup finishes.</div>}
            {!env?.resolver.available && <div>VOD links cannot be opened until setup finishes.</div>}
            {installLine && <div>{installLine}</div>}
          </Notice>
        </div>
      )}

      {source && !hasMadeAClip && (
        <div className="coach">
          <strong>Making your first clip</strong>
          <ol>
            <li>
              <span className="step">1</span> Play to the moment
            </li>
            <li>
              <span className="step">2</span> Mark in, then mark out
            </li>
            <li>
              <span className="step">3</span> Add clip
            </li>
          </ol>
          <span className="spacer" />
          <Button size="compact" variant="ghost" icon="help" onClick={() => setShowGuide(true)}>
            Show me properly
          </Button>
        </div>
      )}

      <div className="sourcebar">
        <Input
          ref={urlRef}
          className="url"
          placeholder="Paste a Twitch, Kick or YouTube VOD link"
          value={url}
          aria-label="VOD link"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void loadUrl()
          }}
        />
        <Button variant="primary" loading={loading} onClick={() => void loadUrl()}>
          Load
        </Button>
        {source && (
          <div className="meta">
            {source.thumbnailUrl && <img src={source.thumbnailUrl} alt="" />}
            <div className="meta-text">
              <div className="meta-title" title={source.title}>
                <span className="tag">{source.platform}</span> {source.title}
              </div>
              <div className="meta-sub">
                <span>{source.creator}</span>
                <span>{formatTimecode(source.durationSeconds, { millis: false })}</span>
                {source.createdAt && <span>{new Date(source.createdAt).toLocaleDateString()}</span>}
                <span>
                  {clips.length} clip{clips.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {route === 'workspace' && <ReviewRunStrip />}

      {route === 'workspace' && (
      <PovBar
        onAddPov={() => urlRef.current?.focus()}
        onDiscoverEvent={() => setShowDiscovery(true)}
        onFindInPovs={() => setShowFind(true)}
        onManualSync={() => setShowWaveform('pov')}
        overlapAvailableCount={overlapAvailableCount}
        onShowStreamers={() => setShowStreamers(true)}
      />
      )}

      {route === 'workspace' && EditorPage && page === 'editor' && (
        <Suspense fallback={null}>
          <EditorPage
            onExport={() => setSequenceExportPrompt(store.project?.name ?? 'Sequence')}
            onShowGuide={() => setShowGuide(true)}
          />
        </Suspense>
      )}
      {route === 'workspace' && page === 'properties' && (
        <div className="page">
          <PropertiesPage />
        </div>
      )}
      {(route === 'export' || (route === 'workspace' && page === 'export')) && (
        <div className="page">
          <ExportPage
            onExport={(targets) => void exportClips(targets)}
            onGoToVideo={() => setPage('video')}
          />
        </div>
      )}

      <div
        className={`main${showAll ? ' all-povs' : ''}`}
        hidden={route !== 'workspace' || page !== 'video'}
        style={
          {
            ...(sidePanel.value !== undefined && { '--side-width': `${sidePanel.value}px` }),
            ...(timelineStrip.value !== undefined && {
              '--timeline-height': `${timelineStrip.value}px`
            })
          } as React.CSSProperties
        }
      >
        <div className="stage">
          <div className="stage-bar">
            <Button
              icon="file"
              size="compact"
              disabled={!source}
              title="Position this POV's watermark"
              onClick={() => setShowWatermark(true)}
            >
              Watermark
            </Button>
            <Button
              icon="grid"
              size="compact"
              selected={showAll}
              disabled={(store.project?.sources.length ?? 0) < 2}
              title="Play every angle of this moment at once, on one clock"
              onClick={() => setShowAll(!showAll)}
            >
              Show all POVs
            </Button>
            {showAll && (
              <>
                <Button
                  icon="list"
                  size="compact"
                  title="Choose which angles are on screen"
                  onClick={() => setShowAnglePicker(true)}
                >
                  Angles {shownAngles}/{store.project?.sources.length ?? 0}
                </Button>
                <label className="chip-field">
                  Layout
                  <Select
                    size="compact"
                    label="Grid layout"
                    value={String(layout)}
                    options={['auto', 1, 2, 4, 6, 8].map((option) => ({
                      value: String(option),
                      label: option === 'auto' ? 'Automatic' : `${option} across`
                    }))}
                    onChange={(value) =>
                      setLayout(value === 'auto' ? 'auto' : (Number(value) as GridLayout))
                    }
                  />
                </label>
                <span className="hint inline">
                  Click any angle to focus it — the playhead does not move.
                </span>
              </>
            )}
          </div>
          {showAll ? (
            <PovGrid
              focusId={store.activeSourceId}
              layout={layout}
              onFocus={(id) => store.setActiveSource(id)}
            >
              <div className="player-wrap">
                {page === 'video' ? player : null}
                <WatermarkOverlay />
              </div>
            </PovGrid>
          ) : (
            <div className="player-wrap">
              {page === 'video' ? player : null}
              <WatermarkOverlay />
            </div>
          )}
          <Transport />
        </div>

        <aside className="side">
          <div className="tabs" role="tablist">
            {(
              [
                ['clips', 'Clips'],
                ['library', 'Library'],
                ['edit', 'Edit'],
                ['markers', 'Markers']
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                className="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="panel" role="tabpanel">
            {tab === 'clips' && (
              <ClipList
                onExportClip={(clip) => void exportClips([clip])}
                onShowGuide={() => setShowGuide(true)}
                onFindInPovs={() => setShowFind(true)}
              />
            )}
            {tab === 'edit' && (
              <>
                <Properties />
                <EventStreams onLoadVod={loadVod} />
              </>
            )}
            {tab === 'library' && <MediaLibrary />}
            {tab === 'markers' && <MarkerPanel />}
          </div>

          {/*
            * Export actions live at the foot of the panel, ranked: the one
            * everybody wants is primary, the rest are secondary, and the
            * output folder is stated rather than hidden in Settings.
            */}
          <div className="panel-section side-actions">
            <div className="rows">
              <Button
                variant="primary"
                icon="download"
                fullWidth
                disabled={!source || clips.length === 0}
                onClick={() => void exportClips(clips)}
              >
                Export all clips ({clips.length})
              </Button>
              <Button
                fullWidth
                icon="users"
                disabled={
                  !store.project ||
                  store.project.clips.length === 0 ||
                  store.project.sources.length < 2
                }
                title="One file per POV for every clip — every angle of every moment"
                onClick={() => void exportEveryPov()}
              >
                Export every POV ({povExportCount})
              </Button>
              {/*
                The step after exporting: the angles are files now, and this
                turns them into a project an editor can open with the timeline
                already built and the watermark already placed. Deliberately
                below the export buttons, because it needs their output.
              */}
              <Button
                fullWidth
                icon="grid"
                disabled={!store.selectedClipId}
                title="Build a project for DaVinci Resolve, Final Cut or any other editor — angles synchronised, watermark placed"
                onClick={() => setSendToEditor(store.selectedClipId)}
              >
                Send to an editor
              </Button>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button
                  size="compact"
                  disabled={!source || !store.selectedClipId}
                  onClick={() => {
                    const clip = clips.find((c) => c.id === store.selectedClipId)
                    if (clip) void exportClips([clip])
                  }}
                >
                  Selected
                </Button>
                <Button
                  size="compact"
                  icon="copy"
                  disabled={!source || clips.length < 2}
                  onClick={() =>
                    setCombinePrompt(`${source?.title ?? 'Highlights'} — Highlights`)
                  }
                >
                  Combine
                </Button>
                <Button
                  size="compact"
                  icon={store.sequenceIndex === null ? 'play' : 'stop'}
                  selected={store.sequenceIndex !== null}
                  disabled={clips.length === 0}
                  onClick={() => store.setSequenceIndex(store.sequenceIndex === null ? 0 : null)}
                  title="Play every clip in order, without exporting anything"
                >
                  {store.sequenceIndex === null ? 'Preview' : 'Stop'}
                </Button>
              </div>
              <div className="hint">
                Saving to{' '}
                <Button
                  size="compact"
                  variant="ghost"
                  icon="folder"
                  onClick={async () => {
                    const dir = await window.api.pickOutputDirectory()
                    if (!dir || !store.project) return
                    useStore.setState({
                      project: { ...store.project, outputDirectory: dir },
                      dirty: true
                    })
                  }}
                >
                  {store.project?.outputDirectory ?? store.settings?.outputDirectory ?? 'Choose…'}
                </Button>
              </div>
            </div>
          </div>
        </aside>

        <div className="timeline-stack">
          <div className="timeline-tabs" role="tablist" aria-label="Timeline">
            <button
              role="tab"
              className="tab"
              aria-selected={timelineView === 'event' || (!selectedClip && timelineView === 'clip')}
              onClick={() => setTimelineView('event')}
            >
              Whole broadcast
            </button>
            <button
              role="tab"
              className="tab"
              aria-selected={timelineView === 'clip' && Boolean(selectedClip)}
              disabled={!selectedClip}
              onClick={() => setTimelineView('clip')}
              title={selectedClip ? 'The selected clip in every POV' : 'Select a clip first'}
            >
              This clip{selectedClip ? ` — ${selectedClip.name}` : ''}
            </button>
          </div>
          {timelineView === 'clip' && selectedClip ? (
            <ClipTimeline clip={selectedClip} onAlignClip={() => setShowWaveform('clip')} />
          ) : (
            <Timeline />
          )}
        </div>

        <div className="side-resizer">
          <Resizer
            axis="horizontal"
            title="Drag to resize the side panel"
            onDrag={onDragSidePanel}
            onDragEnd={sidePanel.commit}
          />
        </div>
        <div className="timeline-resizer">
          <Resizer
            axis="vertical"
            title="Drag to resize the timeline"
            onDrag={onDragTimeline}
            onDragEnd={timelineStrip.commit}
          />
        </div>
      </div>

      {route === 'home' && <BacklogPage onLoadVod={loadVod} />}
      {route === 'streamers' && <StreamersPage onLoadVod={loadVod} />}
      {route === 'vods' && <VodsPage onLoadVod={loadVod} />}
      {route === 'clips' && <ClipsPage />}
      {route === 'projects' && (
        <HomePage
          onOpenProject={() => void openProject()}
          onNewProject={startNewProject}
          onFindVod={() => setRoute('vods')}
        />
      )}
      {route === 'settings' && (
        <div className="page">
          <SettingsPage />
        </div>
      )}

      <QueuePanel />

      {showGuide && <QuickGuide onClose={() => setShowGuide(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showFind && <FindInPovs onClose={() => setShowFind(false)} />}
      {showSearch && <EventSearch onClose={() => setShowSearch(false)} />}
      {showDiscovery && (
        <EventDiscovery onClose={() => setShowDiscovery(false)} onLoadVod={loadVod} />
      )}
      {showWaveform && (
        <WaveformSync
          onClose={() => setShowWaveform(null)}
          clip={showWaveform === 'clip' ? selectedClip : null}
        />
      )}
      {showStreamers && (
        <StreamersDialog
          onClose={() => setShowStreamers(false)}
          onLoadVod={loadVod}
          overlapClipName={overlapClip?.name ?? null}
          overlap={eventOverlap}
          overlapLoading={eventOverlapLoading}
          onRefreshOverlap={refreshEventOverlap}
        />
      )}
      {showWatermark && <WatermarkEditor onClose={() => setShowWatermark(false)} />}
      {showAnglePicker && <AnglePicker onClose={() => setShowAnglePicker(false)} />}
      {recovery && (
        <Dialog
          title="Unsaved work was recovered"
          size="small"
          onClose={() => setRecovery(null)}
          footer={
            <>
              <Button
                size="compact"
                onClick={() => {
                  // Explicit, and only on the person's say-so. The copy is not
                  // deleted by looking at this dialog.
                  void window.api.discardRecovery()
                  setRecovery(null)
                }}
              >
                Discard it
              </Button>
              <Button size="compact" onClick={() => setRecovery(null)}>
                Decide later
              </Button>
              <Button
                variant="primary"
                size="compact"
                onClick={() => {
                  setRecovery(null)
                  void recoverProject()
                }}
              >
                Open it
              </Button>
            </>
          }
        >
          <p>
            Ripper Clipper did not close cleanly last time. An autosave of{' '}
            <strong>{recovery.projectName ?? 'a project'}</strong>
            {recovery.savedAt ? <> from {new Date(recovery.savedAt).toLocaleString()}</> : null} is
            still on disk.
          </p>
          <p className="hint">
            Opening it does not overwrite anything — save it wherever you like. Leaving this until
            later is fine too, but the copy is replaced the next time autosave runs, so it will not
            wait forever.
          </p>
        </Dialog>
      )}
      {showVersionHistory && store.projectPath && (
        <VersionHistoryDialog
          projectPath={store.projectPath}
          onClose={() => setShowVersionHistory(false)}
          onRestored={(project) => store.setProject(project, null)}
        />
      )}
      {showCommandPalette && (
        <CommandPalette items={commandPaletteItems} onClose={() => setShowCommandPalette(false)} />
      )}
      {pendingUpdate &&
        !updateDismissed &&
        (store.updateStatus.state === 'available' ||
          store.updateStatus.state === 'downloading' ||
          store.updateStatus.state === 'downloaded') && (
          <Dialog
            title={`Ripper Clipper v${pendingUpdate.version} is ready`}
            description={
              store.updateStatus.state === 'downloaded'
                ? 'Downloaded — restart to finish installing.'
                : 'A new version is available to download.'
            }
            size="small"
            onClose={() => setUpdateDismissed(true)}
            footer={
              <>
                <Button onClick={() => setUpdateDismissed(true)}>Later</Button>
                {store.updateStatus.state === 'available' && (
                  <Button variant="primary" icon="download" onClick={() => void window.api.downloadUpdate()}>
                    Download update
                  </Button>
                )}
                {store.updateStatus.state === 'downloading' && (
                  <Button variant="primary" loading disabled>
                    Downloading… {store.updateStatus.percent}%
                  </Button>
                )}
                {store.updateStatus.state === 'downloaded' && (
                  <Button variant="primary" icon="refresh" onClick={() => window.api.installUpdate()}>
                    Restart &amp; install
                  </Button>
                )}
              </>
            }
          >
            {pendingUpdate.releaseNotes && (
              <p style={{ whiteSpace: 'pre-wrap' }}>
                {stripHtml(pendingUpdate.releaseNotes).slice(0, 800)}
              </p>
            )}
          </Dialog>
        )}
      {store.clipNamePromptOpen && (
        <PromptDialog
          title="New clip"
          description="Leave it blank for an automatic name."
          label="Clip name"
          confirmLabel="Create"
          onCancel={() => store.closeClipNamePrompt()}
          onConfirm={(name) => {
            store.closeClipNamePrompt()
            const id = store.createClip(name)
            /*
             * Made the clip; now go and find who else filmed it.
             *
             * Straight after creation rather than as a menu item somewhere: the
             * moment you have just marked is exactly when you know what you are
             * looking for, and the alternative is opening three sites and doing
             * the arithmetic by hand for every clip.
             */
            const made = id
              ? useStore.getState().project?.clips.find((c) => c.id === id)
              : undefined
            if (made?.eventStartTime && made?.eventEndTime) {
              setFindPovsFor({
                name: made.name,
                startSeconds: made.eventStartTime,
                endSeconds: made.eventEndTime
              })
            }
          }}
        />
      )}
      {sendToEditor !== null &&
        (() => {
          const clip = store.project?.clips.find((c) => c.id === sendToEditor)
          return clip ? (
            <EditorExportWizard clip={clip} onClose={() => setSendToEditor(null)} />
          ) : null
        })()}
      {findPovsFor && (
        <FindPovsDialog
          clipName={findPovsFor.name}
          eventStartSeconds={findPovsFor.startSeconds}
          eventEndSeconds={findPovsFor.endSeconds}
          loadedUrls={(store.project?.sources ?? []).map((s) => s.url)}
          onClose={() => setFindPovsFor(null)}
          onAdd={(picked) => {
            setFindPovsFor(null)
            // Sequential on purpose: each resolve is a platform request, and a
            // dozen at once is how a discovery sweep turns into a rate limit.
            void (async () => {
              for (const one of picked) await loadVod(one.url)
            })()
          }}
        />
      )}
      {newProjectPrompt !== null && (
        <PromptDialog
          title="New project"
          description="A project holds one event: every angle of it, and every clip you cut from them. Naming it now is what makes it findable later."
          label="Project name"
          defaultValue={newProjectPrompt}
          confirmLabel="Create project"
          onCancel={() => setNewProjectPrompt(null)}
          onConfirm={(name) => {
            setNewProjectPrompt(null)
            // An empty box means "you pick" rather than an error to argue
            // with — the suggestion is already the sensible answer.
            void newProject(name.trim() === '' ? suggestedProjectName() : name)
          }}
        />
      )}
      {combinePrompt !== null && (
        <PromptDialog
          title="Combine clips into one file"
          description={`All ${clips.length} clips in this POV, joined end to end in their current order.`}
          label="Name for the combined file"
          defaultValue={combinePrompt}
          confirmLabel="Combine"
          onCancel={() => setCombinePrompt(null)}
          onConfirm={(name) => {
            setCombinePrompt(null)
            void combineClips(name)
          }}
        />
      )}
      {sequenceExportPrompt !== null && (
        <PromptDialog
          title="Export the sequence"
          description="Every segment of the timeline, in order, rendered as one file — each from whichever POV was on top."
          label="Name for the exported file"
          defaultValue={sequenceExportPrompt}
          confirmLabel="Export"
          onCancel={() => setSequenceExportPrompt(null)}
          onConfirm={(name) => {
            setSequenceExportPrompt(null)
            void exportTimelineSequence(name)
          }}
        />
      )}
      {confirmQuit && (
        <ConfirmDialog
          title={
            confirmQuit.running > 0 && !confirmQuit.dirty
              ? confirmQuit.running === 1
                ? 'Quit while an export is running?'
                : 'Quit while exports are running?'
              : 'Quit with unsaved changes?'
          }
          description={[
            confirmQuit.dirty
              ? `"${store.project?.name}" has unsaved changes. They will be lost.`
              : null,
            confirmQuit.running > 0
              ? `${confirmQuit.running} export${confirmQuit.running === 1 ? '' : 's'} ${
                  confirmQuit.running === 1 ? 'is' : 'are'
                } still running. Quitting stops ${
                  confirmQuit.running === 1 ? 'it' : 'them'
                } and removes the part-written file${confirmQuit.running === 1 ? '' : 's'}.`
              : null
          ]
            .filter(Boolean)
            .join(' ')}
          confirmLabel={confirmQuit.dirty ? 'Quit without saving' : 'Quit and stop exports'}
          destructive
          onCancel={() => setConfirmQuit(null)}
          onConfirm={() => {
            setConfirmQuit(null)
            void window.api.confirmClose()
          }}
        />
      )}
      {confirmNewProject && (
        <ConfirmDialog
          title="Start a new project?"
          description={`"${store.project?.name}" has ${store.project?.clips.length} unsaved clip${
            store.project?.clips.length === 1 ? '' : 's'
          }. They will be closed without saving.`}
          confirmLabel="Start new project"
          destructive
          onCancel={() => setConfirmNewProject(false)}
          onConfirm={() => {
            setConfirmNewProject(false)
            setNewProjectPrompt(suggestedProjectName())
          }}
        />
      )}
      <Toasts />
      </div>
      <AppStatusBar />
      </div>
    </div>
  )
}

/** A saved project's own name for the Project menu's recent list — no path, no extension. */
/**
 * A clip's hand-drawn audio edits, as the export needs them.
 *
 * These were simply never sent. `EnqueueRequest.clips[].audioEdits` is
 * declared, and the whole main-side chain — `withAudioPovStreams`,
 * `QueueClipInput`, `exportClip`'s `editingAudio`, `buildAudioFilter` —
 * supports it, but the request literal in `exportClips` listed its fields by
 * hand and this one was not among them. So every mute, bleep and duck placed
 * from Properties was dropped on the ordinary Export path, and the file was
 * written with `-c:a copy` and the unedited sound. Nothing said so: the notes
 * that would have mentioned the audio are skipped too when there are no edits.
 * Only the Timeline sequence export passed them, which is why the feature
 * looked like it worked. This is what the feature exists to prevent — the
 * ranges people mute are the ones that cannot be published.
 *
 * Two corrections the raw list needs before it can be used:
 *
 * - **Whose edits.** An edit records the POV it was drawn against, because its
 *   times are relative to *that* POV's cut. `editsForPov` is what Properties
 *   itself filters with, so exporting through it writes exactly what was
 *   drawn on the POV now supplying the sound.
 * - **Which zero.** Edit times are clip-relative, but a POV whose alignment is
 *   uncertain is exported with a safety margin, and the file then starts
 *   `paddingSeconds` *before* the clip does. Unshifted, every gate lands that
 *   much early — on a padded clip the mute misses the words it was drawn over.
 */
function editsToExport(clip: ClipSegment, sound: ExportPart): AudioEdit[] | undefined {
  const mine = editsForPov(clip.audioEdits, sound.source.id, sound.source.id)
  if (mine.length === 0) return undefined
  const pad = sound.paddingSeconds
  if (pad <= 0) return mine
  return mine.map((edit) => ({
    ...edit,
    startSeconds: edit.startSeconds + pad,
    endSeconds: edit.endSeconds + pad
  }))
}

function projectFileName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.cookieclip$/i, '')
}

function clipStatusFor(stage: JobStage): ClipStatus {
  switch (stage) {
    case 'queued':
    case 'paused':
      return 'queued'
    case 'resolving':
      return 'resolving'
    case 'downloading-video':
    case 'downloading-audio':
      return 'downloading'
    case 'cutting':
    case 'muxing':
      return 'processing'
    case 'verifying':
      return 'verifying'
    case 'complete':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'idle'
  }
}
