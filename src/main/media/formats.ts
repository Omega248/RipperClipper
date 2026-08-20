import { Errors } from '../../shared/errors.js'
import type { ExportContainer, QualityPreference, StreamInfo } from '../../shared/types.js'

/**
 * Stream selection: pick the best video and audio the source actually offers,
 * and work out whether they can go into the requested container untouched.
 */

export interface SelectedStreams {
  video: StreamInfo | null
  audio: StreamInfo | null
  /** True when video and audio live in the same stream (already muxed). */
  muxed: boolean
  notes: string[]
}

const HEIGHT_TARGET: Record<Exclude<QualityPreference, 'best' | 'audio-only'>, number> = {
  '1440': 1440,
  '1080': 1080,
  '720': 720
}

export function rankVideo(a: StreamInfo, b: StreamInfo): number {
  const areaA = (a.width ?? 0) * (a.height ?? 0)
  const areaB = (b.width ?? 0) * (b.height ?? 0)
  if (areaA !== areaB) return areaB - areaA
  const fpsA = a.fps ?? 0
  const fpsB = b.fps ?? 0
  if (fpsA !== fpsB) return fpsB - fpsA
  return (b.bitrate ?? 0) - (a.bitrate ?? 0)
}

export function rankAudio(a: StreamInfo, b: StreamInfo): number {
  const chA = a.channels ?? 0
  const chB = b.channels ?? 0
  if (chA !== chB) return chB - chA
  const brA = a.bitrate ?? 0
  const brB = b.bitrate ?? 0
  if (brA !== brB) return brB - brA
  return (b.sampleRate ?? 0) - (a.sampleRate ?? 0)
}

export function selectStreams(
  formats: StreamInfo[],
  quality: QualityPreference
): SelectedStreams {
  const notes: string[] = []
  const usable = formats.filter((f) => f.url)

  if (usable.length === 0) {
    throw Errors.qualityUnavailable('any downloadable stream', 'resolver returned no usable formats')
  }

  const audioOnly = usable.filter((f) => f.hasAudio && !f.hasVideo).sort(rankAudio)

  if (quality === 'audio-only') {
    if (audioOnly.length === 0) {
      const muxedWithAudio = usable.filter((f) => f.hasAudio).sort(rankAudio)[0]
      if (!muxedWithAudio) throw Errors.qualityUnavailable('an audio-only stream')
      return { video: null, audio: muxedWithAudio, muxed: false, notes }
    }
    return { video: null, audio: audioOnly[0], muxed: false, notes }
  }

  const videoCapable = usable.filter((f) => f.hasVideo).sort(rankVideo)
  if (videoCapable.length === 0) throw Errors.qualityUnavailable('a video stream')

  let chosenVideo: StreamInfo
  if (quality === 'best') {
    chosenVideo = videoCapable[0]
  } else {
    const target = HEIGHT_TARGET[quality]
    const atOrBelow = videoCapable.filter((f) => (f.height ?? 0) <= target)
    if (atOrBelow.length > 0) {
      chosenVideo = atOrBelow[0]
      if ((chosenVideo.height ?? 0) !== target) {
        notes.push(
          `${target}p is not available from this source; using ${chosenVideo.label} instead.`
        )
      }
    } else {
      chosenVideo = videoCapable[videoCapable.length - 1]
      notes.push(`Source minimum is ${chosenVideo.label}; ${target}p is not offered.`)
    }
  }

  if (chosenVideo.hasAudio) {
    return { video: chosenVideo, audio: null, muxed: true, notes }
  }

  const chosenAudio = audioOnly[0] ?? null
  if (!chosenAudio) {
    // The source genuinely has no audio track we can pair with this video.
    const muxedAlternative = videoCapable.find((f) => f.hasAudio)
    if (muxedAlternative) {
      notes.push(
        `No separate audio stream is available, so ${muxedAlternative.label} (video + audio) was used instead of ${chosenVideo.label}.`
      )
      return { video: muxedAlternative, audio: null, muxed: true, notes }
    }
    notes.push('This source does not provide an audio track; the clip will be silent.')
    return { video: chosenVideo, audio: null, muxed: false, notes }
  }

  return { video: chosenVideo, audio: chosenAudio, muxed: false, notes }
}

const MP4_VIDEO_OK = /^(avc1|avc3|h264|hev1|hvc1|h265|av01|mp4v)/i
const MP4_AUDIO_OK = /^(mp4a|aac|ac-3|ec-3|alac)/i

export interface ContainerPlan {
  container: ExportContainer
  /** Codec copy is possible for video. */
  copyVideo: boolean
  copyAudio: boolean
  /** Encoder to use when copyAudio is false. */
  audioEncoder?: string
  notes: string[]
}

