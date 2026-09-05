import { useMemo } from 'react'
import { markEverywhere } from '@shared/markEverywhere'
import { create } from 'zustand'
import {
  addClip,
  clipsForSource,
  createId,
  duplicateClip,
  makeMarker,
  markerToRange,
  removeClip,
  reorderClips,
  updateClip
} from '@shared/clips'
import type { AudioEdit } from '@shared/audioEdits'
import { clampRange, roundMs } from '@shared/time'
import { eventToLocal, isSynced, localToEvent, solveMapping } from '@shared/sync'
import {
  buildClipMappings,
  clipRangeInPov,
  eventRangeFor,
  refreshClipMapping,
  refreshClipMappings
} from '@shared/povMapping'
import type { ManualAlignment, SyncAnchor } from '@shared/sync'
import { DEFAULT_EXPORT_SETTINGS } from '@shared/defaults'
import { prefetchClipMedia } from './media/prefetch.js'
import {
  addItem as addTimelineItem,
  addMarker as addTimelineMarker,
  addTrack as addTimelineTrack,
  appendClip as appendClipToTimeline,
  deleteItem as deleteTimelineItem,
  duplicateItem as duplicateTimelineItem,
  emptyTimeline,
  moveItem as moveTimelineItem,
  patchItem as patchTimelineItem,
  patchMarker as patchTimelineMarker,
  patchTrack as patchTimelineTrack,
  removeMarker as removeTimelineMarker,
  removeTrack as removeTimelineTrack,
  renameTrack as renameTimelineTrack,
  splitItem as splitTimelineItem,
  trimItem as trimTimelineItem,
  unlinkItem as unlinkTimelineItem,
  closeGapAt as closeTimelineGapAt,
  deleteItems as deleteTimelineItems,
  itemsInSpan as timelineItemsInSpan,
  moveItems as moveTimelineItems,
  nudgeItems as nudgeTimelineItems,
  reorderTrack as reorderTimelineTrackAt,
  splitItemsAt as splitTimelineItemsAt,
  withLinked as withLinkedTimelineItems
} from '@shared/timeline'
import type { ItemMove } from '@shared/timeline'
import type {
  AppSettings,
  ClipSegment,
  ClipWorkflowState,
  EditorTimeline,
  EventInfo,
  ExportJob,
  LiveState,
  Marker,
  MarkerCategory,
  ProjectFile,
  StreamInfo,
  TimelineItem,
  TimelineItemKind,
  TimelineMarker,
  TimelineTrack,
  VodSource
} from '@shared/types'
import type { LiveNow, LiveSnapshot, StreamerGroup } from '@shared/ipc'
import { emptyEvent } from '@shared/event'
import {
  addCollection,
  removeCollection,
  renameCollection,
  reorderCollection,
  setClipCollection,
  setClipWorkflow,
  setPovUsed
} from '@shared/collections'
import type { SavedStreamer } from '@shared/ipc'
import type { WatermarkConfig } from '@shared/watermark'
import type { EnvInfo, InstallProgress, ToastEvent, UpdateStatus } from '@shared/ipc'

/** The three workspaces inside a clip. The multi-track editor lives inside 'video', as a timeline mode. */
export type WorkspacePage = 'video' | 'editor' | 'properties' | 'export'

/**
 * Where the app is, at the top level.
 *
 * This sits *above* `page`, which keeps its existing meaning as the tab
 * inside the workspace. Splitting them is what lets the rail be permanent
 * chrome without the workspace losing its own place when you leave and come
 * back to it.
 */
export type AppRoute =
  | 'home'
  | 'projects'
  | 'streamers'
  | 'vods'
  | 'workspace'
  | 'clips'
  | 'export'
  | 'settings'

/**
 * Which category Settings is showing.
 *
 * Navigation state, so the rail and the command palette can both arrive at a
 * specific one. Local state in SettingsBody made "open Diagnostics"
 * unexpressible without a second copy of the nav.
 */
export type SettingsTab =
  | 'appearance'
  | 'playback'
  | 'export'
  | 'downloads'
  | 'storage'
  | 'shortcuts'
  | 'setup'
  | 'diagnostics'

/** Group filter sentinel: no group at all, as distinct from "any group". */
export const UNGROUPED = 'ungrouped'
/** Collection filter sentinel: filed nowhere, as distinct from "any collection". */
export const LOOSE = 'loose'

export interface Toast extends ToastEvent {
  id: string
  /** A clickable follow-up ("Undo") — renderer-only, so it never crosses the IPC boundary the base ToastEvent does. */
  action?: { label: string; onClick: () => void }
}

interface HistoryEntry {
  clips: ClipSegment[]
  markers: Marker[]
  /** Sources too, so removing a POV is undoable like any other edit. */
  sources: VodSource[]
  /** The Editor's own sequence — absent before it's ever been created. */
  timeline: EditorTimeline | undefined
  /**
   * The event block: its name, its real-world window, its collections and
   * moments.
   *
   * `setEventInfo` and every collection action already pushed a history entry,
   * but the entry did not carry this field — so renaming an event and pressing
   * Ctrl+Z restored nothing and left the new name in place. Anything an action
   * changes has to be in here, or undo quietly lies about what it undid.
   */
  event: EventInfo | undefined
}

interface State {
  // project
  project: ProjectFile | null
  projectPath: string | null
  dirty: boolean
  past: HistoryEntry[]
  future: HistoryEntry[]

  // environment
  env: EnvInfo | null
  settings: AppSettings | null
  updateStatus: UpdateStatus
  /** Paths of recently saved/opened projects, newest first. */
  recentProjects: string[]

  // selection & editing
  activeSourceId: string | null
  selectedClipId: string | null
  inPoint: number | null
  outPoint: number | null
  /** True while the "name this clip" prompt is open, requested from three different entry points. */
  clipNamePromptOpen: boolean

  // player
  currentTime: number
  playing: boolean
  duration: number
  volume: number
  muted: boolean
  rate: number
  loopSelection: boolean
  sequenceIndex: number | null

  // timeline viewport (seconds)
  viewStart: number
  viewSpan: number

  // the Editor's own timeline — a separate clock from `currentTime` above,
  // which is one POV's own scrub position; this is a position on the
  // assembled multi-track sequence, which maps to a different instant in
  // whichever POV is on top at that point.
  timelinePlayheadSeconds: number
  /**
   * The whole selection. `selectedTimelineItemId` is kept in step as its last
   * member because the Inspector edits exactly one item — a panel of numeric
   * fields has nothing sensible to show for four items at once — while every
   * timeline operation acts on the set.
   */
  selectedTimelineItemIds: string[]
  selectedTimelineItemId: string | null
  timelineRippleDelete: boolean
  /** Snapping to edges, the playhead and markers. Off is a real editing mode, not a bug. */
  timelineSnap: boolean
  /** Copied items, in their own relative arrangement. Never persisted. */
  timelineClipboard: TimelineItem[]

  // navigation
  /** Which workspace is showing. One page, one job. */
  page: WorkspacePage
  /** Which top-level destination the rail is on. */
  route: AppRoute
  /** Which settings category is showing. See SettingsTab. */
  settingsTab: SettingsTab
  /**
   * Icon-only rail. Derived from window width, but the editor can override
   * it — a deliberate choice must survive a resize that would undo it.
   */
  railCollapsed: boolean
  railCollapsedByUser: boolean | null
  /** Group id, null = every group, UNGROUPED = those in none. */
  streamerGroupFilter: string | null
  /** Collection id, null = every clip, LOOSE = those filed nowhere. */
  collectionFilter: string | null
  /**
   * The moments still to work through, as clip ids, in order. Empty means no
   * run — deliberately the only state, because a separate `inReviewRun` flag
   * is exactly the second axis that removing the tab strip was about.
   */
  reviewRun: string[]
  /** Position in `reviewRun`. Meaningless when the run is empty. */
  reviewIndex: number

