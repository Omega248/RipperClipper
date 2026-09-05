import type { ResolvedWatermark, WatermarkConfig, WatermarkImage } from './watermark.js'
import type { EditingProject } from './editingProject.js'
import type { EditorCapabilities, EditorId } from './editorCapabilities.js'
import type { AudioEdit } from './audioEdits.js'
import type { DiscoveredStream } from './discovery.js'
import type {
  AppSettings,
  DiskSpaceInfo,
  ExportJob,
  ExportSettings,
  FfmpegInfo,
  LiveState,
  ProjectFile,
  ResolverInfo,
  PlatformId,
  StreamInfo,
  TimelineTransform,
  VodSource
} from './types.js'

/**
 * Every live source's state, plus the one cross-source fact none of them owns.
 *
 * `windowNotice` is set when the live memory budget forced a smaller window
 * than the user asked for. It travels with the states because the UI has to
 * say so — a buffer strip that silently holds ninety seconds when five minutes
 * was chosen is lying about what can be clipped.
 */
export interface LiveSnapshot {
  sources: Record<string, LiveState>
  windowNotice: string | null
  /**
   * The platform's own recording of each broadcast still in progress, resolved
   * as an ordinary VOD.
   *
   * This is what makes a live POV clippable from the moment it went live
   * rather than only across the rolling buffer: it is a growing playlist the
   * existing VOD path can already seek and export, so the source swaps its
   * media over to it and everything downstream carries on unchanged. Keyed by
   * live source id; absent while no recording has been found.
   */
  recordings?: Record<string, VodSource>
}

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
  /** A lighter proxy at this picture height instead of the source's own — for rapid scrubbing. */
  height?: number
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

export interface SceneChangesQuery {
  source: VodSource
  startSeconds: number
  endSeconds: number
  /** 0..1 — how different a frame must look from the last to count as a cut. Default 0.35. */
  threshold?: number
}

export interface SceneChangesReply {
  startSeconds: number
  endSeconds: number
  /** Source-local seconds, sorted, where the picture changed enough to look like a cut. */
  times: number[]
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
   * When the other platforms were last searched for this same person.
   *
   * Set so the search happens once per streamer rather than on every launch:
   * it costs a profile lookup per platform, and a handle that does not exist
   * on Twitch today is not going to exist on Twitch tomorrow either.
   */
  siblingsCheckedAt?: string
  /**
   * Shared by every saved entry that is the same real person restreaming to
   * more than one platform, so a moment covered by two of them can be
   * resolved to whichever copy is actually the better watch instead of
   * showing the same broadcast twice.
   */
  personId?: string
  /** Kept at the top of the streamer list regardless of last-used date. */
  favorite?: boolean
  /**
   * The channel's own picture, straight from the platform's CDN.
   *
   * Stored as a URL rather than copied: these are small, public, built to be
   * hotlinked, and a stale one costs nothing worse than a broken image — far
   * cheaper than keeping a mirror of every avatar in sync.
   */
  avatarUrl?: string
  /** Follower count when the platform reported one. Indicative, not live. */
  followers?: number
  /** When the profile above was last fetched, so it can be refreshed on age. */
  profileFetchedAt?: string
  /**
   * Events this channel has supplied a POV for (§13). Recorded when a POV of
   * theirs is loaded, so the library answers "who have I actually worked
   * with, and on what" rather than just listing channels. Capped and
   * newest-first — a recency aid, not an archive; the projects themselves
   * remain the record of what happened.
   */
  participation?: StreamerParticipation[]
}

