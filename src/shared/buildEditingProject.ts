/**
 * Turning what the app knows into a universal editing project.
 *
 * Pure, and deliberately so: it takes the project, the angles that were
 * exported, and the files they were written to, and returns the model. No file
 * system, no FFmpeg, no IPC — which is what makes the 20-angle case testable
 * without twenty files, and what makes it impossible for this step to
 * accidentally read a frame of video.
 *
 * The timeline it builds is one track per angle, all starting at the same
 * instant of the real world. That is the whole trick the app exists to do: a
 * clip is a range on the *event* clock, every angle already knows where that
 * range falls in its own recording, so laying them on a shared timeline is
 * arithmetic that has already been done.
 */

import type { ClipSegment, Marker, VodSource } from './types.js'
import type { WatermarkConfig } from './watermark.js'
import { anchorFractions, watermarkBox } from './watermark.js'
import type {
  EditingProject,
  ProjectMarker,
  ProjectMedia,
  ProjectPov,
  ProjectTransform,
  TimelineClip,
  TimelineTrack
} from './editingProject.js'
import { EDITING_PROJECT_SCHEMA } from './editingProject.js'

/** One exported angle: the file, and which POV and clip it came from. */
export interface ExportedMedia {
  sourceId: string
  clipId: string
  path: string
  fileName: string
  durationSeconds: number
  width: number
  height: number
  fps: number
  codec?: string
  container?: string
  fileSizeBytes?: number
}

export interface BuildInput {
  projectId: string
  projectName: string
  applicationVersion: string
  clip: ClipSegment
  sources: VodSource[]
  media: ExportedMedia[]
  markers: Marker[]
  watermark: {
    config: WatermarkConfig
    assetPath: string
    assetName: string
    /** Intrinsic size of the image, so its aspect ratio survives. */
    imageWidth: number
    imageHeight: number
  } | null
  timeline: {
    width: number
    height: number
    fps: number
  }
  now?: string
}

/**
 * The watermark, as a fraction of the timeline frame.
 *
 * `watermarkBox` is the same function the on-screen editor and the FFmpeg
 * filter use, so what an adapter writes into a project is what the person
 * dragged. It answers in pixels for a given frame; dividing by that frame is
 * what makes the answer resolution-independent again — an adapter then scales
 * it into whatever coordinate space its editor happens to use.
 */
export function watermarkTransform(
  config: WatermarkConfig,
  frame: { width: number; height: number },
  image: { width: number; height: number }
): ProjectTransform {
  const box = watermarkBox(config, frame, {
    width: image.width || 1,
    height: image.height || 1
  })
  return {
    x: (box.left + box.width / 2) / frame.width,
    y: (box.top + box.height / 2) / frame.height,
    width: box.width / frame.width,
    height: box.height / frame.height,
    rotation: config.rotation,
    opacity: config.opacity,
    anchor: config.anchor
  }
}

/** Where the anchor point of a box sits, for adapters that pin rather than centre. */
export function anchorPoint(transform: ProjectTransform): { x: number; y: number } {
  const { fx, fy } = anchorFractions(transform.anchor)
  return {
    x: transform.x + (fx - 0.5) * transform.width,
    y: transform.y + (fy - 0.5) * transform.height
  }
}

/** `POV | Twitch | StreamerName` — a name that says something in a track header. */
export function trackName(source: VodSource): string {
  const platform = source.platform.charAt(0).toUpperCase() + source.platform.slice(1)
  return `POV | ${platform} | ${source.creator || source.title}`
}

