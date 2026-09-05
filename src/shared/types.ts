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
  /** Which collection (§6) this clip is filed under. Absent means loose in the event. */
  collectionId?: string | null
  /**
   * Where this clip has got to (§7). Absent means `found` — the state a clip
   * is in the moment it is marked, so existing projects need no migration
   * beyond reading the absence.
   */
  workflow?: ClipWorkflowState
  /**
   * POVs the editor has actually decided to use for this clip (§8).
   *
   * Distinct from `povMappings`, which says which POVs *could* show the
   * moment. "Available but never looked at" is the state worth surfacing —
   * it is how footage nobody considered gets found — and that cannot be
   * derived from availability alone.
   */
  usedPovIds?: string[]
  /** Cached contact-sheet thumbnail (§9), as data URLs keyed by POV. */
  thumbnails?: Record<string, string>
}

/**
 * How far along a clip is (§7). Deliberately few and linear: the point is a
 * glanceable "what still needs work", not a workflow engine.
 */
export type ClipWorkflowState =
  | 'found'
  | 'reviewed'
  | 'povs-collected'
  | 'ready-for-edit'
  | 'in-edit'
  | 'exported'

export const CLIP_WORKFLOW_ORDER: ClipWorkflowState[] = [
  'found',
  'reviewed',
  'povs-collected',
  'ready-for-edit',
  'in-edit',
  'exported'
]

export const CLIP_WORKFLOW_LABEL: Record<ClipWorkflowState, string> = {
  found: 'Found',
  reviewed: 'Reviewed',
  'povs-collected': 'POVs collected',
  'ready-for-edit': 'Ready for edit',
  'in-edit': 'In edit',
  exported: 'Exported'
}

/** A named grouping of clips inside one event (§6) — "Bank Robbery", "Chase". */
export interface ClipCollection {
  id: string
  name: string
  /** Position in the sidebar. Lower sorts first. */
  order: number
  note?: string
}

/** A notable instant on the event timeline (§21) — "18:44 Crash". */
export interface EventMoment {
  id: string
  /** Real-world epoch seconds. */
  timeSeconds: number
  name: string
  note?: string
}

/**
 * What makes a project an *event* rather than a bag of VODs (§2): the
 * real-world window it happened in, and the organisation layered on top.
 */
