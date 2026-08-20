import type { SerializedAppError } from './types.js'

/**
 * Every user-facing failure in the app is an AppError with a title and an
 * actionable message. Generic "something went wrong" is never surfaced.
 */
export class AppError extends Error {
  readonly code: string
  readonly title: string
  readonly retryable: boolean
  /** Technical detail for the log file — never rendered as the primary message. */
  readonly detail?: string

  constructor(init: {
    code: string
    title: string
    message: string
    retryable?: boolean
    detail?: string
    cause?: unknown
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'AppError'
    this.code = init.code
    this.title = init.title
    this.retryable = init.retryable ?? false
    this.detail = init.detail
  }

  toJSON(): SerializedAppError {
    return {
      code: this.code,
      title: this.title,
      message: this.message,
      retryable: this.retryable,
      detail: this.detail
    }
  }
}

export function serializeError(err: unknown): SerializedAppError {
  if (err instanceof AppError) return err.toJSON()
  if (err instanceof Error) {
    return {
      code: 'unexpected',
      title: 'Unexpected error',
      message: err.message || 'The operation failed for an unknown reason.',
      retryable: true,
      detail: err.stack
    }
  }
  return {
    code: 'unexpected',
    title: 'Unexpected error',
    message: String(err),
    retryable: true
  }
}

/** Catalogue of the errors the app can raise. Keeps wording consistent. */
export const Errors = {
  unsupportedUrl: (url: string) =>
    new AppError({
      code: 'unsupported-url',
      title: 'Unsupported link',
      message:
        'That link is not a Twitch, Kick or YouTube VOD address. Paste a full VOD URL, for example https://www.twitch.tv/videos/123456789.',
      detail: url
    }),

  invalidUrl: (url: string) =>
    new AppError({
      code: 'invalid-url',
      title: 'Invalid link',
      message: 'That text is not a valid web address. Check for typos and paste the full URL.',
      detail: url
    }),

  vodUnavailable: (detail?: string) =>
    new AppError({
      code: 'vod-unavailable',
      title: 'This broadcast is not available',
      message:
        'The recording could not be reached. It may have been deleted, made private, or expired — platforms remove VODs after a while.',
      detail
    }),

  authRequired: (platform: string, detail?: string) =>
    new AppError({
      code: 'auth-required',
      title: 'Sign-in required',
      message: `This ${platform} broadcast is only available to signed-in viewers. Sign in to ${platform} in your browser, then load it again.`,
      detail
    }),

  qualityUnavailable: (requested: string, detail?: string) =>
    new AppError({
      code: 'quality-unavailable',
      title: 'That quality is not offered',
      message: `This broadcast is not available in ${requested}. Choose a different quality, or use "Best available".`,
      detail
    }),

  downloadFailed: (detail?: string) =>
    new AppError({
      code: 'download-failed',
      title: 'The download was interrupted',
      message: 'The connection dropped before this clip finished. Retrying usually picks it up again.',
      retryable: true,
      detail
    }),

  resolverMissing: () =>
    new AppError({
      code: 'resolver-missing',
      title: 'Setup is not finished',
      message:
        'Ripper Clipper cannot open VOD links until setup finishes. Open Settings and press "Finish setup" — it downloads what it needs itself.',
      detail: 'yt-dlp executable not located'
    }),

  resolverFailed: (detail?: string) =>
    new AppError({
      code: 'resolver-failed',
      title: 'Could not read this VOD',
      message:
        'The broadcast could not be read. It may be private or deleted, or the platform may have changed how it serves recordings. Try again, and if it keeps failing use Settings → Setup to update.',
      retryable: true,
      detail
    }),

  /**
   * Kick puts its VOD API behind a bot check. yt-dlp only gets through it when
   * its impersonation support is installed, so a plain 403/404 from that API
   * usually means the resolver, not the VOD.
   */
  kickBlocked: (detail?: string) =>
    new AppError({
      code: 'kick-blocked',
      title: 'Kick turned the request away',
      message:
        'Kick blocked the request before Ripper Clipper could read the broadcast. Try again in a moment. If the broadcast is subscriber-only, sign in to Kick in your browser first so Ripper Clipper can use that session.',
      retryable: true,
      detail
    }),

  ffmpegMissing: () =>
    new AppError({
      code: 'ffmpeg-missing',
      title: 'Setup is not finished',
      message:
        'Ripper Clipper cannot export clips until setup finishes. Open Settings and press "Finish setup" — it downloads what it needs itself.',
      detail: 'ffmpeg executable not located'
    }),

  ffmpegFailed: (detail?: string) =>
    new AppError({
      code: 'ffmpeg-failed',
      title: 'The file could not be written',
      message:
        'Something went wrong while writing this clip. Retrying often works; if it does not, the technical details are in the log.',
      retryable: true,
      detail
    }),

  rangeUnsupported: (platform: string, why: string) =>
    new AppError({
      code: 'range-unsupported',
      title: 'Range download not supported',
      message: `${platform} does not expose a way to download an arbitrary time range for this VOD. ${why}`
    }),

  invalidRange: (reason: string) =>
    new AppError({
      code: 'invalid-range',
      title: 'Invalid selection',
      message: reason
    }),

  insufficientSpace: (needBytes: number, freeBytes: number, path: string) =>
    new AppError({
      code: 'insufficient-space',
      title: 'Not enough disk space',
      message: `This export needs about ${formatBytes(needBytes)} but only ${formatBytes(freeBytes)} is free on ${path}. Free some space or choose a different output folder.`
    }),

  outputNotWritable: (path: string, detail?: string) =>
    new AppError({
      code: 'output-not-writable',
      title: 'Output folder not writable',
      message: `Ripper Clipper cannot write to ${path}. Choose a different output folder or check the folder's permissions.`,
      detail
    }),

  projectCorrupt: (path: string, detail?: string) =>
    new AppError({
      code: 'project-corrupt',
      title: 'Project could not be opened',
      message: `${path} is not a readable Ripper Clipper project. If an autosave recovery copy exists, Ripper Clipper can open that instead.`,
      detail
    }),

  verificationFailed: (problems: string[]) =>
    new AppError({
      code: 'verification-failed',
      title: 'Exported file failed verification',
      message: `The output file was produced but does not look correct: ${problems.join('; ')}.`,
      retryable: true
    }),

  cancelled: () =>
    new AppError({
      code: 'cancelled',
      title: 'Cancelled',
      message: 'The job was cancelled before it finished.'
    })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