  // jobs & ui
  jobs: ExportJob[]
  /**
   * Live state per source id, pushed from main.
   *
   * Kept beside the project rather than on `VodSource` because it is transient
   * runtime state: it is never saved, and merging it into the project would
   * mark the project dirty every time a buffer gained a second of media.
   */
  live: Record<string, LiveState>
  /**
   * Who is on air, shared by every page that shows it.
   *
   * Loaded at startup from the snapshot on disk, so the Backlog's Live now
   * band and the roster's badges are drawn on the first paint rather than
   * appearing a second after you arrive. Whichever of those pages is open
   * refreshes it for real and writes back here; two pages polling the same
   * forty-five channels into two private copies of the same object was the
   * arrangement before this.
   */
  liveNow: Record<string, LiveNow>
  streamerGroups: StreamerGroup[]
  /** Set when the live memory budget forced a smaller window than was asked for. */
  liveWindowNotice: string | null
  toasts: Toast[]
  busy: string | null
  /** Latest progress line per tool while the installer is running. */
  toolProgress: Record<string, InstallProgress>
}

interface Actions {
  setEnv: (env: EnvInfo) => void
  setSettings: (settings: AppSettings) => void
  /**
   * Change a setting and show it immediately.
   *
   * Persisting goes to the main process, which writes the file — and that
   * process may be in the middle of an export at the time. Waiting for the
   * write before showing the change is what made switching between light and
   * dark feel slow: nothing about the new colour scheme depends on it having
   * reached disk. So the interface moves now, the write happens behind it,
   * and the authoritative result replaces the guess when it arrives. A write
   * that fails puts the old value back and says so.
   */
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
  setUpdateStatus: (status: UpdateStatus) => void
  setRecentProjects: (paths: string[]) => void

  setProject: (project: ProjectFile, path: string | null) => void
  markClean: (project?: ProjectFile) => void
  addSource: (source: VodSource) => void
  setSourceFormats: (sourceId: string, formats: StreamInfo[]) => void
  /**
   * A broadcast's length has moved on, or it has stopped.
   *
   * Deliberately not marking the project dirty: nothing the person did changed,
   * the world did. Saving on a timer that runs while you watch would turn every
   * open project into unsaved changes for no edit anyone made.
   */
  setSourceLiveStatus: (
    sourceId: string,
    status: { durationSeconds: number; stillRecording: boolean }
  ) => void
  addSyncAnchors: (anchors: SyncAnchor[]) => void
  setActiveSource: (id: string | null) => void
  removeSource: (id: string) => void
  /** Empty the project of POVs, clips, markers and the event block. One undo step. */
  clearEvent: () => void
  /**
   * Tick or untick angles in the wall's angle picker.
   *
   * Takes the whole set rather than one id at a time so the picker's "all" and
   * "none" are one change and one undo step, not fourteen.
   */
  setWallAngles: (hiddenIds: string[]) => void

  pushHistory: () => void
  undo: () => void
  redo: () => void

  createClip: (name?: string) => string | null
  /** Opens the "name this clip" prompt, if there's actually a clip to create. App.tsx owns the dialog. */
  requestCreateClip: () => void
  closeClipNamePrompt: () => void
  setClipPov: (clipId: string, role: 'video' | 'audio', sourceId: string | undefined) => void
  /**
   * Move a POV's mapping by hand.
   *
   * `outcome` comes from `classifyManualAlignment` and decides whether the
   * result is locked or an estimate. It is a required argument rather than an
   * option: every caller has a detection result (or knowingly has none), and
   * defaulting it would quietly restore the bug where every nudge wrote
   * `manual` at 100%.
   */
  nudgeSync: (sourceId: string, deltaSeconds: number, outcome: ManualAlignment) => void
  setClipPovOffset: (clipId: string, sourceId: string, seconds: number) => void
  /** The saved streamer library, kept here so watermark defaults can resolve. */
  streamers: SavedStreamer[]
  setStreamers: (streamers: SavedStreamer[]) => void
  /** Give one VOD its own watermark, or clear the override. */
  setSourceWatermark: (sourceId: string, watermark: WatermarkConfig | null) => void

  /** Draw a new mute/bleep/duck range onto a clip's chosen sound POV. */
  addAudioEdit: (clipId: string, edit: Omit<AudioEdit, 'id'>) => void
  patchAudioEdit: (clipId: string, editId: string, patch: Partial<AudioEdit>) => void
  removeAudioEdit: (clipId: string, editId: string) => void

  patchClip: (
    id: string,
    patch: Partial<Pick<ClipSegment, 'name' | 'startSeconds' | 'endSeconds' | 'status' | 'tag'>>,
    /** `history: false` while a drag is in flight — the drag pushed once at its start. */
    opts?: { history?: boolean }
  ) => void
  /** Applies the same tag to several clips in one update, for the clip list's multi-select. */
  patchClips: (ids: string[], patch: Partial<Pick<ClipSegment, 'tag'>>) => void
  deleteClip: (id: string) => void
  copyClip: (id: string) => void
  moveClip: (from: number, to: number) => void
  selectClip: (id: string | null) => void

  /** The event this project covers — see shared/event.ts and shared/collections.ts. */
  /** Creates the event block if absent. Safe to call whenever; a no-op once one exists. */
  ensureEvent: () => void
  setEventInfo: (patch: Partial<Pick<EventInfo, 'name' | 'startSeconds' | 'endSeconds' | 'note'>>) => void
  addClipCollection: (name: string) => void
  renameClipCollection: (id: string, name: string) => void
  removeClipCollection: (id: string) => void
  reorderClipCollection: (id: string, toIndex: number) => void
  setClipCollectionId: (clipId: string, collectionId: string | null) => void
  setClipWorkflowState: (clipId: string, workflow: ClipWorkflowState) => void
  setClipPovUsed: (clipId: string, sourceId: string, used: boolean) => void
  addEventMoment: (init: { timeSeconds: number; name: string; note?: string }) => void
  removeEventMoment: (id: string) => void

  /** The Editor's multi-track timeline — see shared/timeline.ts. */
  /** Creates the project's timeline (V1 + A1) if it doesn't exist yet. Safe to call whenever the Editor opens — a no-op once one exists. */
  ensureTimeline: () => void
  addTimelineTrack: (kind: TimelineItemKind) => void
  removeTimelineTrack: (trackId: string) => void
  renameTimelineTrack: (trackId: string, name: string) => void
  patchTimelineTrack: (
    trackId: string,
    patch: Partial<Pick<TimelineTrack, 'locked' | 'hidden' | 'muted' | 'solo'>>
  ) => void
  /** Places a clip's picture (and sound, if given an audio track) as one linked pair. */
  addClipToTimeline: (clipId: string, videoTrackId: string, audioTrackId?: string) => void
  addTimelineItem: (item: Omit<TimelineItem, 'id'>) => string | null
  moveTimelineItem: (itemId: string, trackId: string, timelineStartSeconds: number) => void
  trimTimelineItem: (itemId: string, side: 'start' | 'end', newTimelineBoundarySeconds: number) => void
  splitTimelineItem: (itemId: string, atTimelineSeconds: number) => void
  deleteTimelineItem: (itemId: string, ripple?: boolean) => void
  duplicateTimelineItem: (itemId: string) => void
  patchTimelineItem: (itemId: string, patch: Partial<TimelineItem>) => void
  unlinkTimelineItem: (itemId: string) => void
  /** A marker on the assembled *sequence* — distinct from `addMarker`, which marks a moment on one POV's own VOD. */
  addTimelineMarker: (timeSeconds: number, name?: string) => string | null
  removeTimelineMarker: (markerId: string) => void
  patchTimelineMarker: (
    markerId: string,
    patch: Partial<Pick<TimelineMarker, 'name' | 'note' | 'timeSeconds'>>
  ) => void

  addMarker: (label?: string, category?: MarkerCategory) => void
  /**
   * The same instant, marked in every angle that was recording it.
   *
   * Distinct from `addMarker`, which marks one POV: finding a moment is the
   * expensive part of multi-POV work and finding it once should be enough.
   */
  addMarkerEverywhere: (label?: string, category?: MarkerCategory) => number
  deleteMarker: (id: string) => void
  markerToClip: (id: string) => void

  setInPoint: (seconds: number | null) => void
  setOutPoint: (seconds: number | null) => void

  setCurrentTime: (seconds: number) => void
  setPlaying: (playing: boolean) => void
  setDuration: (seconds: number) => void
  setVolume: (value: number) => void
  setMuted: (value: boolean) => void
  setRate: (value: number) => void
  setLoopSelection: (value: boolean) => void
  setSequenceIndex: (index: number | null) => void