export interface EventInfo {
  /** Display name, e.g. "NoPixel — bank robbery". Null until named. */
  name: string | null
  /** Real-world epoch seconds. Null until the editor declares the window. */
  startSeconds: number | null
  endSeconds: number | null
  collections: ClipCollection[]
  moments: EventMoment[]
  note?: string
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
  /** BCP-47-ish tag from the resolver, e.g. "en", "de", "zh-Hans". Audio tracks only. */
  language?: string
  /**
   * This is the track the video was actually recorded in, not a dub.
   *
   * YouTube's auto-dubbing publishes one audio track per language, all encoded
   * from the same ladder, and the dubs frequently come out at a *higher*
   * bitrate than the original. Choosing audio on quality alone therefore picks
   * a dub — see `rankAudio`. False here means either "a dub" or "the source
   * never said", and those are deliberately not distinguished: only a positive
   * claim of originality is allowed to change the ranking.
   */
  originalAudio?: boolean
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

/**
 * A live source's current relationship to its broadcast.
 *
 * Deliberately not a boolean. "Live" and "not live" cannot express the two
 * states the UI most needs to distinguish from failure: a stream that dropped
 * and is coming back, and a stream that ended whose archive has not been
 * published yet. Both must keep the clip ranges already captured against them
 * — treating either as an error loses the user's work.
 */
export interface LiveState {
  state: 'live' | 'reconnecting' | 'ended' | 'awaiting-vod'
  /** Seconds behind the broadcast edge, as measured — never assumed from wall clock. */
  latencySeconds: number
  /** Seconds of media currently held in the rolling buffer. */
  bufferedSeconds: number
  /** The configured window. The buffer never exceeds it. */
  windowSeconds: number
  /** When the broadcast started, if the platform reports it. */
  startedAt?: number
  /** Viewers, if the platform reports it. Display only. */
  viewers?: number
  /** Set once the archive resolves. This is what completes a held live clip. */
  archivedVodId?: string
  /**
   * The platform's own recording of the broadcast *while it is still running*.
   *
   * Twitch, Kick and YouTube all start publishing a recording as the broadcast
   * goes out, and it grows with it. That recording is the whole session from
   * the moment they went live, at source quality, seekable — everything the
   * rolling buffer is not. Once this is known the source plays and exports
   * from it and the buffer becomes a fallback for the last few seconds the
   * recording has not caught up with.
   *
   * Distinct from `archivedVodId`, which means the broadcast has *finished*
   * and this is its final archive.
   */
  recordingVodId?: string
  /** Consecutive failed reconnects. Drives the retry backoff and the wording. */
  retries?: number
}

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
  /**
   * This source is a broadcast happening now, rather than a finished VOD.
   *
   * Distinct from `live`, which is the *state* of the rolling buffer and only
   * exists once the app is actually holding media. This says what the source
   * IS, is known the moment it resolves, and is what tells the rest of the app
   * that `durationSeconds` is a floor rather than a length, that the clock is
   * wall-clock rather than an offset from zero, and that a clip has to be cut
   * from held media.
   */
  isLive?: boolean
  /**
   * This recording is still being written — the broadcast is on air.
   *
   * A live channel is opened as the VOD the platform is already making, so the
   * media is an ordinary recording: it seeks and it exports like any other, and
   * `isLive` is false. But its length is a floor that moves, not a limit, and
   * anything asking "where is this angle right now" has to know the difference.
   */
  stillRecording?: boolean
  /**
   * The archive this broadcast became, once it has been published.
   *
   * A clip marked against a live source is cut from the buffer at the time and
   * can be re-cut precisely from here afterwards — the two are the same range
   * on the same event clock, from two different sources of the media.
   */
  archivedVodId?: string
  /**
   * The platform's recording of this broadcast while it was still running.
   *
   * Kept on the source, not just in live state, because it is what the clips
   * marked during the broadcast were actually cut from.
   */
  recordingVodId?: string
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
  /**
   * Present only on sources that are (or were) live. A source that has gone
   * `ended` keeps this block so the UI can say what happened rather than
   * silently becoming an ordinary VOD with a gap.
   *
   * Transient runtime state: never persisted into the project file.
   */
  live?: LiveState
  /** Character this POV is streaming as, when the editor has named it. */
  character?: string
  /** Editor-chosen POV label, used when no character name is set. */
  povName?: string
  /**
   * The person unticked this angle in the wall's angle picker.
   *
   * A view choice, not a property of the recording: the POV keeps its clips,
   * its sync and its place on the timeline, it simply is not one of the angles
   * being watched right now. Absent (the common case) means shown, so a POV
   * added later appears without anyone having to tick it.
   *
   * Persisted with the project — which angles you watch an event from is part
   * of how you were working on it, and having to re-tick eight of fourteen
   * every time you reopen would make the picker worse than no picker.
   */
  hiddenInWall?: boolean
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

/**
 * What the app should tell you about this platform before you rely on it.
 *
 * This used to carry four booleans — metadata, playback, rangeDownload,
 * requiresAuth — hardcoded `true` in all three adapters, read by nothing, and
 * documented as "shown to the user when a capability is false" when none of
 * them ever was. `requiresAuth: false` sat directly beside a note saying
 * sub-only VODs need an account. A declaration nothing checks and nothing
 * reads is worse than no declaration: it reads like a guarantee.
 *
 * The notes are real, and are shown in the quality panel.
 */
export interface AdapterCapabilities {
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
   * Splice an exact cut instead of re-encoding all of it.
   *
   * When a cut has to be frame-accurate, only the frames between the mark and
   * the next keyframe actually need re-encoding — the rest of the clip is
   * already exactly what the file should contain and can be copied. On by
   * default; turn it off to go back to re-encoding the whole clip in one pass.
   */
  smartCut: boolean
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
    /**
     * Browser whose cookies yt-dlp may borrow, or null for none.
     *
     * The only way to reach a subscriber-only or age-restricted VOD the person
     * is genuinely entitled to watch. Read from the browser at resolve time by
     * yt-dlp itself — the app never stores, copies or transmits them, and asks
     * for no password. The platform notes have told people to set this since
     * before the setting existed.
     */
    cookiesFromBrowser: string | null
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
    /**
     * Set the first time the editor adds a clip. The "making your first clip"
     * strip is keyed on this rather than on the open event having no clips,
     * so it teaches once instead of returning on every new event forever.
     */
    hasMadeAClip: boolean
    /**
     * Ceiling on how many POV tiles decode at once. Defaults to 8, which is
     * about what fits on one screen before tiles stop being worth looking at;
     * 0 means no ceiling.
     *
     * A machine limit, not a content choice — *which* angles are on screen is
     * the wall's angle picker (`VodSource.hiddenInWall`). See `wallSelection`.
     */
    maxLivePovs?: number
    /**
     * Stamp every loaded POV with a generated badge naming whose angle it is,
     * so exported angles arrive in an editor already labelled.
     *
     * On by default. A watermark does rule out stream copy — every frame is
     * different, so there is nothing left to copy — which is why the encode
     * behind it is composited on the GPU wherever the machine allows it (see
     * `cudaOverlay`): decode, overlay and encode without a frame ever leaving
     * VRAM. Turn it off and a clip that needs no other redraw becomes a copy.
     */
    autoNameBadge?: boolean
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
  /**
   * Video items only. When this item overlaps a video item on a lower
   * track, it composites as an inset over it (using its own `transform` for
   * position/size) instead of simply winning by track order — the one
   * opt-in way to get two POVs on screen at once. An item without this set
   * behaves exactly as before: topmost wins, nothing composites.
   */
  pip?: boolean
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
   *   5 — the project states the real-world event it covers (`event`), and
   *       clips carry collection, workflow state and used-POV tracking. All
   *       of it is additive: a v4 project loads with no event block and every
   *       clip reading as `found`, which is exactly what it was.
   */
  schemaVersion: 5
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
  /**
   * The real-world event this project covers (§2). Absent on projects saved
   * before events existed; `eventWindow()` falls back to the span the clips
   * themselves occupy so nothing depends on it being filled in.
   */
  event?: EventInfo
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
  /**
   * This machine can decode, overlay and encode without the frames ever
   * leaving the GPU — NVDEC → `overlay_cuda` → NVENC.
   *
   * The difference this makes is the difference between a watermarked clip
   * being a preprocessing step and being an export: the CPU path copies every
   * frame out of the GPU, composites it, and copies it back, which is what
   * made a watermarked cut run at 2x realtime instead of 10x. Smoke-tested at
   * startup like the encoders, because `-filters` listing `overlay_cuda`
   * only means the build has it, not that this driver will run it.
   */
  cudaOverlay: boolean
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
