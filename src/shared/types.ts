/**
 * Core domain model shared by the main process, preload bridge and renderer.
 *
 * Timestamps are ALWAYS stored as numeric seconds with sub-second precision.
 * Formatted strings exist only at the presentation boundary (see time.ts).
 */

import type { SyncAnchor, SyncMethod, VodTimeMapping } from './sync.js'
import type { WatermarkConfig } from './watermark.js'
import type { AudioEdit } from './audioEdits.js'

export type PlatformId = 'twitch' | 'kick' | 'youtube'

export type ClipStatus =
  | 'idle'
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'processing'
  | 'verifying'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface ClipSegment {
  id: string
  name: string
  /**
   * The POV the clip was authored from. Its local times below are what the
   * editor typed; every *other* POV's range is derived from the event times.
   */
  sourceId: string
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  order: number
  status: ClipStatus
  /**
   * THE CANONICAL RANGE: real-world epoch seconds. A clip belongs to the event,
   * not to a VOD, which is what lets a POV added days later inherit it without
   * anything being recreated. Null only while the authoring POV has no known
   * real-world timing.
   */
  eventStartTime?: number | null
  eventEndTime?: number | null
  /** POV the exported picture comes from. Defaults to the authoring POV. */
  videoSourceId?: string
  /** POV the exported sound comes from. Defaults to the video POV. */
  audioSourceId?: string
  /**
   * Every loaded POV's take on this clip, generated atomically with the clip
   * itself. Event time above stays canonical; these are its projections.
   */
  povMappings?: ClipPovMapping[]
  /**
   * Per-clip timing corrections, in seconds, keyed by POV.
   *
   * A whole-VOD offset fixes a stream that started late; this fixes the rest —
   * drift that has crept in by hour three, a POV whose platform rounded its
   * start time, a moment that simply does not line up. It applies to THIS clip
   * only and leaves every other clip's alignment alone.
   */
  povOffsets?: Record<string, number>
  /**
   * Hand-drawn mute/bleep/duck ranges, keyed by POV inside each edit. Applied
   * only when a file is written — see shared/audioEdits.ts.
   */
  audioEdits?: AudioEdit[]
  /** Absolute path of the last successful export, if any. */
  exportedPath?: string
  /** Human readable note about the last export (e.g. keyframe drift). */
  lastMessage?: string
  /** Free-text triage label ("Highlight", "Needs review", …). Colour is derived from the text. */
  tag?: string | null
  /** When this clip was created — absent on clips saved before this field existed. */
  createdAt?: string
}

/**
 * How a POV stands in relation to one clip. Explicit, because "the POV exists"
 * and "the POV shows this moment" are different facts and the editor has to be
 * able to tell them apart at a glance.
 */
export type PovClipStatus =
  /** Covers the whole clip. */
  | 'available'
  /** Covers part of it — the POV started late or ended early. */
  | 'partial'
  /** Was not recording during this moment. */
  | 'out_of_range'
  /** No real-world timing for this POV yet, so nothing can be claimed. */
  | 'sync_required'
  /** Timing is known but weak enough that the editor should check it. */
  | 'sync_low_confidence'

/**
 * A clip's range as it falls in one POV. Materialised when the clip is created
 * and refreshed whenever the POV set or a sync mapping changes, so a saved
 * project carries the whole multi-POV object rather than something that has to
 * be recomputed to be understood.
 */
export interface ClipPovMapping {
  sourceId: string
  /** Local VOD seconds, clamped to what the POV actually has. */
  vodStartSeconds: number
  vodEndSeconds: number
  /** The unclamped mapping, so partial coverage can be explained. */
  requestedStartSeconds: number
  requestedEndSeconds: number
  status: PovClipStatus
  confidence: number
  method: SyncMethod
  /** True for the POV the editor defined the range in. */
  authored: boolean
  updatedAt: string
  /**
   * What this POV can actually supply for this clip.
   *
   * Both come from the same recording and therefore share a range — a POV's
   * picture and its sound are the same seconds of the same broadcast, and
   * storing two different numbers would be inventing a difference that does
   * not exist. What genuinely differs is *availability*: a source can be
   * audio-only, or expose no audio stream at all, and the editor has to be
   * able to see that before choosing it as the sound POV.
   */
  media: {
    video: PovMediaAvailability
    audio: PovMediaAvailability
  }
}

