import type { ResolvedWatermark, WatermarkConfig, WatermarkImage } from './watermark.js'
import type { AudioEdit } from './audioEdits.js'
import type {
  AppSettings,
  DiskSpaceInfo,
  ExportJob,
  ExportSettings,
  FfmpegInfo,
  ProjectFile,
  ResolverInfo,
  PlatformId,
  StreamInfo,
  TimelineTransform,
  VodSource
} from './types.js'

export interface PeaksQuery {
  source: VodSource
  startSeconds: number
  endSeconds: number
  buckets: number
}

/** A range the player could not decode, made playable. */
export interface PreviewMediaRequest {
  source: VodSource
  startSeconds: number
  endSeconds: number
}

export interface PreviewMediaReply {
  /** Same-origin URL the player can load. */
  url: string
  plan: 'native' | 'remux' | 'transcode' | 'unsupported'
  reason: string
  startSeconds: number
  endSeconds: number
  cached: boolean
}

export interface PeaksReply {
  startSeconds: number
  endSeconds: number
  peaks: number[]
  rms: number[]
}

export interface FilmstripQuery {
  source: VodSource
  startSeconds: number
  endSeconds: number
  frameCount: number
  width: number
}

export interface FilmstripReply {
  startSeconds: number
  endSeconds: number
  /** data: URIs, evenly spaced across the range, earliest first. */
  frames: string[]
}

/** External programs Ripper Clipper can install for itself. */
export type ToolId = 'ffmpeg' | 'ytdlp'

export interface ToolStatus {
  id: ToolId
  label: string
  /** What the app cannot do without it. */
  purpose: string
  required: boolean
  installed: boolean
  /** Where the copy in use is, whether it shipped with the app or was fetched. */
  managedPath: string | null
  /** True when it came with the app rather than being downloaded. */
  bundled: boolean
  /** Rough download size. */
  approxBytes: number
  /** Set when this platform has no published build to install. */
  unsupported: string | null
}

export interface InstallProgress {
  id: ToolId
  label: string
  stage: 'checking' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'done' | 'failed'
  /** 0..1 within the current stage; downloads report real bytes. */
  fraction: number
  receivedBytes: number
  totalBytes: number | null
  message: string
}

