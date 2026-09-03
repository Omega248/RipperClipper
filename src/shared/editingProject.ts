/**
 * The universal editing project.
 *
 * One editor-independent description of "here are twenty angles of one moment,
 * lined up, with a logo in the corner", built once from the app's own data and
 * handed to whichever adapter was asked for. The adapters know about Resolve
 * and Final Cut; nothing above them does.
 *
 * Two invariants hold this together, and both are load-bearing:
 *
 *   1. **The media is referenced, never rewritten.** A project is paths,
 *      numbers and a small PNG. Building one for twenty four-hour angles costs
 *      the same as building one for two ten-minute angles, because neither
 *      reads a frame of video. An exporter that has to decode something to
 *      build a project has a bug in it.
 *   2. **The watermark is a transform, not pixels.** It travels as a position,
 *      a size and an opacity, and the editing software composites it when it
 *      renders — which is what leaves it adjustable once it gets there.
 */

import type { WatermarkAnchor, WatermarkConfig } from './watermark.js'

export const EDITING_PROJECT_SCHEMA = 1

/** A media file on disk the project points at. Never modified. */
export interface ProjectMedia {
  id: string
  name: string
  /** Absolute path as it exists now; adapters may rewrite it relative. */
  path: string
  sourceUrl?: string
  platform?: string
  durationSeconds: number
  width: number
  height: number
  fps: number
  codec?: string
  container?: string
  fileSizeBytes?: number
}

/** One angle: whose it is, which file carries it, where it sits in time. */
export interface ProjectPov {
  id: string
  streamerName: string
  platform: string
  channelHandle?: string
  vodId?: string
  sourceUrl?: string
  mediaId: string
  /** Where this angle's file begins in its own broadcast. */
  sourceInSeconds: number
  sourceOutSeconds: number
  /**
   * Seconds this angle is shifted by to line up with the others. The timeline
   * below already has it applied; it is carried separately so an editor can
   * see what was done rather than reverse-engineer it.
   */
  syncOffsetSeconds: number
  matchConfidence?: number
  sourceWidth: number
  sourceHeight: number
  sourceFps: number
}

export interface ProjectTransform {
  /** Centre of the item, 0..1 across the frame. */
  x: number
  y: number
  /** Width as a fraction of the frame's width. */
  width: number
  /** Height as a fraction of the frame's height. */
  height: number
  /** Degrees clockwise. */
  rotation: number
  opacity: number
  anchor: WatermarkAnchor
}

export interface TimelineClip {
  id: string
  mediaId?: string
  /** A still drawn over the picture — the watermark. */
  assetPath?: string
  sourceInSeconds: number
  sourceOutSeconds: number
  timelineStartSeconds: number
  timelineEndSeconds: number
  transform?: ProjectTransform
  name: string
}

export interface TimelineTrack {
  id: string
  name: string
  type: 'video' | 'audio' | 'overlay'
  clips: TimelineClip[]
}

export interface ProjectTimeline {
  durationSeconds: number
  fps: number
  width: number
  height: number
  tracks: TimelineTrack[]
}

export interface ProjectMarker {
  seconds: number
  name: string
  note?: string
  colour?: string
}

export interface EditingProject {
  schemaVersion: number
  id: string
  name: string
  createdAt: string
  applicationVersion: string
  timeline: ProjectTimeline
  media: ProjectMedia[]
  povs: ProjectPov[]
  markers: ProjectMarker[]
  /** The overlay asset, when one is configured. */
  watermark: {
    assetPath: string
    assetName: string
    config: WatermarkConfig
    transform: ProjectTransform
  } | null
  metadata: Record<string, unknown>
}

// ------------------------------------------------------------------ time ----

/**
 * Frames from seconds, at a real frame rate.
 *
 * Editors count in frames, and the rates that matter are rational: 29.97 is
 * 30000/1001, and treating it as 30 puts a two-hour timeline seven seconds out
 * by the end. Rounding happens once, here, against the rate the timeline
 * actually declares.
 */
export function secondsToFrames(seconds: number, fps: number): number {
  if (!(fps > 0)) return 0
  return Math.round(seconds * fps)
}

export function framesToSeconds(frames: number, fps: number): number {
  if (!(fps > 0)) return 0
  return frames / fps
}

/** `HH:MM:SS:FF` at the given rate, for the editors that want timecode. */
export function timecode(seconds: number, fps: number): string {
  const total = Math.max(0, secondsToFrames(seconds, fps))
  const rate = Math.max(1, Math.round(fps))
  const frames = total % rate
  const whole = Math.floor(total / rate)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}:${pad(frames)}`
}

/** The rational denominator Final Cut uses for a rate: 30 → 30, 29.97 → 30000. */
function timebase(fps: number): { denominator: number; perFrame: number } {
  const ntsc = Math.abs(fps - Math.round(fps)) > 0.001
  return ntsc
    ? { denominator: Math.round(fps * 1.001) * 1000, perFrame: 1001 }
    : { denominator: Math.max(1, Math.round(fps)), perFrame: 1 }
}

/**
 * A rational duration for FCPXML, which refuses a decimal.
 *
 * Final Cut wants `<numerator>/<denominator>s` and reinterprets anything whose
 * denominator is not the timeline's own timebase — so an NTSC rate gets its
 * real 1001-based denominator rather than a rounded one.
 */
export function rationalTime(seconds: number, fps: number): string {
  const { denominator, perFrame } = timebase(fps)
  return `${secondsToFrames(seconds, fps) * perFrame}/${denominator}s`
}

/** The frame duration a `<format>` declares, at this rate. */
export function frameDuration(fps: number): string {
  const { denominator, perFrame } = timebase(fps)
  return `${perFrame}/${denominator}s`
}
