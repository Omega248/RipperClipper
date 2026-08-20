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
  projectStartupPath: 'project:startup-path',

  // streamers
  streamersList: 'streamers:list',
  streamersAdd: 'streamers:add',
  streamersRemove: 'streamers:remove',
  streamersVods: 'streamers:vods',
  streamersWatermark: 'streamers:watermark',
  streamersOverlap: 'streamers:overlap',

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
  exportClearFinished: 'export:clear-finished',
  exportList: 'export:list',

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

  // events (main -> renderer)
  evtJobs: 'evt:jobs',
  evtLog: 'evt:log',
  evtToast: 'evt:toast',
  evtDeps: 'evt:deps',
  evtOpenProject: 'evt:open-project',
  evtWindowMaximized: 'evt:window-maximized'
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
  listJobs(): Promise<ExportJob[]>

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

  onJobs(cb: (jobs: ExportJob[]) => void): () => void
  onToast(cb: (toast: ToastEvent) => void): () => void
  onOpenProject(cb: (path: string) => void): () => void
  /** Fires on maximize/unmaximize/snap, so the restore-vs-maximize icon stays honest. */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
}
