import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatTimecode } from '@shared/time'
import type { ClipSegment, ClipStatus, JobStage, VodSource } from '@shared/types'
import { resolveWatermark, streamerFor } from '@shared/watermark'
import type { ResolvedWatermark, WatermarkConfig } from '@shared/watermark'
import type { EnqueueRequest, EventOverlapReply, TimelineExportSegment } from '@shared/ipc'
import { planExport } from '@shared/povMapping'
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
import PovGrid from './components/PovGrid.js'
import type { GridLayout } from './components/PovGrid.js'
import QueuePanel from './components/QueuePanel.js'
import { message, title } from './components/QualityPanel.js'
import SettingsDialog from './components/SettingsDialog.js'
import QuickGuide from './components/QuickGuide.js'
import StreamersDialog from './components/StreamersDialog.js'
import VersionHistoryDialog from './components/VersionHistoryDialog.js'
import FindInPovs from './components/FindInPovs.js'
import WaveformSync from './components/WaveformSync.js'
import PovBar, { povLabel } from './components/PovBar.js'
import WatermarkEditor from './components/WatermarkEditor.js'
import WatermarkOverlay from './components/WatermarkOverlay.js'
import EventStreams from './components/EventStreams.js'
import EventDiscovery from './components/EventDiscovery.js'
import EventPage from './components/EventPage.js'
import EventSearch from './components/EventSearch.js'
import HealthPage from './components/HealthPage.js'
import Toasts from './components/Toasts.js'
import CommandPalette from './components/CommandPalette.js'
import { playerBus } from './player/controller.js'
import { usePlayerViewport } from './player/usePlayerViewport.js'
import { useShortcuts } from './hooks/useShortcuts.js'
import { usePanelSize } from './usePanelSize.js'
import {
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  Input,
  Menu,
  Notice,
  PromptDialog,
  Resizer,
  Select,
  useTheme
} from './ui/index.js'

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
  const store = useStore()
  const clips = useActiveClips()
  const source = useActiveSource()
  const [tab, setTab] = useState<Tab>('clips')
  const page = useStore((s) => s.page)
  const setPage = useStore((s) => s.setPage)
  const [showAll, setShowAll] = useState(false)
  const [layout, setLayout] = useState<GridLayout>('auto')
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
  const [sequenceExportPrompt, setSequenceExportPrompt] = useState<string | null>(null)
  const [confirmNewProject, setConfirmNewProject] = useState(false)
  const [showWatermark, setShowWatermark] = useState(false)
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [confirmQuit, setConfirmQuit] = useState(false)
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
      void window.api
        .updateSettings({ ui: { ...store.settings.ui, ...patch } })
        .then((next) => store.setSettings(next))
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
    cssDefault: 240,
    min: 140,
    max: 640,
    viewportFraction: 0.6,
    axis: 'height',
    onCommit: (px) => patchUiSettings({ timelineHeight: Math.round(px) })
  })
  const onDragTimeline = useCallback(
    (deltaPx: number) => timelineStrip.drag(-deltaPx),
    [timelineStrip]
  )


  useShortcuts(() => setShowFind(true), () => setShowCommandPalette(true))
  // One place decides what theme the whole application is in, and it repaints
  // everything at once because every colour comes from one variable block.
  useTheme(store.settings?.ui.theme)

  // There is no OS titlebar to report this, so the maximize/restore icon has
  // to ask directly and then listen for changes it did not cause itself
  // (double-clicking the drag region, Aero Snap, a window-manager shortcut).
  useEffect(() => {
    void window.api.isWindowMaximized().then(setWindowMaximized)
    return window.api.onWindowMaximized(setWindowMaximized)
  }, [])

  // The window doesn't actually close on its own — see main/index.ts's
  // `close` handler — so whatever triggered it (titlebar button, Alt+F4,
  // the taskbar) ends up here with a chance to check for unsaved work first.
  useEffect(() => {
    return window.api.onBeforeClose(() => {
      if (useStore.getState().dirty) setConfirmQuit(true)
      else void window.api.confirmClose()
    })
  }, [])

  const commandPaletteItems = [
    ...clips.map((clip) => ({
      id: `clip-${clip.id}`,
      label: `Clip: ${clip.name}`,
      icon: 'scissors' as const,
      onSelect: () => {
        setPage('video')
        setTab('clips')
        store.selectClip(clip.id)
        playerBus.seek(clip.startSeconds)
      }
    })),
    { id: 'new-clip', label: 'New clip…', icon: 'plus' as const, onSelect: () => store.requestCreateClip() },
    {
      id: 'find-in-povs',
      label: 'Find in all POVs',
      icon: 'search' as const,
      onSelect: () => setShowFind(true)
    },
    {
      id: 'open-streamers',
      label: 'Open Streamers',
      icon: 'users' as const,
      onSelect: () => setShowStreamers(true)
    },
    {
      id: 'open-settings',
      label: 'Open Settings',
      icon: 'settings' as const,
      onSelect: () => setShowSettings(true)
    },
    {
      id: 'version-history',
      label: 'Version history',
      icon: 'clock' as const,
      onSelect: () => setShowVersionHistory(true)
    },
    { id: 'quick-guide', label: 'Quick guide', icon: 'help' as const, onSelect: () => setShowGuide(true) }
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
  const overlapAvailableCount = useMemo(
    () => eventOverlap?.streams.filter((s) => s.availability === 'available').length ?? 0,
    [eventOverlap]
  )

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
        const [env, settings, jobs, streamers, recentProjects] = await Promise.all([
          window.api.env(),
          window.api.getSettings(),
          window.api.listJobs(),
          // The streamer library is loaded up front because watermark defaults
          // resolve through it — a POV has to know whose logo it inherits.
          window.api.listStreamers().catch(() => []),
          window.api.recentProjects().catch(() => [])
        ])
        store.setEnv(env)
        store.setSettings(settings)
        store.setJobs(jobs)
        store.setStreamers(streamers)
        store.setRecentProjects(recentProjects)

        const project = await window.api.newProject('Untitled project')
        project.exportSettings = settings.exportPresets.find((p) => p.isDefault)?.settings ?? settings.export
        project.outputDirectory = settings.outputDirectory
        store.setProject(project, null)

        // A .cookieclip passed on the command line (double-clicked in Explorer).
        const startupPath = await window.api.startupProjectPath()
        if (startupPath) {
          const opened = await window.api.openProjectPath(startupPath)
          store.setProject(opened.project, opened.path)
        }

        const recovery = await window.api.checkRecovery()
        if (recovery.available && recovery.path) {
          store.toast({
            kind: 'warning',
            title: 'Recovered project available',
            message: `An autosave of "${recovery.projectName ?? 'a project'}" from ${
              recovery.savedAt ? new Date(recovery.savedAt).toLocaleString() : 'an earlier session'
            } was found. Open it from File → Recover, or it will be replaced by the next autosave.`
          })
        }
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
      const isSettled = (stage: JobStage): boolean =>
        stage === 'complete' || stage === 'failed' || stage === 'cancelled'
      const activeBefore = previous.some((j) => !isSettled(j.progress.stage))
      const activeAfter = jobs.some((j) => !isSettled(j.progress.stage))
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
      store.addSource(resolved)
      store.toast({
        kind: 'success',
        title: 'VOD loaded',
        message: `${resolved.title} — ${formatTimecode(resolved.durationSeconds, { millis: false })}`
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
            : undefined
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
  const newProject = async (): Promise<void> => {
    const state = useStore.getState()
    try {
      const project = await window.api.newProject('Untitled project')
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
    void newProject()
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

  return (
    <div className="app">
      {/*
        * The shell: identity, project commands, undo, the three workspaces, and
        * help. It does not change between pages, so the editor never has to
        * re-find anything after switching.
        */}
      <header
        className="topbar"
        onDoubleClick={(e) => {
          // Only the drag region itself, not a double-click that landed on a
          // button inside it — standard titlebar behaviour, not a shortcut
          // that happens to fire from anywhere in the strip.
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('spacer')) {
            void window.api.toggleMaximizeWindow()
          }
        }}
      >
        <div className="brand">
          Ripper<span>Clipper</span>
        </div>

        <Menu
          label="Project"
          icon="file"
          items={[
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
          ]}
        />

        <span className="project-name ellipsis" title={store.projectPath ?? 'Not saved yet'}>
          {store.project?.name ?? 'No project'}
          {store.dirty && (
            <span className="dirty" title="Unsaved changes">
              •
            </span>
          )}
        </span>

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

        <span className="spacer" />

        <nav className="pages" aria-label="Workspaces">
          {(
            [
              ['video', 'Video'],
              ['event', 'Event'],
              ...(EditorPage ? ([['editor', 'Editor']] as const) : []),
              ['properties', 'Properties'],
              ['health', 'Health'],
              ['export', 'Export']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`page-tab${page === id ? ' on' : ''}`}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <span className="spacer" />

        <Button
          icon="search"
          onClick={() => setShowSearch(true)}
          disabled={!store.project}
          title="Search clips, POVs, collections, moments and anything said on camera"
        >
          Search
        </Button>

        <div className="nav-badge-anchor">
          <Button
            icon="users"
            onClick={() => setShowStreamers(true)}
            title={
              overlapAvailableCount > 0
                ? `${overlapAvailableCount} other saved streamer${overlapAvailableCount === 1 ? '' : 's'} covered this clip's moment`
                : undefined
            }
          >
            Streamers
          </Button>
          {overlapAvailableCount > 0 && (
            <span className="nav-badge" aria-label={`${overlapAvailableCount} other streamers live at this moment`}>
              {overlapAvailableCount > 9 ? '9+' : overlapAvailableCount}
            </span>
          )}
        </div>
        <IconButton icon="help" label="How Ripper Clipper works" onClick={() => setShowGuide(true)} />
        <IconButton icon="settings" label="Settings" onClick={() => setShowSettings(true)} />

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

      {source && clips.length === 0 && (
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

      <PovBar
        onAddPov={() => urlRef.current?.focus()}
        onDiscoverEvent={() => setShowDiscovery(true)}
        onFindInPovs={() => setShowFind(true)}
        onManualSync={() => setShowWaveform('pov')}
      />

      {EditorPage && page === 'editor' && (
        <Suspense fallback={null}>
          <EditorPage
            onExport={() => setSequenceExportPrompt(store.project?.name ?? 'Sequence')}
            onShowGuide={() => setShowGuide(true)}
          />
        </Suspense>
      )}
      {page === 'event' && <EventPage onLoadVod={loadVod} />}
      {page === 'health' && <HealthPage onLoadVod={loadVod} />}
      {page === 'properties' && (
        <div className="page">
          <PropertiesPage />
        </div>
      )}
      {page === 'export' && (
        <div className="page">
          <ExportPage
            onExport={(targets) => void exportClips(targets)}
            onGoToVideo={() => setPage('video')}
          />
        </div>
      )}

      <div
        className={`main${showAll ? ' all-povs' : ''}`}
        hidden={page !== 'video'}
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
            store.createClip(name)
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
          title="Quit with unsaved changes?"
          description={`"${store.project?.name}" has unsaved changes. They will be lost.`}
          confirmLabel="Quit without saving"
          destructive
          onCancel={() => setConfirmQuit(false)}
          onConfirm={() => {
            setConfirmQuit(false)
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
            void newProject()
          }}
        />
      )}
      <Toasts />
    </div>
  )
}

/** A saved project's own name for the Project menu's recent list — no path, no extension. */
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