/**
 * Decide the output container. Quality is never silently degraded: when the
 * source streams cannot go into MP4 as-is we either switch to MKV (lossless,
 * the default) or transcode audio only — and say which happened.
 */
export function planContainer(
  selected: SelectedStreams,
  requested: ExportContainer,
  onMp4Incompatible: 'switch-to-mkv' | 'convert-audio'
): ContainerPlan {
  const notes: string[] = []
  if (requested === 'mkv') {
    return { container: 'mkv', copyVideo: true, copyAudio: true, notes }
  }

  const videoCodec = selected.video?.codec ?? ''
  const audioCodec = selected.audio?.codec ?? (selected.muxed ? selected.video?.codec ?? '' : '')

  const videoOk = selected.video === null || MP4_VIDEO_OK.test(videoCodec)
  // For a muxed stream we cannot inspect the audio codec separately here;
  // the exporter re-checks the real codecs with ffprobe after download.
  const audioOk =
    selected.audio === null ? true : MP4_AUDIO_OK.test(audioCodec)

  if (videoOk && audioOk) {
    return { container: 'mp4', copyVideo: true, copyAudio: true, notes }
  }

  if (!videoOk) {
    notes.push(
      `The source video codec (${videoCodec || 'unknown'}) cannot be stored in MP4 without re-encoding, so the clip was written as MKV to preserve the original quality.`
    )
    return { container: 'mkv', copyVideo: true, copyAudio: true, notes }
  }

  if (onMp4Incompatible === 'convert-audio') {
    notes.push(
      `The source audio codec (${audioCodec || 'unknown'}) is not supported by MP4, so audio was converted to AAC 320 kbps. Video was copied untouched.`
    )
    return {
      container: 'mp4',
      copyVideo: true,
      copyAudio: false,
      audioEncoder: 'aac',
      notes
    }
  }

  notes.push(
    `The source audio codec (${audioCodec || 'unknown'}) is not supported by MP4, so the clip was written as MKV instead of re-encoding the audio.`
  )
  return { container: 'mkv', copyVideo: true, copyAudio: true, notes }
}

/** Human summary of the detected source, for the quality panel. */
export function describeStreams(selected: SelectedStreams): { video: string[]; audio: string[] } {
  const video: string[] = []
  const audio: string[] = []
  const v = selected.video
  if (v) {
    if (v.width && v.height) video.push(`${v.width} × ${v.height}`)
    if (v.fps) video.push(`${Math.round(v.fps)} FPS`)
    if (v.codec) video.push(v.codec)
    if (v.bitrate) video.push(`~${(v.bitrate / 1_000_000).toFixed(1)} Mbps`)
  }
  const a = selected.audio ?? (selected.muxed ? selected.video : null)
  if (a) {
    if (a.codec && !selected.muxed) audio.push(a.codec)
    if (a.sampleRate) audio.push(`${Math.round(a.sampleRate / 1000)} kHz`)
    if (a.channels) audio.push(a.channels === 2 ? 'Stereo' : `${a.channels} ch`)
    if (a.bitrate && !selected.muxed) audio.push(`~${Math.round(a.bitrate / 1000)} kbps`)
  }
  return { video, audio }
}

/**
 * Pick a stream the app's own `<video>` element can play, so every platform is
 * previewed through one native player rather than an embedded platform UI.
 *
 * Preference order:
 *   1. HLS  — Twitch/Kick deliver muxed variants; hls.js seeks precisely.
 *   2. Progressive muxed MP4 — YouTube's itag 18/22 style formats.
 * Adaptive video-only streams are deliberately excluded: they have no audio and
 * would need MSE assembly, which is not what the preview is for.
 */
export interface PreviewStream {
  url: string
  kind: 'hls' | 'progressive'
  label: string
  height?: number
  hasAudio: boolean
}

export function selectPreviewStream(formats: StreamInfo[]): PreviewStream | null {
  const hls = formats
    .filter((f) => f.protocol === 'hls' && f.hasVideo && f.url)
    .sort(rankVideo)[0]
  if (hls) {
    return {
      url: hls.url,
      kind: 'hls',
      label: hls.label,
      height: hls.height,
      hasAudio: hls.hasAudio
    }
  }

  // Muxed progressive: video *and* audio in one plain HTTP file.
  const progressive = formats
    .filter((f) => f.protocol === 'http-range' && f.hasVideo && f.hasAudio && f.url)
    .sort(rankVideo)[0]
  if (progressive) {
    return {
      url: progressive.url,
      kind: 'progressive',
      label: progressive.label,
      height: progressive.height,
      hasAudio: true
    }
  }

  return null
}