export interface PovMediaAvailability {
  /** False when the source has no such stream, or does not cover the clip. */
  available: boolean
  /** The range in this POV's own recording. Zero-length when unavailable. */
  startSeconds: number
  endSeconds: number
}

export type MarkerCategory = 'funny' | 'reaction' | 'important' | 'idea' | 'other'

export interface Marker {
  id: string
  sourceId: string
  timeSeconds: number
  label: string
  category: MarkerCategory
}

export interface StreamInfo {
  /** Format identifier as reported by the resolver. */
  id: string
  container?: string
  codec?: string
  width?: number
  height?: number
  fps?: number
  /** bits per second */
  bitrate?: number
  /** audio only */
  sampleRate?: number
  channels?: number
  /** Estimated total bytes for the whole VOD in this format, when known. */
  filesize?: number
  /** How a byte range for this format can be obtained. */
  protocol: MediaProtocol
  /** Human label, e.g. "1080p60" */
  label: string
  url: string
  httpHeaders?: Record<string, string>
  hasVideo: boolean
  hasAudio: boolean
}

/** How the engine must fetch a sub-range of a given format. */
export type MediaProtocol =
  /** HLS media playlist: parse #EXTINF and fetch only the covering segments. */
  | 'hls'
  /** Plain HTTP resource that honours Range requests; ffmpeg seeks into it. */
  | 'http-range'
  /** DASH/segmented resource described by an explicit fragment list. */
  | 'fragmented'

export interface VodSource {
  id: string
  platform: PlatformId
  /** Platform-native VOD id. */
  vodId: string
  url: string
  title: string
  creator: string
  durationSeconds: number
  /** ISO 8601 */
  createdAt?: string
  thumbnailUrl?: string
  /** Direct playback URL usable by the in-app player, if the platform allows it. */
  playbackUrl?: string
  playbackKind: PlaybackKind
  capabilities: AdapterCapabilities
  /** Populated after an explicit "inspect source" step. Never guessed. */
  formats?: StreamInfo[]
  /** True once formats have actually been probed from the source. */
  formatsInspected: boolean
  /**
   * Where this POV sits on the real-world event clock. Absent means the POV
   * has never been solved; `method: 'unsynced'` means it was solved and no
   * timing could be established. See shared/sync.ts.
   */
  syncMapping?: VodTimeMapping
  /** Character this POV is streaming as, when the editor has named it. */
  character?: string
  /** Editor-chosen POV label, used when no character name is set. */
  povName?: string
  /**
   * The channel's own name on its platform (a login/slug, not a display name),
   * which is what the streamer library and channel listings key off. Also how
   * a VOD finds its streamer's watermark default.
   */
  channelHandle?: string
  /**
   * This VOD's own watermark. Absent means "use the streamer's default" — the
   * override is stored only once the editor has actually set one, so changing
   * the default still reaches every VOD that never disagreed with it.
   */
  watermark?: WatermarkConfig
}

/**
 * How the application's own player should show this source. There is one
 * player for every platform — no embedded platform UI is ever used.
 */
export type PlaybackKind =
  /** hls.js drives a <video> element. */
  | 'hls'
  /** A muxed progressive file drives a <video> element directly. */
  | 'progressive'
  /** The source offers nothing the native player can show. */
  | 'none'

export interface AdapterCapabilities {
  metadata: boolean
  playback: boolean
  rangeDownload: boolean
  requiresAuth: boolean
  /** Explanation shown to the user when a capability is false. */
  notes: string[]
}