/** One event a saved streamer supplied a POV for. */
export interface StreamerParticipation {
  projectId: string
  projectName: string
  /** The event's own name, when the project declared one. */
  eventName?: string
  /** ISO 8601 — when the POV was loaded, not when the event happened. */
  at: string
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

/**
 * A cross-platform sweep for the POVs of one real-world event (§1).
 *
 * The window is real-world epoch seconds, the same clock every POV is synced
 * onto — never a VOD timestamp, since two streams reading "01:12:30" were not
 * in the same place at the same time.
 */
export interface EventDiscoveryRequest {
  startSeconds: number
  endSeconds: number
  /** Optional event name, e.g. "bank robbery" — drives relevance scoring. */
  name?: string
  /** Restrict to one platform. Absent sweeps all of them. */
  platform?: PlatformId
  /** VOD URLs already loaded, so they are marked rather than offered again. */
  loadedUrls: string[]
  /** Include a keyword sweep of the platforms that genuinely support one. */
  includeSearch: boolean
}

export interface EventDiscoveryReply {
  streams: DiscoveredStream[]
  /** Channels that could not be reached, so a partial answer is never silent. */
  unreachable: string[]
  /** Plain-language notes on what was and was not swept, shown to the editor. */
  notes: string[]
}

/** One past broadcast in the streamer picker. */
/** Everything known about one streamer's back catalogue. */
export interface StreamerVodShelf {
  streamerId: string
  platform: PlatformId
  handle: string
  /** Newest first. An empty `publishedAt` means "asked, and the platform would not say". */
  vods: StreamerVod[]
  listedAt: string | null
  /** When the listing was last attempted, successful or not. */
  attemptedAt?: string | null
  datedAt: string | null
  error?: string
}

/** How far along the background crawl is, for the interface to show. */
export interface VodCrawlProgress {
  /** Whose broadcasts are being read right now, by display name. */
  active: string | null
  /** Broadcasts still needing a date, across every streamer. */
  pending: number
  /** True while the crawl is standing aside for an export. */
  waiting: boolean
}

/** The best streams one platform offers for a channel's newest broadcast. */
export interface PlatformQuality {
  platform: PlatformId
  handle: string
  channelUrl: string
  /** Whether a channel with this handle exists there at all. */
  found: boolean
  displayName?: string
  vod?: { url: string; title: string; publishedAt: string | null }
  video?: {
    label: string
    width?: number
    height?: number
    fps?: number
    /** bits per second */
    bitrate?: number
    codec?: string
  }
  audio?: { bitrate?: number; channels?: number; sampleRate?: number; codec?: string }
  /** Why this platform could not be read, when it could not. */
  error?: string
}

/** The same handle across every platform, and which one to cut from. */
export interface PlatformComparison {
  handle: string
  options: PlatformQuality[]
  bestPlatform: PlatformId | null
}

/** A channel that is broadcasting right now. Absent from the map = offline. */
export interface LiveNow {
  viewers?: number
  title?: string
}

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
  sourceLiveStatus: 'source:live-status',

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

  // editing-project export
  editorsList: 'editors:list',
  editingProjectValidate: 'editing-project:validate',
  editingProjectExport: 'editing-project:export',
  editingProjectChooseFolder: 'editing-project:choose-folder',

  // streamers
  streamersList: 'streamers:list',
  streamersAdd: 'streamers:add',
  streamersRemove: 'streamers:remove',
  streamersVods: 'streamers:vods',
  streamersShelf: 'streamers:shelf',
  streamersLive: 'streamers:live',
  streamersLiveCached: 'streamers:live-cached',
  streamersCompare: 'streamers:compare',
  streamersDiscoverSiblings: 'streamers:discover-siblings',
  streamersCrawlProgress: 'streamers:crawl-progress',
  streamersCrawlNow: 'streamers:crawl-now',
  streamersWatermark: 'streamers:watermark',
  streamersOverlap: 'streamers:overlap',
  discoverEvent: 'discovery:event',
  resolveMoment: 'scene:resolve-moment',
  archiveRange: 'scene:archive-range',
  packageExport: 'package:export',
  packageImport: 'package:import',
  streamersSetGroups: 'streamers:set-groups',
  streamersSetFavorite: 'streamers:set-favorite',
  streamersRestore: 'streamers:restore',
  streamersLinkPerson: 'streamers:link-person',
  streamersUnlinkPerson: 'streamers:unlink-person',
  streamersVodQuality: 'streamers:vod-quality',
  streamersRefreshProfile: 'streamers:refresh-profile',
  streamersRefreshProfiles: 'streamers:refresh-profiles',

