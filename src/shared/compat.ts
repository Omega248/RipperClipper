/**
 * What the application player can actually decode.
 *
 * The player is Chromium, so this is Chromium's list — not a guess and not a
 * hope. Anything outside it needs the media turning into something playable
 * before it reaches the <video> element, which is what the preview pipeline is
 * for. Nothing here modifies a source; it only decides what has to happen.
 */

export type PreviewPlan =
  /** Play the source directly. */
  | 'native'
  /** Codecs are fine, the wrapper is not: copy the streams into fragmented MP4. */
  | 'remux'
  /** A codec the player cannot decode: re-encode a temporary preview. */
  | 'transcode'
  /** Nothing can be played — for example a video-only source with no picture. */
  | 'unsupported'

/** Video codecs Chromium decodes in a plain <video> element. */
const VIDEO_OK = ['h264', 'avc1', 'vp8', 'vp9', 'vp09', 'av1', 'av01', 'theora']
/** Everything else needs re-encoding: HEVC and friends are not portable. */
const VIDEO_BAD = ['hevc', 'h265', 'hvc1', 'mpeg4', 'mpeg2video', 'vc1', 'prores']
const AUDIO_OK = ['aac', 'mp4a', 'opus', 'vorbis', 'mp3', 'flac', 'pcm_s16le']
const AUDIO_BAD = ['ac3', 'eac3', 'dts', 'truehd', 'alac']

/** Containers a plain <video> element can demux. */
const CONTAINER_OK = ['mp4', 'mov', 'm4v', 'webm', 'matroska,webm', 'mov,mp4,m4a,3gp,3g2,mj2', 'ogg']

function has(list: string[], value: string | undefined): boolean {
  if (!value) return false
  const needle = value.toLowerCase()
  return list.some((entry) => needle.includes(entry))
}

export interface MediaShape {
  container?: string
  videoCodec?: string
  audioCodec?: string
  /** True when the file has no audio stream at all — normal for DASH video. */
  hasAudio?: boolean
  hasVideo?: boolean
}

export function classifyPreview(shape: MediaShape): { plan: PreviewPlan; reason: string } {
  if (shape.hasVideo === false) {
    return { plan: 'unsupported', reason: 'This source has no picture to preview.' }
  }
  if (has(VIDEO_BAD, shape.videoCodec)) {
    return {
      plan: 'transcode',
      reason: `The picture is ${shape.videoCodec}, which this player cannot decode; a temporary preview is made instead.`
    }
  }
  if (shape.videoCodec && !has(VIDEO_OK, shape.videoCodec)) {
    return {
      plan: 'transcode',
      reason: `The picture is ${shape.videoCodec}, which is not a format the player supports.`
    }
  }
  if (shape.audioCodec && (has(AUDIO_BAD, shape.audioCodec) || !has(AUDIO_OK, shape.audioCodec))) {
    return {
      plan: 'transcode',
      reason: `The sound is ${shape.audioCodec}, which this player cannot decode.`
    }
  }
  if (shape.container && !has(CONTAINER_OK, shape.container)) {
    return {
      plan: 'remux',
      reason: `The streams are playable but the ${shape.container} wrapper is not; they are copied into MP4 for preview.`
    }
  }
  return { plan: 'native', reason: 'Plays directly.' }
}

/** Human sentence for the UI, given what was decided. */
export function describePlan(plan: PreviewPlan): string {
  switch (plan) {
    case 'native':
      return 'Playing the source directly'
    case 'remux':
      return 'Repackaging this range for preview (no quality is lost)'
    case 'transcode':
      return 'Making a temporary preview of this range — the export still uses the original'
    case 'unsupported':
      return 'This source cannot be previewed'
  }
}
