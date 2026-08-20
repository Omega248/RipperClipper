import { useMemo } from 'react'
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
  refreshClipMappings
} from '@shared/povMapping'
import type { SyncAnchor } from '@shared/sync'
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
  unlinkItem as unlinkTimelineItem
} from '@shared/timeline'
import type {
  AppSettings,
  ClipSegment,
  EditorTimeline,
  ExportJob,
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
import type { SavedStreamer } from '@shared/ipc'
import type { WatermarkConfig } from '@shared/watermark'
import type { EnvInfo, InstallProgress, ToastEvent } from '@shared/ipc'

/** The three workspaces inside a clip. The multi-track editor lives inside 'video', as a timeline mode. */
export type WorkspacePage = 'video' | 'editor' | 'properties' | 'export'

export interface Toast extends ToastEvent {
  id: string
}

interface HistoryEntry {
  clips: ClipSegment[]
  markers: Marker[]
  /** Sources too, so removing a POV is undoable like any other edit. */
  sources: VodSource[]
  /** The Editor's own sequence — absent before it's ever been created. */
  timeline: EditorTimeline | undefined
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

  // selection & editing
  activeSourceId: string | null
  selectedClipId: string | null
  inPoint: number | null
  outPoint: number | null

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
  selectedTimelineItemId: string | null
  timelineRippleDelete: boolean

  // navigation
  /** Which workspace is showing. One page, one job. */
  page: WorkspacePage

  // jobs & ui
  jobs: ExportJob[]
  toasts: Toast[]
  busy: string | null
  /** Latest progress line per tool while the installer is running. */
  toolProgress: Record<string, InstallProgress>
}

interface Actions {
  setEnv: (env: EnvInfo) => void
  setSettings: (settings: AppSettings) => void

  setProject: (project: ProjectFile, path: string | null) => void
  markClean: (project?: ProjectFile) => void
  addSource: (source: VodSource) => void
  setSourceFormats: (sourceId: string, formats: StreamInfo[]) => void
  setActiveSource: (id: string | null) => void
  removeSource: (id: string) => void

  pushHistory: () => void
  undo: () => void
  redo: () => void

  createClip: (name?: string) => string | null
  setClipPov: (clipId: string, role: 'video' | 'audio', sourceId: string | undefined) => void
  nudgeSync: (sourceId: string, deltaSeconds: number) => void
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
    patch: Partial<Pick<ClipSegment, 'name' | 'startSeconds' | 'endSeconds' | 'status'>>
  ) => void
  deleteClip: (id: string) => void
  copyClip: (id: string) => void
  moveClip: (from: number, to: number) => void
  selectClip: (id: string | null) => void

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
  selectTimelineItem: (id: string | null) => void
  setTimelineRippleDelete: (value: boolean) => void

  setView: (start: number, span: number) => void
  zoomBy: (factor: number, anchorSeconds?: number) => void

  setPage: (page: WorkspacePage) => void
  setJobs: (jobs: ExportJob[]) => void
  setToolProgress: (progress: InstallProgress) => void
  toast: (toast: ToastEvent) => void
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
  activeSourceId: null,
  selectedClipId: null,
  inPoint: null,
  outPoint: null,
  currentTime: 0,
  playing: false,
  duration: 0,
  volume: 1,
  muted: false,
  rate: 1,
  loopSelection: false,
  sequenceIndex: null,
  timelinePlayheadSeconds: 0,
  selectedTimelineItemId: null,
  timelineRippleDelete: false,
  viewStart: 0,
  viewSpan: 600,
  page: 'video',
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
   * Take a POV out of the project, with its clips and markers. Undoable, and
   * the caller confirms first when there is work attached — losing a POV
   * silently would lose every clip cut from it.
   */
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
        timeline: s.project.timeline
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
        timeline: s.project.timeline
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
        timeline: s.project.timeline
      }
      return {
        past: s.past.slice(0, -1),
        future: [current, ...s.future].slice(0, MAX_HISTORY),
        project: {
          ...s.project,
          clips: previous.clips,
          markers: previous.markers,
          sources: previous.sources,
          timeline: previous.timeline
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
        timeline: s.project.timeline
      }
      return {
        past: [...s.past, current].slice(-MAX_HISTORY),
        future: s.future.slice(1),
        project: { ...s.project, clips: next.clips, markers: next.markers, sources: next.sources, timeline: next.timeline },
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

  patchClip: (id, patch) => {
    const s = get()
    if (!s.project) return
    const clip = s.project.clips.find((c) => c.id === id)
    if (!clip) return
    const source = s.project.sources.find((x) => x.id === clip.sourceId)
    try {
      if (patch.startSeconds !== undefined || patch.endSeconds !== undefined || patch.name !== undefined) {
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
      const clips =
        patch.startSeconds !== undefined || patch.endSeconds !== undefined
          ? refreshClipMappings(updated, s.project.sources, new Date().toISOString())
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

  /**
   * Move a POV along the real-world clock by hand. Positive delta means this
   * POV's footage happened *later* than its metadata claims. The mapping
   * becomes `manual`, which the solver never overwrites, and every clip is
   * re-projected immediately.
   */
  nudgeSync: (sourceId, deltaSeconds) =>
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
        confidence: 1,
        method: 'manual' as const,
        anchorIds: base?.anchorIds ?? [],
        lastValidatedAt: new Date().toISOString(),
        warnings: []
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
        timeline: s.project.timeline
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
  selectTimelineItem: (id) => set({ selectedTimelineItemId: id }),
  setTimelineRippleDelete: (value) => set({ timelineRippleDelete: value }),

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