  // streamer groups
  streamerGroupsList: 'streamer-groups:list',
  streamerGroupsCreate: 'streamer-groups:create',
  streamerGroupsUpdate: 'streamer-groups:update',
  streamerGroupsDelete: 'streamer-groups:delete',

  // waveform
  audioPeaks: 'audio:peaks',
  sceneChanges: 'media:scene-changes',
  filmstrip: 'media:filmstrip',

  // live sources
  liveWatch: 'live:watch',
  liveUnwatch: 'live:unwatch',
  liveStates: 'live:states',
  liveCovers: 'live:covers',
  liveWindow: 'live:window',

  // dependency installer
  depsStatus: 'deps:status',
  depsInstall: 'deps:install',
  depsCancel: 'deps:cancel',

  // watermarks
  watermarkImport: 'watermark:import',
  watermarkAddPng: 'watermark:add-png',
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
  appMetrics: 'app:metrics',
  cacheClear: 'cache:clear',
  diskSpace: 'disk:space',

  // shell
  revealPath: 'shell:reveal',
  openPath: 'shell:open',

  // logs
  queuePaused: 'export:paused',
  logsPath: 'logs:path',
  /** Anything the renderer needs in the app log. See `logEvent`. */
  logEvent: 'logs:event',
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
  /** The background VOD crawl found something, or changed what it is doing. */
  evtVodCrawl: 'evt:vod-crawl',
  /** A live source changed state — went live, dropped, ended, filled. */
  evtLive: 'evt:live',
  evtLog: 'evt:log',
  evtToast: 'evt:toast',
  evtDeps: 'evt:deps',
  evtOpenProject: 'evt:open-project',
  evtWindowMaximized: 'evt:window-maximized',
  evtUpdate: 'evt:update',
  /** Fired instead of actually closing, so the renderer gets to check for unsaved work first. */
  evtBeforeClose: 'evt:before-close'
} as const

/**
 * What Electron itself says it is costing, sampled live.
 *
 * Exposed for the playback benchmark: the question "is the browser media stack
 * expensive enough to be worth replacing" cannot be answered from inside a
 * renderer, which can only see its own tab. This is every process the app owns.
 */
export interface AppMetrics {
  /** Summed across every process, so 250 means two and a half cores. */
  cpuPercent: number
  /** Working set, MB, summed. */
  memoryMB: number
  processes: Array<{ type: string; cpuPercent: number; memoryMB: number }>
}

export interface EnvInfo {
  ffmpeg: FfmpegInfo
  resolver: ResolverInfo
  platform: NodeJS.Platform
  appVersion: string
  defaultOutputDirectory: string
  /** Base URL of the local same-origin media proxy used by the preview player. */
  mediaProxyBase: string
  /** Required on every media-proxy URL. See shared/mediaProxyUrl.ts. */
  mediaProxyToken: string
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
  /** A second POV composited as an inset over this segment, resolved the same way videoSource is. */
  pip?: {
    source: VodSource
    startSeconds: number
    endSeconds: number
    transform?: TimelineTransform
  }
}

export interface TimelineExportRequest {
  segments: TimelineExportSegment[]
  projectName?: string
  settings: ExportSettings
  outputDirectory: string
  outputName: string
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