export function buildEditingProject(input: BuildInput): EditingProject {
  const { clip, sources, media, timeline } = input
  const byId = new Map(sources.map((s) => [s.id, s]))

  // Only the angles that actually produced a file. A POV that could not be
  // exported must not appear in the project as an empty track — an editor
  // opening it would read that as a missing file rather than an angle that
  // was never there.
  const files = media.filter((m) => m.clipId === clip.id && byId.has(m.sourceId))

  const projectMedia: ProjectMedia[] = files.map((file) => {
    const source = byId.get(file.sourceId)!
    return {
      id: `media_${file.sourceId}`,
      name: file.fileName,
      path: file.path,
      sourceUrl: source.url,
      platform: source.platform,
      durationSeconds: file.durationSeconds,
      width: file.width,
      height: file.height,
      fps: file.fps,
      ...(file.codec ? { codec: file.codec } : {}),
      ...(file.container ? { container: file.container } : {}),
      ...(file.fileSizeBytes !== undefined ? { fileSizeBytes: file.fileSizeBytes } : {})
    }
  })

  /*
   * Where each angle's file begins, on the shared clock.
   *
   * The clip's mapping already says where the moment falls inside each POV,
   * both as asked for and as the recording could actually supply it. When a
   * POV started rolling after the moment began, the two differ — and the gap
   * is exactly how far into the timeline that angle's picture appears. Placing
   * every file at zero instead is the bug this arithmetic prevents: four
   * angles in sync and one of them a minute early.
   */
  const mappings = clip.povMappings ?? []
  const authored = mappings.find((m) => m.authored) ?? mappings[0] ?? null
  const authoredRequestedStart = authored?.requestedStartSeconds ?? clip.startSeconds

  const povs: ProjectPov[] = []
  const tracks: TimelineTrack[] = []
  let longest = clip.durationSeconds

  for (const file of files) {
    const source = byId.get(file.sourceId)!
    const mapping = mappings.find((m) => m.sourceId === file.sourceId)
    const requested = mapping?.requestedStartSeconds ?? clip.startSeconds
    const vodStart = mapping?.vodStartSeconds ?? clip.startSeconds
    const vodEnd = mapping?.vodEndSeconds ?? clip.endSeconds

    const lateBySeconds = Math.max(0, vodStart - requested)
    const usable = Math.max(0, vodEnd - vodStart)
    const timelineStart = round(lateBySeconds)
    const timelineEnd = round(lateBySeconds + Math.min(usable, file.durationSeconds))
    longest = Math.max(longest, timelineEnd)

    povs.push({
      id: `pov_${source.id}`,
      streamerName: source.creator || source.title,
      platform: source.platform,
      ...(source.channelHandle ? { channelHandle: source.channelHandle } : {}),
      vodId: source.vodId,
      sourceUrl: source.url,
      mediaId: `media_${source.id}`,
      sourceInSeconds: round(vodStart),
      sourceOutSeconds: round(vodEnd),
      syncOffsetSeconds: round(requested - authoredRequestedStart),
      ...(mapping ? { matchConfidence: mapping.confidence } : {}),
      sourceWidth: file.width,
      sourceHeight: file.height,
      sourceFps: file.fps
    })

    const item: TimelineClip = {
      id: `clip_${source.id}`,
      mediaId: `media_${source.id}`,
      // The exported file already starts at the cut, so the editor reads it
      // from its own beginning. `sourceInSeconds` on the POV above is where
      // that is in the original broadcast, which is a different fact.
      sourceInSeconds: 0,
      sourceOutSeconds: round(Math.min(usable, file.durationSeconds)),
      timelineStartSeconds: timelineStart,
      timelineEndSeconds: timelineEnd,
      name: trackName(source)
    }

    tracks.push({
      id: `track_${source.id}`,
      name: trackName(source),
      type: 'video',
      clips: [item]
    })
  }

  const watermark = input.watermark
    ? {
        assetPath: input.watermark.assetPath,
        assetName: input.watermark.assetName,
        config: input.watermark.config,
        transform: watermarkTransform(
          input.watermark.config,
          { width: timeline.width, height: timeline.height },
          { width: input.watermark.imageWidth, height: input.watermark.imageHeight }
        )
      }
    : null

  // One overlay across the whole timeline, not one per angle: the watermark is
  // a property of the finished picture, and duplicating it per track would put
  // twenty copies of the same logo on top of each other.
  if (watermark && watermark.config.enabled) {
    tracks.push({
      id: 'track_watermark',
      name: 'Watermark',
      type: 'overlay',
      clips: [
        {
          id: 'clip_watermark',
          assetPath: watermark.assetPath,
          sourceInSeconds: 0,
          sourceOutSeconds: round(longest),
          timelineStartSeconds: 0,
          timelineEndSeconds: round(longest),
          transform: watermark.transform,
          name: watermark.assetName
        }
      ]
    })
  }

  const projectMarkers: ProjectMarker[] = markersForClip(input.markers, clip, mappings)

  return {
    schemaVersion: EDITING_PROJECT_SCHEMA,
    id: input.projectId,
    name: input.projectName,
    createdAt: input.now ?? new Date().toISOString(),
    applicationVersion: input.applicationVersion,
    timeline: {
      durationSeconds: round(longest),
      fps: timeline.fps,
      width: timeline.width,
      height: timeline.height,
      tracks
    },
    media: projectMedia,
    povs,
    markers: projectMarkers,
    watermark,
    metadata: {
      clipId: clip.id,
      clipName: clip.name,
      clipDurationSeconds: clip.durationSeconds,
      ...(typeof clip.eventStartTime === 'number'
        ? { eventStartTime: new Date(clip.eventStartTime * 1000).toISOString() }
        : {})
    }
  }
}

/**
 * The app's markers, moved onto the clip's clock.
 *
 * A marker belongs to one POV at one moment of that POV's recording; the
 * timeline counts from the start of the clip. Anything outside the clip is
 * dropped rather than clamped to its edge, because a marker piled up on frame
 * zero is worse than no marker.
 */
function markersForClip(
  markers: Marker[],
  clip: ClipSegment,
  mappings: Array<{ sourceId: string; vodStartSeconds: number; vodEndSeconds: number }>
): ProjectMarker[] {
  const out: ProjectMarker[] = []
  for (const marker of markers) {
    const mapping = mappings.find((m) => m.sourceId === marker.sourceId)
    const start = mapping?.vodStartSeconds ?? (marker.sourceId === clip.sourceId ? clip.startSeconds : null)
    const end = mapping?.vodEndSeconds ?? (marker.sourceId === clip.sourceId ? clip.endSeconds : null)
    if (start === null || end === null) continue
    if (marker.timeSeconds < start || marker.timeSeconds > end) continue
    out.push({
      seconds: round(marker.timeSeconds - start),
      name: marker.label,
      note: marker.category
    })
  }
  return out.sort((a, b) => a.seconds - b.seconds)
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}