export type ExportContainer = 'mp4' | 'mkv'
export type CutMode = 'smart' | 'copy' | 'precise'
export type QualityPreference = 'best' | '1440' | '1080' | '720' | 'audio-only'
export type HwAccelPreference = 'auto' | 'none' | 'nvenc' | 'qsv' | 'amf' | 'videotoolbox' | 'vaapi'

export interface ExportSettings {
  container: ExportContainer
  cutMode: CutMode
  quality: QualityPreference
  hwAccel: HwAccelPreference
  /** Max seconds of keyframe drift tolerated before smart mode re-encodes. */
  keyframeToleranceSeconds: number
  /**
   * Seconds of head and tail added when a POV's alignment for a clip is not
   * trusted, so an uncertain cut still contains the moment. Zero disables it.
   */
  uncertainPaddingSeconds: number
  filenameTemplate: string
  /**
   * Folder structure under the output directory, as a path template using the
   * same tokens (e.g. "{Project}", "{Project}/{Creator}", "{Project}/{Name}").
   * Empty puts every file straight in the output directory.
   */
  folderTemplate: string
}

/** A named, reusable bundle of export settings — quality, container, cutting, filenames. */
export interface ExportPreset {
  id: string
  name: string
  settings: ExportSettings
  /** Auto-applied to a project's export settings when it's created. At most one preset carries this. */
  isDefault?: boolean
}

export interface AppSettings {
  outputDirectory: string
  concurrency: number
  export: ExportSettings
  cache: {
    directory: string
    maxSizeBytes: number
  }
  advanced: {
    ffmpegPath: string | null
    ffprobePath: string | null
    ytDlpPath: string | null
    tempDirectory: string | null
    /** Install missing tools automatically on startup. */
    autoInstallTools: boolean
    logLevel: LogLevel
  }
  ui: {
    /**
     * `system` follows the OS setting and is the default; the other two pin
     * the application regardless of what the OS is doing.
     */
    theme: ThemeMode
    timelineFollowPlayhead: boolean
    /** Side panel width in px. Unset means "use the responsive default". */
    sidePanelWidth?: number
    /** Bottom timeline strip height in px. Unset means "size to content". */
    timelineHeight?: number
    /** A short chime when an export batch finishes, alongside the toast/notification. */
    exportCompletionSound: boolean
    /** Built previews downscale to a lighter proxy — faster to seek within, at the cost of picture quality. */
    fastPreview: boolean
  }
  shortcuts: Record<string, string>
  /** Saved export-setting bundles, applied to the current project on demand. */
  exportPresets: ExportPreset[]
}

export type ThemeMode = 'system' | 'light' | 'dark'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * The Editor's multi-track timeline.
 *
 * A track holds items; an item is a *reference* to a range of a POV's own
 * VOD time, placed at a position on the timeline — never a copy of it and
 * never a change to it. Moving, trimming or deleting an item changes only
 * where it sits and how much of the source it shows; the source clip, and
 * every other item that also references it, is untouched. That's what makes
 * the same clip usable twice in one timeline, and what makes deleting an
 * item risk-free.
 */
export type TimelineItemKind = 'video' | 'audio'

export interface TimelineTransform {
  /** -1..1, fraction of frame width/height offset from centre. */
  x: number
  y: number
  /** 1 = fills the frame at the source's own aspect ratio. */
  scale: number
  /** Degrees. */
  rotation: number
}

export interface TimelineItem {
  id: string
  trackId: string
  kind: TimelineItemKind
  /** The POV this item plays from. */
  sourceId: string
  /**
   * The clip this item was dragged in from, if any — what "reveal source"
   * resolves. Absent for an item built directly from a POV with no
   * pre-existing clip behind it.
   */
  sourceClipId?: string
  /** The range of the POV's own VOD time this item shows. */
  sourceStartSeconds: number
  sourceEndSeconds: number
  /** Where this item sits on the overall timeline. */
  timelineStartSeconds: number
  timelineEndSeconds: number
  /**
   * The paired item from the same drag — a POV's picture and sound arrive as
   * one video item and one audio item, linked so moving or trimming one
   * carries the other. Absent once the editor deliberately unlinks them.
   */
  linkedItemId?: string
  /** 1 = normal speed. */
  speed?: number
  /** Audio items only, 0..2. 1 = unity. */
  volume?: number
  muted?: boolean
  /** Video items only, 0..1. */
  opacity?: number
  transform?: TimelineTransform
  /** Absent inherits the POV's saved watermark. 'none' explicitly disables it for this item only — the source's own configuration is never touched. */
  watermarkOverride?: WatermarkConfig | 'none'
  /** Hand-drawn mute/bleep/duck ranges, in the item's own local time (0 = sourceStartSeconds). */
  audioEdits?: AudioEdit[]
  note?: string
}