  /** `event` is recorded as this streamer's participation (§13); omitting it just skips that. */
  resolveSource(
    url: string,
    event?: { projectId: string; projectName: string; eventName?: string }
  ): Promise<VodSource>
  inspectFormats(source: VodSource): Promise<StreamInfo[]>
  /**
   * Whether this recording is still being written, and how long it is now.
   *
   * Both go stale the moment they are read — see `SourceService.liveStatus`.
   * Null when the platform could not be asked, which leaves what the project
   * already knew alone.
   */
  liveStatus(source: VodSource): Promise<{ durationSeconds: number; stillRecording: boolean } | null>

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
  /**
   * Start holding a rolling buffer for a live source. Idempotent — one buffer
   * per source, shared by every consumer.
   */
  liveWatch(source: VodSource): Promise<LiveState>
  /** Stop holding media for a source and free it. */
  liveUnwatch(sourceId: string): Promise<void>
  /** Every live source's current state, by source id. */
  liveStates(): Promise<LiveSnapshot>
  /**
   * Whether an event range can be served from held media or needs an origin
   * fetch. The difference between instant and slow, which the UI states before
   * the user asks for the clip.
   */
  liveCovers(req: { sourceId: string; startEpoch: number; endEpoch: number }): Promise<boolean>
  /** Change the buffer window (Settings -> Playback & live). */
  liveSetWindow(seconds: number): Promise<LiveSnapshot>

  audioPeaks(req: PeaksQuery): Promise<PeaksReply>
  /** Where the picture actually cuts within a window — suggests clip in/out points. */
  sceneChanges(req: SceneChangesQuery): Promise<SceneChangesReply>
  /** Evenly spaced frames across a window of one POV's video, for the Editor's filmstrip. */
  filmstrip(req: FilmstripQuery): Promise<FilmstripReply>

  /** Copy an image into the app's watermark library. */
  importWatermarkImage(): Promise<WatermarkImage | null>
  /** Store a PNG the renderer drew — used for the automatic POV name badges. */
  addWatermarkPng(dataUrl: string, name: string): Promise<WatermarkImage>
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
  /** Every editing application the app knows about, and what each can be given. */
  listEditors(): Promise<Record<EditorId, EditorCapabilities>>
  /** What is wrong with this project before anything is written. */
  validateEditingProject(
    project: EditingProject,
    editor: EditorId
  ): Promise<{ ok: boolean; issues: Array<{ severity: 'error' | 'warning'; message: string; fix?: string }> }>
  /**
   * Write the project package. Never reads a frame of video: the result's
   * `elapsedMs` is expected to be independent of how long the angles are.
   */
  exportEditingProject(req: {
    project: EditingProject
    editor: EditorId
    parentDirectory: string
    copyMedia: boolean
  }): Promise<{
    editor: EditorId
    directory: string
    projectFile: string | null
    files: string[]
    notes: string[]
    elapsedMs: number
  }>
  /** Ask for the folder the package should be written under. */
  chooseEditingProjectFolder(): Promise<string | null>
  streamersCoveringEvent(req: EventOverlapRequest): Promise<EventOverlapReply>
  /**
   * Every POV of a real-world event, swept across the platforms that support
   * it. Unlike `streamersCoveringEvent` (library only), this also keyword-
   * searches where a platform allows one, and reports in `notes` exactly what
   * it could not sweep — see main/services/discovery.ts.
   */
  discoverEvent(req: EventDiscoveryRequest): Promise<EventDiscoveryReply>