  setTimelinePlayhead: (seconds: number) => void
  /** `toggle` is shift/ctrl-click; `add` is the marquee adding to what is already held. */
  selectTimelineItem: (id: string | null, mode?: 'replace' | 'toggle' | 'add') => void
  selectTimelineItems: (ids: string[]) => void
  selectTimelineItemsInSpan: (
    startSeconds: number,
    endSeconds: number,
    trackIds: string[],
    additive?: boolean
  ) => void
  setTimelineRippleDelete: (value: boolean) => void
  setTimelineSnap: (value: boolean) => void
  moveTimelineItems: (moves: ItemMove[]) => void
  nudgeTimelineItems: (ids: string[], deltaSeconds: number) => void
  deleteTimelineItems: (ids: string[], ripple?: boolean) => void
  duplicateTimelineItems: (ids: string[]) => void
  splitTimelineAt: (atTimelineSeconds: number, ids?: string[]) => void
  closeTimelineGap: (trackId: string, atTimelineSeconds: number) => void
  reorderTimelineTrack: (trackId: string, direction: 'up' | 'down') => void
  copyTimelineItems: (ids: string[]) => void
  pasteTimelineItems: (atTimelineSeconds: number) => void

  setView: (start: number, span: number) => void
  zoomBy: (factor: number, anchorSeconds?: number) => void

  setPage: (page: WorkspacePage) => void
  setRoute: (route: AppRoute) => void
  setSettingsTab: (settingsTab: SettingsTab) => void
  setLive: (snapshot: LiveSnapshot) => void
  setLiveNow: (live: Record<string, LiveNow>) => void
  setStreamerGroups: (groups: StreamerGroup[]) => void
  /** Width-derived collapse. Ignored once the editor has chosen for themselves. */
  setRailCollapsedByWidth: (collapsed: boolean) => void
  toggleRail: () => void
  setStreamerGroupFilter: (groupId: string | null) => void
  setCollectionFilter: (collectionId: string | null) => void
  startReviewRun: (clipIds: string[]) => void
  advanceRun: (delta: number) => void
  endRun: () => void
  setJobs: (jobs: ExportJob[]) => void
  setToolProgress: (progress: InstallProgress) => void
  toast: (toast: ToastEvent & { action?: Toast['action'] }) => void
  dismissToast: (id: string) => void
  setBusy: (label: string | null) => void
}

export type Store = State & Actions

const emptyState: State = {
  project: null,
  projectPath: null,
  dirty: false,
  past: [],
  future: [],
  env: null,
  settings: null,
  updateStatus: { state: 'idle' },
  recentProjects: [],
  activeSourceId: null,
  selectedClipId: null,
  inPoint: null,
  outPoint: null,
  clipNamePromptOpen: false,
  currentTime: 0,
  playing: false,
  duration: 0,
  volume: 1,
  muted: false,
  rate: 1,
  loopSelection: false,
  sequenceIndex: null,
  timelinePlayheadSeconds: 0,
  selectedTimelineItemIds: [],
  selectedTimelineItemId: null,
  timelineRippleDelete: false,
  timelineSnap: true,
  timelineClipboard: [],
  viewStart: 0,
  viewSpan: 600,
  page: 'video',
  route: 'home',
  settingsTab: 'appearance',
  live: {},
  liveNow: {},
  streamerGroups: [],
  liveWindowNotice: null,
  railCollapsed: false,
  railCollapsedByUser: null,
  streamerGroupFilter: null,
  collectionFilter: null,
  reviewRun: [],
  reviewIndex: 0,
  jobs: [],
  toasts: [],
  busy: null,
  toolProgress: {}
}

const MAX_HISTORY = 100

