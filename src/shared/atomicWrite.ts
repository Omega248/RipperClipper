/**
 * When a publish-by-rename should be tried again.
 *
 * The rules only, so they can be tested without needing a filesystem that
 * fails on demand — `projects.ts` supplies the rename and the sleeping.
 *
 * Renaming over an existing file is atomic on POSIX and simply succeeds. On
 * Windows it is not one indivisible operation, and it fails whenever anything
 * holds a handle to the target for an instant: the search indexer, a virus
 * scanner, or another of this app's own concurrent writes to the same path.
 * The failure is transient and asking again shortly works.
 *
 * This matters because everything durable the app owns is published this way —
 * projects, settings, the streamer library, the VOD library. A save that
 * silently did not happen is invisible until someone notices their work is
 * gone.
 */

/** Windows' transient "someone else has it open for a moment" codes. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])

export function isTransientRenameError(code: string | undefined): boolean {
  return code !== undefined && TRANSIENT.has(code)
}

/**
 * How many times to ask before giving up.
 *
 * Bounded on purpose: a lock that has not cleared in a fifth of a second is
 * not a scanner, and pretending otherwise turns a failed save into a hang.
 */
export const RENAME_ATTEMPTS = 5

/**
 * 10ms, 20, 40, 80 — long enough for a scanner to let go, short enough that
 * saving still feels instant.
 */
export function renameRetryDelayMs(attempt: number): number {
  return 10 * 2 ** Math.max(0, attempt)
}