  /**
   * Turn a shared clip/VOD link into the real-world instant it points at.
   * `momentSeconds` is null when the platform did not say enough to place it.
   */
  resolveMoment(url: string): Promise<{
    momentSeconds: number | null
    source: VodSource | null
    offsetSeconds: number | null
    note: string
  }>
  /** Fetch and keep a POV's range locally, before the platform deletes it. */
  archiveRange(req: {
    source: VodSource
    startSeconds: number
    endSeconds: number
  }): Promise<{ path: string; bytes: number }>
  /** Writes a portable package (§20). Null when the editor cancels the save dialog. */
  packageExport(req: {
    project: ProjectFile
    options: { clipIds?: string[]; includeExportPaths?: boolean; note?: string }
  }): Promise<{ path: string; clips: number; povs: number } | null>
  /** Reads a package. Null when cancelled; throws when the file is not a package. */
  /**
   * Open a package. The project comes back validated and migrated exactly as
   * a project file would, so the renderer can open it directly.
   */
  packageImport(): Promise<{
    project: ProjectFile
    createdAt: string
    createdBy: string
    note?: string
  } | null>
  addStreamer(input: string, platform?: PlatformId): Promise<SavedStreamer[]>
  removeStreamer(id: string): Promise<SavedStreamer[]>
  streamerVods(id: string): Promise<StreamerVod[]>
  /**
   * Start the frame server and say where to read from.
   *
   * Starting is deferred until something actually wants to decode: an app
   * nobody opens a POV in should never have run ffmpeg at all.
   */
  /** Tell the decoder which angles it may be asked for. */
  /**
   * Everything the library knows about one streamer's past broadcasts.
   *
   * Answered from disk, so it returns instantly and works offline. Asking
   * also moves that streamer to the front of the background crawl, because
   * asking is the clearest signal of what matters now.
   */
  streamerShelf(id: string): Promise<StreamerVodShelf | null>
  /** Which saved channels are broadcasting right now, keyed by streamer id. */
  streamersLive(): Promise<Record<string, LiveNow>>
  /** Who was live when the app last looked — instant, possibly a few minutes old. */
  streamersLiveCached(): Promise<Record<string, LiveNow>>
  /** The same handle on every platform, ranked by the quality each offers. */
  compareStreamerPlatforms(handle: string): Promise<PlatformComparison>
  /** Find this person's channels on the other platforms and link them as one. */
  discoverStreamerSiblings(id: string): Promise<SavedStreamer[]>
  /** How far along the background crawl is. */
  vodCrawlProgress(): Promise<VodCrawlProgress>
  /** Read this channel's listing next, rather than waiting for its turn. */
  refreshStreamerVods(id: string): Promise<void>
  /** The background crawl reported progress. */
  onVodCrawl(listener: (progress: VodCrawlProgress) => void): () => void
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
  /** Fetch one channel's real name, picture and size from its platform. */
  refreshStreamerProfile(id: string, force?: boolean): Promise<SavedStreamer[]>
  /** Bring every profile older than a week up to date. Quiet and bounded. */
  refreshStreamerProfiles(): Promise<SavedStreamer[]>

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
  /** Live per-process CPU and memory, for the playback benchmark. */
  appMetrics(): Promise<AppMetrics>
  clearCache(): Promise<CacheStats>
  diskSpace(path: string): Promise<DiskSpaceInfo>

  revealPath(path: string): Promise<void>
  openPath(path: string): Promise<void>

  /**
   * Is the export queue paused?
   *
   * Asked once on startup because the answer lives in the main process and the
   * button used to be a renderer-local guess: a reload — including the one the
   * crash screen offers — came back showing "Pause" on a queue that was
   * already paused, with no way to resume but to guess.
   */
  queuePaused(): Promise<boolean>
  logsPath(): Promise<string>
  /**
   * Write to the app log from the renderer.
   *
   * Half of what goes wrong in this app is only visible in the window: a
   * render that threw, a tile decoding at 13fps, an angle that fell back to
   * the browser. None of it reached the log, so diagnosing "it's not smooth"
   * meant reading numbers off a screenshot. The main process cannot see any of
   * it, so the renderer has to say.
   */
  logEvent(
    level: 'debug' | 'info' | 'warn' | 'error',
    scope: string,
    message: string,
    data?: unknown
  ): Promise<void>
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
  onLive(cb: (snapshot: LiveSnapshot) => void): () => void
  onToast(cb: (toast: ToastEvent) => void): () => void
  onOpenProject(cb: (path: string) => void): () => void
  /** Fires on maximize/unmaximize/snap, so the restore-vs-maximize icon stays honest. */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
  /** The window is about to close — a chance to confirm losing unsaved work before it actually does. */
  onBeforeClose(cb: () => void): () => void
}