export const useStore = create<Store>((set, get) => ({
  ...emptyState,

  setEnv: (env) => set({ env }),
  setSettings: (settings) => set({ settings }),
  patchSettings: async (patch) => {
    const previous = get().settings
    if (!previous) return
    set({ settings: { ...previous, ...patch } })
    try {
      set({ settings: await window.api.updateSettings(patch) })
      // Only a tool path can change what is installed, so that is the only
      // patch worth a second round trip to find out.
      if (patch.advanced) set({ env: await window.api.env() })
    } catch {
      set({ settings: previous })
      get().toast({
        kind: 'error',
        title: 'Could not save that',
        message: 'The setting could not be written, so it has been put back.'
      })
    }
  },
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  setRecentProjects: (recentProjects) => set({ recentProjects }),

  setProject: (project, path) =>
    set({
      project,
      projectPath: path,
      dirty: false,
      past: [],
      future: [],
      activeSourceId: project.sources[0]?.id ?? null,
      selectedClipId: null,
      inPoint: null,
      outPoint: null,
      currentTime: 0,
      duration: project.sources[0]?.durationSeconds ?? 0,
      viewStart: 0,
      viewSpan: Math.max(60, project.sources[0]?.durationSeconds ?? 600)
    }),

  markClean: (project) => set((s) => ({ dirty: false, project: project ?? s.project })),

  addSource: (incoming) =>
    set((s) => {
      if (!s.project) return {}
      const previous = s.project.sources.find((x) => x.id === incoming.id)
      const source = withSyncMapping(incoming, previous, s.project.syncAnchors ?? [])
      const exists = previous !== undefined
      const sources = exists
        ? s.project.sources.map((x) => (x.id === source.id ? { ...x, ...source } : x))
        : [...s.project.sources, source]
      // A new POV joins every existing clip here — no backfill pass, no
      // clip recreation, and the editor sees it immediately.
      const clips = refreshClipMappings(s.project.clips, sources, new Date().toISOString())
      return {
        project: { ...s.project, sources, clips },
        activeSourceId: source.id,
        duration: source.durationSeconds,
        currentTime: 0,
        viewStart: 0,
        viewSpan: Math.max(60, source.durationSeconds),
        dirty: true
      }
    }),

  setSourceLiveStatus: (sourceId, status) =>
    set((s) => {
      if (!s.project) return {}
      const before = s.project.sources.find((x) => x.id === sourceId)
      if (
        !before ||
        (before.durationSeconds === status.durationSeconds &&
          (before.stillRecording === true) === status.stillRecording)
      ) {
        // Nothing moved. Returning the same project keeps every subscriber —
        // the wall, the timeline, the clip list — from re-rendering on a timer.
        return {}
      }
      return {
        project: {
          ...s.project,
          sources: s.project.sources.map((x) =>
            x.id === sourceId
              ? { ...x, durationSeconds: status.durationSeconds, stillRecording: status.stillRecording }
              : x
          )
        }
      }
    }),

  setSourceFormats: (sourceId, formats) =>
    set((s) => {
      if (!s.project) return {}
      return {
        project: {
          ...s.project,
          sources: s.project.sources.map((x) =>
            x.id === sourceId ? { ...x, formats, formatsInspected: true } : x
          )
        }
      }
    }),

  /**
   * Fold new evidence (currently only audio cross-checks) into the anchor
   * pool and re-solve just the POVs it actually references — the same
   * weighted solver every other kind of evidence already goes through, so a
   * `manual` mapping still cannot be overridden by it.
   */
  addSyncAnchors: (anchors) =>
    set((s) => {
      if (!s.project || anchors.length === 0) return {}
      const syncAnchors = [...(s.project.syncAnchors ?? []), ...anchors]
      const affected = new Set(anchors.map((a) => a.vodId))
      const sources = s.project.sources.map((src) =>
        affected.has(src.id) ? withSyncMapping(src, src, syncAnchors) : src
      )
      const clips = refreshClipMappings(s.project.clips, sources, new Date().toISOString())
      return { project: { ...s.project, syncAnchors, sources, clips }, dirty: true }
    }),

  /**
   * Take a POV out of the project, with its clips and markers. Undoable, and
   * the caller confirms first when there is work attached — losing a POV
   * silently would lose every clip cut from it.
   */
  setWallAngles: (hiddenIds) =>
    set((s) => {
      if (!s.project) return {}
      const hidden = new Set(hiddenIds)
      const sources = s.project.sources.map((source) => {
        const next = hidden.has(source.id)
        if (next === (source.hiddenInWall === true)) return source
        // Written as absent rather than false: an angle nobody has ever
        // unticked should not carry a field saying so into the project file.
        const { hiddenInWall: _was, ...rest } = source
        return next ? { ...rest, hiddenInWall: true } : rest
      })
      if (sources.every((source, i) => source === s.project!.sources[i])) return {}
      return { project: { ...s.project, sources }, dirty: true }
    }),

  removeSource: (id) =>
    set((s) => {
      if (!s.project) return {}
      const sources = s.project.sources.filter((x) => x.id !== id)
      const clips = refreshClipMappings(
        s.project.clips.filter((c) => c.sourceId !== id),
        sources,
        new Date().toISOString()
      )
      const markers = s.project.markers.filter((m) => m.sourceId !== id)
      const entry: HistoryEntry = {
        clips: s.project.clips,
        markers: s.project.markers,
        sources: s.project.sources,
        timeline: s.project.timeline,
        event: s.project.event
      }
      const nextActive =
        s.activeSourceId === id ? (sources[0]?.id ?? null) : s.activeSourceId
      const active = sources.find((x) => x.id === nextActive) ?? null
      return {
        project: { ...s.project, sources, clips, markers },
        past: [...s.past, entry].slice(-MAX_HISTORY),
        future: [],
        dirty: true,
        activeSourceId: nextActive,
        selectedClipId: null,
        inPoint: null,
        outPoint: null,
        currentTime: 0,
        duration: active?.durationSeconds ?? 0,
        viewStart: 0,
        viewSpan: Math.max(60, active?.durationSeconds ?? 600)
      }
    }),

  /**
   * Empty this project without making a new one.
   *
   * The common case it exists for: the POVs currently loaded are the wrong
   * event, or were a first attempt, and the editor wants to start again — but
   * wants to keep the project file they already named and saved, along with
   * its output folder and export settings. Removing eight POVs one at a time
   * is eight confirmations and eight undo entries; "New project" is a second
   * file on disk and a second thing to find later.
   *
   * One history entry, so the whole clear is a single Ctrl+Z. Every field it
   * touches is in HistoryEntry — see the note there — so undo genuinely puts
   * it all back rather than half of it.
   *
   * Deliberately kept: the project's name, id, output folder and export
   * settings (the reason you are not making a new project), and
   * `syncAnchors` — those are keyed by VOD id, so they are inert while the
   * VOD is gone and give the timing straight back if the same one is loaded
   * again.
   */
  clearEvent: () =>
    set((s) => {
      if (!s.project) return {}
      const entry: HistoryEntry = {
        clips: s.project.clips,
        markers: s.project.markers,
        sources: s.project.sources,
        timeline: s.project.timeline,
        event: s.project.event
      }
      return {
        project: {
          ...s.project,
          sources: [],
          clips: [],
          markers: [],
          timeline: undefined,
          event: undefined
        },
        past: [...s.past, entry].slice(-MAX_HISTORY),
        future: [],
        dirty: true,
        // The transport and every selection referred to things that are gone.
        activeSourceId: null,
        selectedClipId: null,
        inPoint: null,
        outPoint: null,
        currentTime: 0,
        duration: 0,
        playing: false,
        sequenceIndex: null,
        viewStart: 0,
        viewSpan: 600,
        selectedTimelineItemIds: [],
        selectedTimelineItemId: null,
        // A run over clips that no longer exist would step through nothing.
        reviewRun: [],
        reviewIndex: 0
      }
    }),

  setActiveSource: (id) =>
    set((s) => {
      const source = s.project?.sources.find((x) => x.id === id) ?? null
      const from = s.project?.sources.find((x) => x.id === s.activeSourceId) ?? null
      // `playing` describes the element that is loaded. The incoming POV starts
      // paused and resumes itself if playback was running, so the transport can
      // never show Pause over a player that is not going anywhere.
      return {
        activeSourceId: id,
        duration: source?.durationSeconds ?? 0,
        currentTime: equivalentLocalTime(from, s.currentTime, source),
        // The selection survives: a clip belongs to the event, so switching
        // angle must not close the clip the editor is working on.
        inPoint: null,
        outPoint: null,
        viewStart: 0,
        viewSpan: Math.max(60, source?.durationSeconds ?? 600)
      }
    }),

  pushHistory: () =>
    set((s) => {
      if (!s.project) return {}
      const entry: HistoryEntry = {
        clips: s.project.clips,
        markers: s.project.markers,
        sources: s.project.sources,
        timeline: s.project.timeline,
        event: s.project.event
      }
      return { past: [...s.past, entry].slice(-MAX_HISTORY), future: [] }
    }),

  undo: () =>
    set((s) => {
      if (!s.project || s.past.length === 0) return {}
      const previous = s.past[s.past.length - 1]
      const current: HistoryEntry = {
        clips: s.project.clips,
        markers: s.project.markers,
        sources: s.project.sources,
        timeline: s.project.timeline,
        event: s.project.event
      }
      return {
        past: s.past.slice(0, -1),
        future: [current, ...s.future].slice(0, MAX_HISTORY),
        project: {
          ...s.project,
          clips: previous.clips,
          markers: previous.markers,
          sources: previous.sources,
          timeline: previous.timeline,
          event: previous.event
        },
        dirty: true,
        ...activeAfter(previous.sources, s.activeSourceId)
      }
    }),

  redo: () =>
    set((s) => {
      if (!s.project || s.future.length === 0) return {}
      const next = s.future[0]
      const current: HistoryEntry = {
        clips: s.project.clips,
        markers: s.project.markers,
        sources: s.project.sources,
        timeline: s.project.timeline,
        event: s.project.event
      }
      return {
        past: [...s.past, current].slice(-MAX_HISTORY),
        future: s.future.slice(1),
        project: {
          ...s.project,
          clips: next.clips,
          markers: next.markers,
          sources: next.sources,
          timeline: next.timeline,
          event: next.event
        },
        dirty: true,
        ...activeAfter(next.sources, s.activeSourceId)
      }
    }),

  createClip: (name) => {
    const s = get()
    const source = s.project?.sources.find((x) => x.id === s.activeSourceId)
    if (!s.project || !source) return null

    const rawStart = s.inPoint ?? s.currentTime
    const rawEnd = s.outPoint ?? Math.min(source.durationSeconds, rawStart + 30)
    const { startSeconds, endSeconds } = clampRange(
      Math.min(rawStart, rawEnd),
      Math.max(rawStart, rawEnd),
      source.durationSeconds
    )

    const index = clipsForSource(s.project.clips, source.id).length + 1
    const clipName = name?.trim() || `Clip ${String(index).padStart(2, '0')}`

    try {
      s.pushHistory()
      const clips = addClip(
        s.project.clips,
        {
          name: clipName,
          sourceId: source.id,
          startSeconds,
          endSeconds,
          // The clip's real identity is when it happened, not where it sits in
          // this VOD — that is what a POV added later inherits.
          ...eventRangeFor(source, startSeconds, endSeconds)
        },
        source.durationSeconds
      )
      // Atomic: the clip and every loaded POV's mapping are committed in one
      // update. There is no window in which the clip exists with a partial POV
      // set, and nothing has to be attached afterwards.
      const now = new Date().toISOString()
      const withMappings = clips.map((c) =>
        c.id === clips[clips.length - 1].id
          ? { ...c, povMappings: buildClipMappings(c, s.project!.sources, now) }
          : c
      )
      const created = withMappings[withMappings.length - 1]
      set({
        project: { ...s.project, clips: withMappings },
        selectedClipId: created.id,
        inPoint: null,
        outPoint: null,
        dirty: true
      })
      prefetchClipMedia(created, s.project.sources)
      return created.id
    } catch (err) {
      s.toast({
        kind: 'error',
        title: 'Selection not added',
        message: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  },

  requestCreateClip: () => {
    const s = get()
    const source = s.project?.sources.find((x) => x.id === s.activeSourceId)
    if (!s.project || !source) return
    set({ clipNamePromptOpen: true })
  },

  closeClipNamePrompt: () => set({ clipNamePromptOpen: false }),

  patchClip: (id, patch, opts) => {
    const s = get()
    if (!s.project) return
    const clip = s.project.clips.find((c) => c.id === id)
    if (!clip) return
    const source = s.project.sources.find((x) => x.id === clip.sourceId)
    try {
      /*
       * One history entry per edit, not one per mouse move.
       *
       * A drag on the timeline calls this on every pointer event, so a single
       * resize pushed a hundred entries — each a copy of every clip and marker
       * in the project — and left undo stepping back one pixel at a time. The
       * timeline pushes once when the drag starts and passes `history: false`
       * for the rest, so undo lands where the drag began, which is what it
       * looked like it did anyway.
       */
      if (
        opts?.history !== false &&
        (patch.startSeconds !== undefined || patch.endSeconds !== undefined || patch.name !== undefined)
      ) {
        s.pushHistory()
      }
      // Moving the range in VOD time moves it in event time too, or the clip
      // would stay where it was for every other POV.
      const retimed =
        patch.startSeconds !== undefined || patch.endSeconds !== undefined
          ? eventRangeFor(
              source,
              patch.startSeconds ?? clip.startSeconds,
              patch.endSeconds ?? clip.endSeconds
            )
          : {}
      const updated = updateClip(
        s.project.clips,
        id,
        { ...patch, ...retimed },
        source?.durationSeconds ?? Infinity
      )
      // Only the clip that moved: see refreshClipMapping. Rebuilding every
      // clip's projections here is what made dragging an edge feel heavy.
      const clips =
        patch.startSeconds !== undefined || patch.endSeconds !== undefined
          ? refreshClipMapping(updated, id, s.project.sources, new Date().toISOString())
          : updated
      set({ project: { ...s.project, clips }, dirty: true })
    } catch (err) {
      s.toast({
        kind: 'error',
        title: 'Invalid value',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  },

  patchClips: (ids, patch) =>
    set((s) => {
      if (!s.project) return {}
      const idSet = new Set(ids)
      return {
        project: {
          ...s.project,
          clips: s.project.clips.map((c) => (idSet.has(c.id) ? { ...c, ...patch } : c))
        },
        dirty: true
      }
    }),

  /**
   * Move a POV along the real-world clock by hand. Positive delta means this
   * POV's footage happened *later* than its metadata claims. The mapping
   * becomes `manual`, which the solver never overwrites, and every clip is
   * re-projected immediately.
   */
  nudgeSync: (sourceId, deltaSeconds, outcome) =>
    set((s) => {
      if (!s.project || deltaSeconds === 0) return {}
      const source = s.project.sources.find((x) => x.id === sourceId)
      if (!source) return {}
      const base = source.syncMapping
      const start =
        base?.vodStartRealTime ??
        (source.createdAt ? Date.parse(source.createdAt) / 1000 : null)
      if (start === null || !Number.isFinite(start)) return {}

      const mapping = {
        vodId: sourceId,
        vodStartRealTime: start,
        offsetSeconds: roundMs((base?.offsetSeconds ?? 0) + deltaSeconds),
        driftRate: base?.driftRate ?? 0,
        // The measured figure and the method the classifier decided — never a
        // flat 1. A hand-set offset that is not on a detected peak is an
        // estimate, and the exporter pads it accordingly.
        confidence: outcome.confidence,
        method: outcome.method,
        anchorIds: base?.anchorIds ?? [],
        lastValidatedAt: new Date().toISOString(),
        warnings: outcome.warnings
      }
      const sources = s.project.sources.map((x) =>
        x.id === sourceId ? { ...x, syncMapping: mapping } : x
      )
      return {
        project: {
          ...s.project,
          sources,
          clips: refreshClipMappings(s.project.clips, sources, new Date().toISOString())
        },
        dirty: true
      }
    }),

  /**
   * Correct one POV's alignment for ONE clip. The event range is untouched, so
   * this fixes a moment that will not line up without disturbing any other clip
   * — which a whole-VOD offset would.
   */
  setClipPovOffset: (clipId, sourceId, seconds) =>
    set((s) => {
      if (!s.project) return {}
      const entry: HistoryEntry = {
        clips: s.project.clips,
        markers: s.project.markers,
        sources: s.project.sources,
        timeline: s.project.timeline,
        event: s.project.event
      }
      const clips = s.project.clips.map((c) => {
        if (c.id !== clipId) return c
        const offsets = { ...(c.povOffsets ?? {}) }
        if (Math.abs(seconds) < 0.001) delete offsets[sourceId]
        else offsets[sourceId] = roundMs(seconds)
        return { ...c, povOffsets: offsets }
      })
      return {
        project: {
          ...s.project,
          clips: refreshClipMappings(clips, s.project.sources, new Date().toISOString())
        },
        past: [...s.past, entry].slice(-MAX_HISTORY),
        future: [],
        dirty: true
      }
    }),

  streamers: [],
  setStreamers: (streamers) => set({ streamers }),
  setLiveNow: (liveNow) => set({ liveNow }),
  setStreamerGroups: (streamerGroups) => set({ streamerGroups }),

  setSourceWatermark: (sourceId, watermark) =>
    set((s) => {
      if (!s.project) return {}
      return {
        project: {
          ...s.project,
          sources: s.project.sources.map((source) =>
            source.id === sourceId
              ? { ...source, watermark: watermark ?? undefined }
              : source
          )
        },
        dirty: true
      }
    }),

  /** Choose which POV supplies the picture or the sound for one clip. */
  setClipPov: (clipId, role, sourceId) => {
    const s = get()
    if (!s.project) return
    const key = role === 'video' ? 'videoSourceId' : 'audioSourceId'
    set({
      project: {
        ...s.project,
        clips: s.project.clips.map((c) => (c.id === clipId ? { ...c, [key]: sourceId } : c))
      },
      dirty: true
    })
  },

  // ---------------------------------------------------------------- event --
  // Every one of these edits organisation, never truth: a clip's real-world
  // time, its POV mappings and what it exports are untouched by filing it,
  // renaming a folder, or marking a POV used.

  ensureEvent: () => {
    const s = get()
    if (!s.project || s.project.event) return
    set({ project: { ...s.project, event: emptyEvent() }, dirty: true })
  },

  setEventInfo: (patch) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    const event = s.project.event ?? emptyEvent()
    set({ project: { ...s.project, event: { ...event, ...patch } }, dirty: true })
  },

  addClipCollection: (name) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    const { event } = addCollection(s.project.event ?? emptyEvent(), name)
    set({ project: { ...s.project, event }, dirty: true })
  },

  renameClipCollection: (id, name) => {
    const s = get()
    if (!s.project?.event) return
    s.pushHistory()
    set({
      project: { ...s.project, event: renameCollection(s.project.event, id, name) },
      dirty: true
    })
  },

  removeClipCollection: (id) => {
    const s = get()
    if (!s.project?.event) return
    s.pushHistory()
    // Clips survive the folder — see removeCollection.
    const next = removeCollection(s.project.event, s.project.clips, id)
    set({ project: { ...s.project, event: next.event, clips: next.clips }, dirty: true })
  },

  reorderClipCollection: (id, toIndex) => {
    const s = get()
    if (!s.project?.event) return
    s.pushHistory()
    set({
      project: { ...s.project, event: reorderCollection(s.project.event, id, toIndex) },
      dirty: true
    })
  },

  setClipCollectionId: (clipId, collectionId) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    set({
      project: { ...s.project, clips: setClipCollection(s.project.clips, clipId, collectionId) },
      dirty: true
    })
  },

  setClipWorkflowState: (clipId, workflow) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    set({
      project: { ...s.project, clips: setClipWorkflow(s.project.clips, clipId, workflow) },
      dirty: true
    })
  },

  setClipPovUsed: (clipId, sourceId, used) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    set({
      project: { ...s.project, clips: setPovUsed(s.project.clips, clipId, sourceId, used) },
      dirty: true
    })
  },

  addEventMoment: (init) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    const event = s.project.event ?? emptyEvent()
    const moment = { id: createId('moment'), ...init }
    set({
      project: { ...s.project, event: { ...event, moments: [...event.moments, moment] } },
      dirty: true
    })
  },

  removeEventMoment: (id) => {
    const s = get()
    if (!s.project?.event) return
    s.pushHistory()
    set({
      project: {
        ...s.project,
        event: { ...s.project.event, moments: s.project.event.moments.filter((m) => m.id !== id) }
      },
      dirty: true
    })
  },

  addAudioEdit: (clipId, edit) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    const newEdit: AudioEdit = { ...edit, id: createId('edit') }
    set({
      project: {
        ...s.project,
        clips: s.project.clips.map((c) =>
          c.id === clipId ? { ...c, audioEdits: [...(c.audioEdits ?? []), newEdit] } : c
        )
      },
      dirty: true
    })
  },

  patchAudioEdit: (clipId, editId, patch) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    set({
      project: {
        ...s.project,
        clips: s.project.clips.map((c) =>
          c.id === clipId
            ? { ...c, audioEdits: (c.audioEdits ?? []).map((e) => (e.id === editId ? { ...e, ...patch } : e)) }
            : c
        )
      },
      dirty: true
    })
  },

  removeAudioEdit: (clipId, editId) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    set({
      project: {
        ...s.project,
        clips: s.project.clips.map((c) =>
          c.id === clipId ? { ...c, audioEdits: (c.audioEdits ?? []).filter((e) => e.id !== editId) } : c
        )
      },
      dirty: true
    })
  },

  deleteClip: (id) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    set({
      project: { ...s.project, clips: removeClip(s.project.clips, id) },
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
      dirty: true
    })
  },

  copyClip: (id) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    const clips = duplicateClip(s.project.clips, id)
    set({ project: { ...s.project, clips }, dirty: true })
  },

  moveClip: (from, to) => {
    const s = get()
    if (!s.project || !s.activeSourceId) return
    const ordered = clipsForSource(s.project.clips, s.activeSourceId)
    const others = s.project.clips.filter((c) => c.sourceId !== s.activeSourceId)
    s.pushHistory()
    const moved = reorderClips(ordered, from, to)
    set({ project: { ...s.project, clips: [...others, ...moved] }, dirty: true })
  },

  selectClip: (id) => set({ selectedClipId: id }),

  ensureTimeline: () =>
    set((s) => {
      if (!s.project || s.project.timeline) return {}
      return { project: { ...s.project, timeline: emptyTimeline() }, dirty: true }
    }),

  addTimelineTrack: (kind) =>
    set((s) => {
      if (!s.project) return {}
      const timeline = addTimelineTrack(s.project.timeline ?? emptyTimeline(), kind)
      return { project: { ...s.project, timeline }, dirty: true }
    }),

  removeTimelineTrack: (trackId) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    set({
      project: { ...s.project, timeline: removeTimelineTrack(s.project.timeline, trackId) },
      dirty: true
    })
  },

  renameTimelineTrack: (trackId, name) =>
    set((s) => {
      if (!s.project?.timeline) return {}
      return {
        project: { ...s.project, timeline: renameTimelineTrack(s.project.timeline, trackId, name) },
        dirty: true
      }
    }),

  patchTimelineTrack: (trackId, patch) =>
    set((s) => {
      if (!s.project?.timeline) return {}
      return {
        project: { ...s.project, timeline: patchTimelineTrack(s.project.timeline, trackId, patch) },
        dirty: true
      }
    }),

  addClipToTimeline: (clipId, videoTrackId, audioTrackId) => {
    const s = get()
    if (!s.project) return
    const clip = s.project.clips.find((c) => c.id === clipId)
    if (!clip) return
    s.pushHistory()
    const timeline = appendClipToTimeline(s.project.timeline ?? emptyTimeline(), clip, {
      videoTrackId,
      audioTrackId
    })
    set({ project: { ...s.project, timeline }, dirty: true })
  },

  addTimelineItem: (item) => {
    const s = get()
    if (!s.project) return null
    s.pushHistory()
    const { timeline, id } = addTimelineItem(s.project.timeline ?? emptyTimeline(), item)
    set({ project: { ...s.project, timeline }, dirty: true })
    return id
  },

  moveTimelineItem: (itemId, trackId, timelineStartSeconds) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    set({
      project: {
        ...s.project,
        timeline: moveTimelineItem(s.project.timeline, itemId, trackId, timelineStartSeconds)
      },
      dirty: true
    })
  },

  trimTimelineItem: (itemId, side, newTimelineBoundarySeconds) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    set({
      project: {
        ...s.project,
        timeline: trimTimelineItem(s.project.timeline, itemId, side, newTimelineBoundarySeconds)
      },
      dirty: true
    })
  },

  splitTimelineItem: (itemId, atTimelineSeconds) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    set({
      project: {
        ...s.project,
        timeline: splitTimelineItem(s.project.timeline, itemId, atTimelineSeconds)
      },
      dirty: true
    })
  },

  deleteTimelineItem: (itemId, ripple = false) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    set({
      project: { ...s.project, timeline: deleteTimelineItem(s.project.timeline, itemId, ripple) },
      dirty: true
    })
  },

  duplicateTimelineItem: (itemId) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    const { timeline } = duplicateTimelineItem(s.project.timeline, itemId)
    set({ project: { ...s.project, timeline }, dirty: true })
  },

  patchTimelineItem: (itemId, patch) =>
    set((s) => {
      if (!s.project?.timeline) return {}
      return {
        project: { ...s.project, timeline: patchTimelineItem(s.project.timeline, itemId, patch) },
        dirty: true
      }
    }),

  unlinkTimelineItem: (itemId) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    set({
      project: { ...s.project, timeline: unlinkTimelineItem(s.project.timeline, itemId) },
      dirty: true
    })
  },

  addTimelineMarker: (timeSeconds, name) => {
    const s = get()
    if (!s.project?.timeline) return null
    s.pushHistory()
    const { timeline, id } = addTimelineMarker(s.project.timeline, {
      timeSeconds,
      name: name?.trim() || `Marker ${s.project.timeline.markers.length + 1}`
    })
    set({ project: { ...s.project, timeline }, dirty: true })
    return id
  },

  removeTimelineMarker: (markerId) => {
    const s = get()
    if (!s.project?.timeline) return
    s.pushHistory()
    set({
      project: { ...s.project, timeline: removeTimelineMarker(s.project.timeline, markerId) },
      dirty: true
    })
  },

  patchTimelineMarker: (markerId, patch) =>
    set((s) => {
      if (!s.project?.timeline) return {}
      return {
        project: { ...s.project, timeline: patchTimelineMarker(s.project.timeline, markerId, patch) },
        dirty: true
      }
    }),

  addMarker: (label, category) => {
    const s = get()
    if (!s.project || !s.activeSourceId) return
    s.pushHistory()
    const marker = makeMarker({
      sourceId: s.activeSourceId,
      timeSeconds: s.currentTime,
      label: label ?? `Marker ${s.project.markers.length + 1}`,
      category
    })
    set({ project: { ...s.project, markers: [...s.project.markers, marker] }, dirty: true })
  },

  addMarkerEverywhere: (label, category) => {
    const s = get()
    if (!s.project || !s.activeSourceId) return 0
    const result = markEverywhere({
      sources: s.project.sources,
      fromSourceId: s.activeSourceId,
      atSeconds: s.currentTime,
      label: label ?? `Marker ${s.project.markers.length + 1}`,
      ...(category ? { category } : {})
    })
    if (result.markers.length === 0) return 0
    s.pushHistory()
    set({
      project: { ...s.project, markers: [...s.project.markers, ...result.markers] },
      dirty: true
    })
    // The count is what the caller reports, and it counts angles actually
    // marked — an angle that was not rolling then is not a silent success.
    return result.markers.length
  },

  deleteMarker: (id) => {
    const s = get()
    if (!s.project) return
    s.pushHistory()
    set({
      project: { ...s.project, markers: s.project.markers.filter((m) => m.id !== id) },
      dirty: true
    })
  },

  markerToClip: (id) => {
    const s = get()
    if (!s.project) return
    const marker = s.project.markers.find((m) => m.id === id)
    const source = s.project.sources.find((x) => x.id === marker?.sourceId)
    if (!marker || !source) return
    const range = markerToRange(marker, source.durationSeconds)
    s.pushHistory()
    try {
      const clips = addClip(
        s.project.clips,
        { name: marker.label, sourceId: source.id, ...range },
        source.durationSeconds
      )
      const created = clips[clips.length - 1]
      set({
        project: { ...s.project, clips },
        selectedClipId: created.id,
        dirty: true
      })
      prefetchClipMedia(created, s.project.sources)
    } catch (err) {
      s.toast({
        kind: 'error',
        title: 'Could not create clip',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  },

  setInPoint: (seconds) =>
    set({ inPoint: seconds === null ? null : roundMs(Math.max(0, seconds)) }),
  setOutPoint: (seconds) =>
    set((s) => ({ outPoint: seconds === null ? null : roundMs(Math.min(s.duration, seconds)) })),

  setCurrentTime: (seconds) => set({ currentTime: roundMs(seconds) }),
  setPlaying: (playing) => set({ playing }),
  setDuration: (seconds) => set({ duration: seconds }),
  setVolume: (value) => set({ volume: Math.max(0, Math.min(1, value)) }),
  setMuted: (value) => set({ muted: value }),
  setRate: (value) => set({ rate: value }),
  setLoopSelection: (value) => set({ loopSelection: value }),
  setSequenceIndex: (index) => set({ sequenceIndex: index }),

  setTimelinePlayhead: (seconds) => set({ timelinePlayheadSeconds: Math.max(0, roundMs(seconds)) }),
  selectTimelineItem: (id, mode = 'replace') =>
    set((s) => {
      if (id === null) return { selectedTimelineItemIds: [], selectedTimelineItemId: null }
      const held = s.selectedTimelineItemIds
      const ids =
        mode === 'replace'
          ? [id]
          : mode === 'add'
            ? held.includes(id)
              ? held
              : [...held, id]
            : held.includes(id)
              ? held.filter((x) => x !== id)
              : [...held, id]
      // The Inspector follows the item you last touched, not the first one
      // that happens to be in the set — clicking a second clip should show
      // that clip's properties.
      return { selectedTimelineItemIds: ids, selectedTimelineItemId: ids.includes(id) ? id : (ids.at(-1) ?? null) }
    }),

  selectTimelineItems: (ids) =>
    set({ selectedTimelineItemIds: ids, selectedTimelineItemId: ids.at(-1) ?? null }),

  selectTimelineItemsInSpan: (startSeconds, endSeconds, trackIds, additive = false) => {
    const s = get()
    if (!s.project?.timeline) return
    const hit = timelineItemsInSpan(s.project.timeline, startSeconds, endSeconds, trackIds)
    const ids = additive ? [...new Set([...s.selectedTimelineItemIds, ...hit])] : hit
    set({ selectedTimelineItemIds: ids, selectedTimelineItemId: ids.at(-1) ?? null })
  },

  setTimelineRippleDelete: (value) => set({ timelineRippleDelete: value }),
  setTimelineSnap: (value) => set({ timelineSnap: value }),

  moveTimelineItems: (moves) => {
    const s = get()
    if (!s.project?.timeline || moves.length === 0) return
    s.pushHistory()
    set({
      project: { ...s.project, timeline: moveTimelineItems(s.project.timeline, moves) },
      dirty: true
    })
  },

  nudgeTimelineItems: (ids, deltaSeconds) => {
    const s = get()
    if (!s.project?.timeline || ids.length === 0) return
    const timeline = nudgeTimelineItems(
      s.project.timeline,
      withLinkedTimelineItems(s.project.timeline, ids),
      deltaSeconds
    )
    if (timeline === s.project.timeline) return
    s.pushHistory()
    set({ project: { ...s.project, timeline }, dirty: true })
  },

  deleteTimelineItems: (ids, ripple = false) => {
    const s = get()
    if (!s.project?.timeline || ids.length === 0) return
    s.pushHistory()
    const timeline = deleteTimelineItems(
      s.project.timeline,
      withLinkedTimelineItems(s.project.timeline, ids),
      ripple
    )
    set({
      project: { ...s.project, timeline },
      selectedTimelineItemIds: [],
      selectedTimelineItemId: null,
      dirty: true
    })
  },

  duplicateTimelineItems: (ids) => {
    const s = get()
    if (!s.project?.timeline || ids.length === 0) return
    s.pushHistory()
    let timeline = s.project.timeline
    const made: string[] = []
    for (const id of withLinkedTimelineItems(timeline, ids)) {
      const result = duplicateTimelineItem(timeline, id)
      timeline = result.timeline
      if (result.id !== id) made.push(result.id)
    }
    set({
      project: { ...s.project, timeline },
      selectedTimelineItemIds: made,
      selectedTimelineItemId: made.at(-1) ?? null,
      dirty: true
    })
  },

  splitTimelineAt: (atTimelineSeconds, ids) => {
    const s = get()
    if (!s.project?.timeline) return
    const scope = ids === undefined ? undefined : withLinkedTimelineItems(s.project.timeline, ids)
    const timeline = splitTimelineItemsAt(s.project.timeline, atTimelineSeconds, scope)
    if (timeline === s.project.timeline) return
    s.pushHistory()
    set({ project: { ...s.project, timeline }, dirty: true })
  },

  closeTimelineGap: (trackId, atTimelineSeconds) => {
    const s = get()
    if (!s.project?.timeline) return
    const timeline = closeTimelineGapAt(s.project.timeline, trackId, atTimelineSeconds)
    if (timeline === s.project.timeline) return
    s.pushHistory()
    set({ project: { ...s.project, timeline }, dirty: true })
  },

  reorderTimelineTrack: (trackId, direction) => {
    const s = get()
    if (!s.project?.timeline) return
    const timeline = reorderTimelineTrackAt(s.project.timeline, trackId, direction)
    if (timeline === s.project.timeline) return
    s.pushHistory()
    set({ project: { ...s.project, timeline }, dirty: true })
  },

  copyTimelineItems: (ids) => {
    const s = get()
    if (!s.project?.timeline) return
    const wanted = new Set(withLinkedTimelineItems(s.project.timeline, ids))
    set({ timelineClipboard: s.project.timeline.items.filter((i) => wanted.has(i.id)) })
  },

  pasteTimelineItems: (atTimelineSeconds) => {
    const s = get()
    const clipboard = s.timelineClipboard
    if (!s.project?.timeline || clipboard.length === 0) return
    // Everything is placed relative to the earliest copied item, so a group
    // pasted at the playhead keeps the spacing it was cut with.
    const anchor = Math.min(...clipboard.map((i) => i.timelineStartSeconds))
    const trackIds = new Set(s.project.timeline.tracks.map((t) => t.id))
    s.pushHistory()
    let timeline = s.project.timeline
    const made: string[] = []
    for (const item of clipboard) {
      // A track that has since been deleted falls back to the first of its own
      // kind rather than dropping the item on the floor.
      const trackId = trackIds.has(item.trackId)
        ? item.trackId
        : timeline.tracks.filter((t) => t.kind === item.kind).sort((a, b) => a.order - b.order)[0]?.id
      if (!trackId) continue
      const offset = item.timelineStartSeconds - anchor
      const start = Math.max(0, atTimelineSeconds + offset)
      const { timeline: next, id } = addTimelineItem(timeline, {
        ...item,
        trackId,
        linkedItemId: undefined,
        timelineStartSeconds: start,
        timelineEndSeconds: start + (item.timelineEndSeconds - item.timelineStartSeconds)
      })
      timeline = next
      made.push(id)
    }
    set({
      project: { ...s.project, timeline },
      selectedTimelineItemIds: made,
      selectedTimelineItemId: made.at(-1) ?? null,
      dirty: true
    })
  },

  setView: (start, span) =>
    set((s) => {
      const total = Math.max(1, s.duration)
      const clampedSpan = Math.max(1, Math.min(total, span))
      const clampedStart = Math.max(0, Math.min(total - clampedSpan, start))
      return { viewStart: clampedStart, viewSpan: clampedSpan }
    }),

  zoomBy: (factor, anchorSeconds) =>
    set((s) => {
      const total = Math.max(1, s.duration)
      const anchor = anchorSeconds ?? s.viewStart + s.viewSpan / 2
      const span = Math.max(1, Math.min(total, s.viewSpan * factor))
      const ratio = s.viewSpan === 0 ? 0.5 : (anchor - s.viewStart) / s.viewSpan
      const start = Math.max(0, Math.min(total - span, anchor - ratio * span))
      return { viewStart: start, viewSpan: span }
    }),

  setPage: (page) => set({ page }),
  setRoute: (route) => set({ route }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),

  setLive: (snapshot) =>
    set((s) => {
      const next: Partial<Store> = {
        live: snapshot.sources,
        liveWindowNotice: snapshot.windowNotice
      }
      /*
       * An archive that has just been published is the one piece of live
       * state worth keeping. Everything else here describes the buffer, which
       * is gone when the app closes — but which VOD a broadcast became is a
       * durable fact about the source, and it is what lets a clip marked live
       * be re-cut precisely from the recording afterwards. Learning it later
       * is not an option: nothing goes looking once the source stops being
       * watched.
       */
      if (!s.project) return next
      let changed = false
      const sources = s.project.sources.map((source) => {
        let updated = source

        /*
         * The platform's own recording of a broadcast still in progress, swapped
         * in as this POV's media.
         *
         * This is what makes a live POV clippable from the moment it went live
         * rather than only across the rolling buffer — it is an ordinary
         * growing playlist, so the player, the timeline and the exporter all
         * carry on unchanged and none of them has to learn about live. Only
         * the media moves across: the id, the title and above all the sync
         * mapping stay, because every clip already marked against this POV is
         * anchored to them.
         */
        const recording = snapshot.recordings?.[source.id]
        if (recording && recording.durationSeconds !== updated.durationSeconds) {
          changed = true
          updated = {
            ...updated,
            durationSeconds: recording.durationSeconds,
            playbackKind: recording.playbackKind,
            ...(recording.playbackUrl ? { playbackUrl: recording.playbackUrl } : {}),
            ...(recording.formats ? { formats: recording.formats } : {}),
            recordingVodId: recording.vodId
          }
        }

        const archived = snapshot.sources[source.id]?.archivedVodId
        if (archived && updated.archivedVodId !== archived) {
          changed = true
          updated = { ...updated, archivedVodId: archived }
        }
        return updated
      })
      if (!changed) return next
      return { ...next, project: { ...s.project, sources }, dirty: true }
    }),

  setRailCollapsedByWidth: (collapsed) =>
    set((s) => ({
      // A deliberate choice outranks the window: resizing must not undo it.
      railCollapsed: s.railCollapsedByUser ?? collapsed
    })),

  toggleRail: () =>
    set((s) => ({ railCollapsed: !s.railCollapsed, railCollapsedByUser: !s.railCollapsed })),

  setStreamerGroupFilter: (groupId) => set({ streamerGroupFilter: groupId }),
  setCollectionFilter: (collectionId) => set({ collectionFilter: collectionId }),

  startReviewRun: (clipIds) => set({ reviewRun: clipIds, reviewIndex: 0 }),
  // Clamped rather than wrapped: running off the end of a queue and landing
  // back at the start silently is how you review the same clip twice.
  advanceRun: (delta) =>
    set((s) => ({
      reviewIndex: Math.max(0, Math.min(s.reviewRun.length - 1, s.reviewIndex + delta))
    })),
  endRun: () => set({ reviewRun: [], reviewIndex: 0 }),

  setJobs: (jobs) => set({ jobs }),

  setToolProgress: (progress) =>
    set((s) => ({ toolProgress: { ...s.toolProgress, [progress.id]: progress } })),

  toast: (toast) =>
    set((s) => ({
      toasts: [...s.toasts, { ...toast, id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` }]
    })),

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setBusy: (label) => set({ busy: label })
}))

/**
 * Derived collections are computed with useMemo rather than inside the zustand
 * selector: a selector that builds a new array on every call would never
 * compare equal, which makes useSyncExternalStore re-render forever.
 */
/**
 * A clip as seen from one POV: the same clip, with its range expressed in that
 * POV's local time. `authored` marks the POV the range was defined in — the
 * only one where dragging the range means anything, because everywhere else the
 * numbers are a projection of the event time.
 */
export interface ProjectedClip extends ClipSegment {
  authored: boolean
}

/**
 * Every clip in the event that the active POV actually covers, in its time.
 * Clips are event objects, so this is no longer "the clips of this VOD".
 */
export function useActiveClips(): ProjectedClip[] {
  const clips = useStore((s) => s.project?.clips)
  const sources = useStore((s) => s.project?.sources)
  const sourceId = useStore((s) => s.activeSourceId)
  return useMemo(() => {
    if (!clips || !sources || !sourceId) return EMPTY_CLIPS
    const source = sources.find((x) => x.id === sourceId)
    if (!source) return EMPTY_CLIPS
    const out: ProjectedClip[] = []
    for (const clip of clips) {
      if (clip.sourceId === sourceId) {
        out.push({ ...clip, authored: true })
        continue
      }
      const range = clipRangeInPov(clip, source)
      if (range.coverage === 'none' || range.coverage === 'unknown') continue
      out.push({
        ...clip,
        startSeconds: range.localStart,
        endSeconds: range.localEnd,
        durationSeconds: roundMs(range.localEnd - range.localStart),
        authored: false
      })
    }
    return out.sort((a, b) => a.order - b.order)
  }, [clips, sources, sourceId])
}

export function useActiveSource(): VodSource | null {
  const sources = useStore((s) => s.project?.sources)
  const sourceId = useStore((s) => s.activeSourceId)
  return useMemo(
    () => sources?.find((x) => x.id === sourceId) ?? null,
    [sources, sourceId]
  )
}

export function useActiveMarkers(): Marker[] {
  const markers = useStore((s) => s.project?.markers)
  const sourceId = useStore((s) => s.activeSourceId)
  return useMemo(() => {
    if (!markers || !sourceId) return EMPTY_MARKERS
    return markers
      .filter((m) => m.sourceId === sourceId)
      .slice()
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
  }, [markers, sourceId])
}

const EMPTY_CLIPS: ProjectedClip[] = []
const EMPTY_MARKERS: Marker[] = []

/**
 * Keep the editor pointed at a POV that still exists after an undo or redo.
 */
function activeAfter(
  sources: VodSource[],
  activeSourceId: string | null
): { activeSourceId: string | null; duration: number } {
  const active =
    sources.find((x) => x.id === activeSourceId) ?? sources[0] ?? null
  return { activeSourceId: active?.id ?? null, duration: active?.durationSeconds ?? 0 }
}

/**
 * Solve a POV's place on the real-world clock from whatever the platform told
 * us plus every anchor the editor has set. Any manual correction survives,
 * because solveMapping treats a manual previous mapping as authoritative.
 */
function withSyncMapping(
  source: VodSource,
  previous: VodSource | undefined,
  anchors: SyncAnchor[]
): VodSource {
  const started = source.createdAt ? Date.parse(source.createdAt) : NaN
  return {
    ...source,
    syncMapping: solveMapping({
      vodId: source.id,
      durationSeconds: source.durationSeconds,
      evidence: Number.isFinite(started)
        ? { startRealTime: started / 1000, method: 'platform_metadata' }
        : { startRealTime: null, method: 'unsynced' },
      anchors: anchors.filter((a) => a.vodId === source.id),
      previous: source.syncMapping ?? previous?.syncMapping
    })
  }
}

/**
 * The same real-world instant, expressed in another POV's local time. Falls
 * back to the start of the new POV when either side is unsynced — guessing an
 * offset would put the editor somewhere that only looks right.
 */
function equivalentLocalTime(
  from: VodSource | null,
  fromLocalTime: number,
  to: VodSource | null
): number {
  if (!from || !to || from.id === to.id) return 0
  if (!isSynced(from.syncMapping) || !isSynced(to.syncMapping)) return 0
  const eventTime = localToEvent(from.syncMapping!, fromLocalTime)
  if (eventTime === null) return 0
  const local = eventToLocal(to.syncMapping!, eventTime)
  if (local === null) return 0
  return Math.max(0, Math.min(to.durationSeconds, local))
}

export function exportSettingsOf(state: Store): ProjectFile['exportSettings'] {
  return state.project?.exportSettings ?? DEFAULT_EXPORT_SETTINGS
}