export interface TimelineTrack {
  id: string
  kind: TimelineItemKind
  name: string
  /** Stacking order within its kind. Video: higher sits visually on top (V3 over V1). */
  order: number
  locked?: boolean
  /** Video only. */
  hidden?: boolean
  /** Audio only. */
  muted?: boolean
  solo?: boolean
}

export interface TimelineMarker {
  id: string
  timeSeconds: number
  name: string
  note?: string
}

export interface EditorTimeline {
  tracks: TimelineTrack[]
  items: TimelineItem[]
  markers: TimelineMarker[]
}

export interface ProjectFile {
  /**
   * Schema version for forward compatibility.
   *
   *   3 — clips carry an event range and materialised POV mappings.
   *   4 — music detection and music separation removed; a v3 project's music
   *       findings are dropped and music actions become mutes on load.
   *       VOD sources may carry a watermark override.
   */
  schemaVersion: 4
  id: string
  name: string
  createdAt: string
  updatedAt: string
  sources: VodSource[]
  clips: ClipSegment[]
  markers: Marker[]
  /** Every real-world timing anchor in the project, across all POVs. */
  syncAnchors?: SyncAnchor[]
  exportSettings: ExportSettings
  outputDirectory: string | null
  /** The Editor's multi-track timeline. Absent until the Editor is opened for the first time. */
  timeline?: EditorTimeline
}

export type JobStage =
  | 'queued'
  | 'resolving'
  | 'downloading-video'
  | 'downloading-audio'
  | 'cutting'
  | 'muxing'
  | 'verifying'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'paused'

export interface JobProgress {
  stage: JobStage
  /** 0..1 for the current stage. */
  stageProgress: number
  /** 0..1 across the whole job. */
  overallProgress: number
  downloadedBytes: number
  totalBytes: number | null
  bytesPerSecond: number
  etaSeconds: number | null
  message: string
}

export interface ExportJob {
  id: string
  clipId: string
  clipName: string
  sourceId: string
  outputPath: string | null
  progress: JobProgress
  error: SerializedAppError | null
  attempts: number
  startedAt: string | null
  finishedAt: string | null
  verification: VerificationReport | null
}

export interface VerificationReport {
  ok: boolean
  path: string
  sizeBytes: number
  container: string
  durationSeconds: number
  expectedDurationSeconds: number
  durationDeltaSeconds: number
  video: {
    present: boolean
    codec?: string
    width?: number
    height?: number
    fps?: number
    durationSeconds?: number
  }
  audio: {
    present: boolean
    codec?: string
    sampleRate?: number
    channels?: number
    durationSeconds?: number
  }
  /** |videoDuration - audioDuration| */
  avSkewSeconds: number | null
  problems: string[]
}

export interface SerializedAppError {
  code: string
  title: string
  message: string
  /** Suggested user action, e.g. "Retry". */
  retryable: boolean
  detail?: string
}

export interface FfmpegInfo {
  available: boolean
  ffmpegPath: string | null
  ffprobePath: string | null
  version: string | null
  /** Encoder names detected as usable for hardware acceleration. */
  hwEncoders: string[]
  error: SerializedAppError | null
}

export interface ResolverInfo {
  available: boolean
  path: string | null
  version: string | null
  error: SerializedAppError | null
}

export interface DiskSpaceInfo {
  path: string
  freeBytes: number
  totalBytes: number
}