/**
 * State of the GitHub-releases update feed. `unsupported` covers both the
 * experimental/dev channels (never published, nothing to check) and any
 * environment where a check simply cannot be meaningful.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  /** releaseNotes is the GitHub release body, when the feed provided one. */
  | { state: 'available'; version: string; releaseNotes?: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string; releaseNotes?: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported' }

/** A channel the editor keeps around between sessions. */
export interface SavedStreamer {
  id: string
  platform: PlatformId
  /** Channel name as the platform spells it, without a leading @. */
  handle: string
  displayName: string
  /** Where that platform lists the channel's past broadcasts. */
  channelUrl: string
  addedAt: string
  lastUsedAt: string | null
  /**
   * This streamer's usual watermark. Every VOD of theirs inherits it unless
   * that VOD has its own override, so a logo is positioned once rather than
   * once per broadcast.
   */
  watermark?: WatermarkConfig
  /** Which StreamerGroups this streamer's current character belongs to — PD, a gang, EMS, … */
  groupIds?: string[]
  /**
   * Shared by every saved entry that is the same real person restreaming to
   * more than one platform, so a moment covered by two of them can be
   * resolved to whichever copy is actually the better watch instead of
   * showing the same broadcast twice.
   */
  personId?: string
  /** Kept at the top of the streamer list regardless of last-used date. */
  favorite?: boolean
}

/**
 * A named set of streamers — "PD", "Ballas", "EMS" — for finding everyone on
 * one side of an event without remembering who that currently is. A streamer
 * can belong to more than one, since a character's affiliation is not always
 * exclusive and definitely not permanent.
 */
export interface StreamerGroup {
  id: string
  name: string
  /** A short glyph shown before the name — usually one emoji, never required. */
  icon?: string
  /** One of STREAMER_GROUP_COLORS (shared/streamerGroupColors.ts). */
  color?: string
}

/** What the renderer asks for when it wants to know who else was live. */
export interface EventOverlapRequest {
  eventStartSeconds: number
  eventEndSeconds: number
  /** VOD URLs already loaded, so they can be marked rather than offered again. */
  loadedUrls: string[]
}

export interface EventOverlapReply {
  streams: Array<{
    streamerId: string
    streamerName: string
    platform: PlatformId
    vod: StreamerVod
    availability: 'loaded' | 'available'
    coverage: {
      fraction: number
      complete: boolean
      offsetSeconds: number
      certain: boolean
    }
  }>
  /** Channels that could not be reached, so a partial answer is not silent. */
  unreachable: string[]
}

/** One past broadcast in the streamer picker. */
export interface StreamerVod {
  url: string
  title: string
  durationSeconds: number | null
  publishedAt: string | null
  thumbnailUrl?: string
  viewCount?: number
}

/** Channels exposed to the renderer. Nothing else crosses the bridge. */
export const IPC = {
  // environment
  envInfo: 'env:info',
  envRefresh: 'env:refresh',

  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsPickOutputDir: 'settings:pick-output-dir',
  settingsPickFile: 'settings:pick-file',

  // sources
  sourceResolve: 'source:resolve',
  sourceInspectFormats: 'source:inspect-formats',

  // projects
  projectNew: 'project:new',
  projectSave: 'project:save',
  projectSaveAs: 'project:save-as',
  projectOpen: 'project:open',
  projectOpenPath: 'project:open-path',
  projectAutosave: 'project:autosave',
  projectRecoveryCheck: 'project:recovery-check',
  projectRecoveryDiscard: 'project:recovery-discard',
  projectRecent: 'project:recent',
  projectBackupList: 'project:backup-list',
  projectBackupRestore: 'project:backup-restore',
  projectStartupPath: 'project:startup-path',

  // streamers
  streamersList: 'streamers:list',
  streamersAdd: 'streamers:add',
  streamersRemove: 'streamers:remove',
  streamersVods: 'streamers:vods',
  streamersWatermark: 'streamers:watermark',
  streamersOverlap: 'streamers:overlap',
  streamersSetGroups: 'streamers:set-groups',
  streamersSetFavorite: 'streamers:set-favorite',
  streamersRestore: 'streamers:restore',
  streamersLinkPerson: 'streamers:link-person',
  streamersUnlinkPerson: 'streamers:unlink-person',
  streamersVodQuality: 'streamers:vod-quality',

  // streamer groups
  streamerGroupsList: 'streamer-groups:list',
  streamerGroupsCreate: 'streamer-groups:create',
  streamerGroupsUpdate: 'streamer-groups:update',
  streamerGroupsDelete: 'streamer-groups:delete',

  // waveform
  audioPeaks: 'audio:peaks',
  filmstrip: 'media:filmstrip',

  // dependency installer
  depsStatus: 'deps:status',
  depsInstall: 'deps:install',
  depsCancel: 'deps:cancel',

  // watermarks
  watermarkImport: 'watermark:import',
  watermarkList: 'watermark:list',
  watermarkRemove: 'watermark:remove',

  // playable preview media
  previewMedia: 'preview:media',

  // exports
  exportEnqueue: 'export:enqueue',
  exportCombine: 'export:combine',
  exportTimeline: 'export:timeline',
  exportCancel: 'export:cancel',
  exportPause: 'export:pause',
  exportResume: 'export:resume',
  exportRetry: 'export:retry',
  exportRetryAllFailed: 'export:retry-all-failed',
  exportReorder: 'export:reorder',
  exportClearFinished: 'export:clear-finished',
  exportList: 'export:list',
  exportClipListCsv: 'export:clip-list-csv',

  // cache / disk
  cacheStats: 'cache:stats',
  cacheClear: 'cache:clear',
  diskSpace: 'disk:space',

  // shell
  revealPath: 'shell:reveal',
  openPath: 'shell:open',

  // logs
  logsPath: 'logs:path',
  logsTail: 'logs:tail',

  // window chrome — the titlebar is drawn by the app, not the OS
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  /** Renderer says it's fine to actually close now — no unsaved work, or the user chose to discard it. */
  windowConfirmClose: 'window:confirm-close',

  // updates — only ever meaningful on the stable channel, see updater.ts
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  // events (main -> renderer)
  evtJobs: 'evt:jobs',
  evtLog: 'evt:log',
  evtToast: 'evt:toast',
  evtDeps: 'evt:deps',
  evtOpenProject: 'evt:open-project',
  evtWindowMaximized: 'evt:window-maximized',
  evtUpdate: 'evt:update',
  /** Fired instead of actually closing, so the renderer gets to check for unsaved work first. */
  evtBeforeClose: 'evt:before-close'
} as const

export interface EnvInfo {
  ffmpeg: FfmpegInfo
  resolver: ResolverInfo
  platform: NodeJS.Platform
  appVersion: string
  defaultOutputDirectory: string
  /** Base URL of the local same-origin media proxy used by the preview player. */
  mediaProxyBase: string
}

export interface EnqueueRequest {
  /** The POV the picture comes from; every clip in the request shares it. */
  source: VodSource
  /** Event/project name, used by the folder template. */
  projectName?: string
  clips: Array<{
    id: string
    name: string
    startSeconds: number
    endSeconds: number
    /** Sound from a different POV, already mapped into that POV's own time. */
    audio?: {
      source: VodSource
      startSeconds: number
      endSeconds: number
    }
    /** Hand-drawn mute/bleep/duck ranges, in the clip's own timeline. */
    audioEdits?: AudioEdit[]
  }>
  settings: ExportSettings
  outputDirectory: string
  /**
   * The watermark for the POV supplying the picture, already resolved against
   * the streamer default. Absent means none, which is what keeps a stream copy
   * on the table.
   */
  watermark?: ResolvedWatermark
  /** Bleep tone, so what was previewed is what gets written. */
  bleep?: { hz: number; amplitude: number }
}

export interface CombineRequest extends EnqueueRequest {
  outputName: string
}

/**
 * One rendered cut of a Timeline export — see shared/timeline.ts's
 * `computeExportSegments`, which is what produces these on the renderer
 * side. Each segment carries its own POVs because, unlike a plain "combine
 * these clips" job, consecutive segments routinely come from different ones.
 */
export interface TimelineExportSegment {
  durationSeconds: number
  videoSource: VodSource
  videoStartSeconds: number
  videoEndSeconds: number
  audioSource: VodSource | null
  audioStartSeconds: number | null
  audioEndSeconds: number | null
  audioEdits: AudioEdit[]
  /** This segment's video POV, already resolved (streamer default → VOD override). */
  watermark?: ResolvedWatermark
  transform?: TimelineTransform
  opacity?: number
  audioGain?: number
}

export interface TimelineExportRequest {
  segments: TimelineExportSegment[]
  projectName?: string
  settings: ExportSettings
  outputDirectory: string
  outputName: string
  bleep?: { hz: number; amplitude: number }
}

export interface ToastEvent {
  kind: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
}

export interface RecoveryInfo {
  available: boolean
  path: string | null
  savedAt: string | null
  projectName: string | null
}

/** One entry in a project's rolling backup history — newest first. */
export interface ProjectBackupInfo {
  path: string
  savedAt: string
}

export interface CacheStats {
  directory: string
  sizeBytes: number
  maxSizeBytes: number
  entries: number
}

/** Shape of `window.api` in the renderer. */
export interface RendererApi {
  env(): Promise<EnvInfo>
  refreshEnv(): Promise<EnvInfo>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  pickOutputDirectory(): Promise<string | null>
  pickFile(kind: 'ffmpeg' | 'ffprobe' | 'ytdlp'): Promise<string | null>

  resolveSource(url: string): Promise<VodSource>
  inspectFormats(source: VodSource): Promise<StreamInfo[]>

  newProject(name: string): Promise<ProjectFile>
  saveProject(project: ProjectFile, path?: string): Promise<{ path: string; project: ProjectFile }>
  saveProjectAs(project: ProjectFile): Promise<{ path: string; project: ProjectFile } | null>
  openProject(): Promise<{ path: string; project: ProjectFile } | null>
  openProjectPath(path: string): Promise<{ path: string; project: ProjectFile }>
  autosave(project: ProjectFile): Promise<void>
  checkRecovery(): Promise<RecoveryInfo>
  discardRecovery(): Promise<void>
  recentProjects(): Promise<string[]>
  /** Rolling save-history for a project file, newest first. */
  listBackups(path: string): Promise<ProjectBackupInfo[]>
  /** Load a backup snapshot as the current project, without touching the file it was saved from. */
  restoreBackup(path: string): Promise<ProjectFile>

  /** Peaks for a window of one POV's audio, for the manual-sync waveform. */
  audioPeaks(req: PeaksQuery): Promise<PeaksReply>
  /** Evenly spaced frames across a window of one POV's video, for the Editor's filmstrip. */
  filmstrip(req: FilmstripQuery): Promise<FilmstripReply>

  /** Copy an image into the app's watermark library. */
  importWatermarkImage(): Promise<WatermarkImage | null>
  listWatermarkImages(): Promise<WatermarkImage[]>
  removeWatermarkImage(id: string): Promise<WatermarkImage[]>

  /** What Ripper Clipper needs, and whether it is here yet. */
  toolStatus(): Promise<ToolStatus[]>
  /** Download and install the named tools. Resolves with the refreshed environment. */
  installTools(ids: ToolId[]): Promise<EnvInfo>
  cancelToolInstall(): Promise<void>
  onToolProgress(cb: (progress: InstallProgress) => void): () => void

  /** Make a range playable when the source itself cannot be decoded. */
  previewMedia(req: PreviewMediaRequest): Promise<PreviewMediaReply>

  listStreamers(): Promise<SavedStreamer[]>
  /** Store (or clear) a streamer's default watermark. */
  setStreamerWatermark(id: string, watermark: WatermarkConfig | null): Promise<SavedStreamer[]>
  /** Saved streamers whose broadcasts overlap an event's real-world range. */
  streamersCoveringEvent(req: EventOverlapRequest): Promise<EventOverlapReply>
  addStreamer(input: string, platform?: PlatformId): Promise<SavedStreamer[]>
  removeStreamer(id: string): Promise<SavedStreamer[]>
  streamerVods(id: string): Promise<StreamerVod[]>
  /** Replaces a streamer's whole group membership list. */
  setStreamerGroups(id: string, groupIds: string[]): Promise<SavedStreamer[]>
  /** Pins/unpins a streamer to the top of the list. */
  setStreamerFavorite(id: string, favorite: boolean): Promise<SavedStreamer[]>
  /** Undoes a removal — re-inserts the exact streamer object removed, not a fresh add. */
  restoreStreamer(streamer: SavedStreamer): Promise<SavedStreamer[]>
  /** Marks two saved streamers as the same real person restreaming elsewhere. */
  linkStreamerPerson(idA: string, idB: string): Promise<SavedStreamer[]>
  /** Undoes linkStreamerPerson for one streamer. */
  unlinkStreamerPerson(id: string): Promise<SavedStreamer[]>
  /** Best resolution available for each VOD URL, null where it could not be determined. */
  streamerVodQuality(urls: string[]): Promise<Record<string, number | null>>

  listStreamerGroups(): Promise<StreamerGroup[]>
  createStreamerGroup(name: string, icon?: string, color?: string): Promise<StreamerGroup[]>
  updateStreamerGroup(
    id: string,
    patch: Partial<Pick<StreamerGroup, 'name' | 'icon' | 'color'>>
  ): Promise<StreamerGroup[]>
  /** Also clears the group from every streamer's membership list. */
  deleteStreamerGroup(id: string): Promise<StreamerGroup[]>
  /** Project passed on the command line, e.g. by double-clicking a .cookieclip. */
  startupProjectPath(): Promise<string | null>

  enqueueExports(req: EnqueueRequest): Promise<ExportJob[]>
  enqueueCombined(req: CombineRequest): Promise<ExportJob>
  /** Renders the Editor's multi-track timeline into one file. */
  exportTimeline(req: TimelineExportRequest): Promise<ExportJob>
  cancelJob(jobId: string): Promise<void>
  pauseQueue(): Promise<void>
  resumeQueue(): Promise<void>
  retryJob(jobId: string): Promise<void>
  retryAllFailed(): Promise<void>
  clearFinished(): Promise<void>
  /** Moves a queued job to a new position — also changes run priority for not-yet-started jobs. */
  reorderJob(jobId: string, toIndex: number): Promise<void>
  listJobs(): Promise<ExportJob[]>
  /** Prompts for a save location and writes the CSV; null if the user cancelled. */
  exportClipListCsv(csv: string, suggestedName: string): Promise<string | null>

  cacheStats(): Promise<CacheStats>
  clearCache(): Promise<CacheStats>
  diskSpace(path: string): Promise<DiskSpaceInfo>

  revealPath(path: string): Promise<void>
  openPath(path: string): Promise<void>

  logsPath(): Promise<string>
  tailLogs(lines: number): Promise<string>

  /** The window chrome is drawn by the app; these reach the real OS window. */
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  isWindowMaximized(): Promise<boolean>
  /** Tells main it's fine to actually close now, after the renderer checked for unsaved work. */
  confirmClose(): Promise<void>

  /** Kicks off a check against the GitHub-releases feed; result also arrives via onUpdateStatus. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Only valid once a check reports `available`. */
  downloadUpdate(): Promise<void>
  /** Only valid once a download reports `downloaded`. Quits and installs immediately. */
  installUpdate(): Promise<void>

  onJobs(cb: (jobs: ExportJob[]) => void): () => void
  onToast(cb: (toast: ToastEvent) => void): () => void
  onOpenProject(cb: (path: string) => void): () => void
  /** Fires on maximize/unmaximize/snap, so the restore-vs-maximize icon stays honest. */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
  /** The window is about to close — a chance to confirm losing unsaved work before it actually does. */
  onBeforeClose(cb: () => void): () => void
}
