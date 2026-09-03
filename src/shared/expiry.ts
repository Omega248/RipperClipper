import type { PlatformId } from './types.js'

/**
 * How long a broadcast stays up — the clock this whole workflow runs against.
 *
 * Twitch deletes VODs after a couple of weeks. That single fact reshapes the
 * job: a scene from three weeks ago may already be half-gone, and the POVs
 * you can still get are the ones worth grabbing *now*. Kick keeps recordings
 * far longer, and YouTube keeps them indefinitely, so the urgency is entirely
 * platform-shaped and worth showing per POV rather than as a general warning.
 *
 * These are the published retention policies, not measurements, so everything
 * here is explicitly an estimate — `certain: false` — and the UI says so. The
 * point is to rank what is at risk, never to promise a deletion date.
 */

export interface RetentionPolicy {
  /** Days a recording is normally kept. Null when it is effectively forever. */
  days: number | null
  /** What actually decides it, shown to the editor rather than hidden. */
  note: string
}

/**
 * Twitch's floor is 14 days; Partners, Turbo and Prime get 60. Which of those
 * applies to a given channel is not something the app can know, so the
 * shorter one is assumed: warning early about a VOD that turns out to last
 * longer costs nothing, while assuming 60 and being wrong loses the footage.
 */
export const RETENTION: Record<PlatformId, RetentionPolicy> = {
  twitch: { days: 14, note: 'Twitch keeps VODs 14 days, or 60 for Partner/Turbo/Prime.' },
  kick: { days: 365, note: 'Kick keeps recordings for a long time, but not forever.' },
  youtube: { days: null, note: 'YouTube keeps uploads until the channel removes them.' }
}

export type ExpiryUrgency = 'gone' | 'critical' | 'soon' | 'safe' | 'permanent' | 'unknown'

export interface ExpiryEstimate {
  urgency: ExpiryUrgency
  /** Days left, rounded down. Null when permanent or unknown. */
  daysLeft: number | null
  /**
   * Hours left, rounded down. Null when permanent or unknown.
   *
   * Under a week the hours are the decision: "2d 04h" and "2d 22h" are
   * different answers to "can this wait until tomorrow".
   */
  hoursLeft: number | null
  /** Always false here: these are policies, not per-VOD facts. */
  certain: boolean
  label: string
  note: string
}

/** Under this many days left, a POV is worth grabbing before anything else. */
const CRITICAL_DAYS = 3
const SOON_DAYS = 7

/**
 * How long this broadcast probably has left.
 *
 * `publishedAt` is when it was recorded. A VOD with no known date cannot be
 * placed on the clock at all, which is reported as `unknown` rather than
 * guessed — an invented deadline is worse than none.
 */
export function estimateExpiry(
  platform: PlatformId,
  publishedAt: string | null | undefined,
  now: number = Date.now()
): ExpiryEstimate {
  const policy = RETENTION[platform]

  if (policy.days === null) {
    return {
      urgency: 'permanent',
      daysLeft: null,
      hoursLeft: null,
      certain: false,
      label: 'Stays up',
      note: policy.note
    }
  }

  const started = publishedAt ? Date.parse(publishedAt) : NaN
  if (!Number.isFinite(started)) {
    return {
      urgency: 'unknown',
      daysLeft: null,
      hoursLeft: null,
      certain: false,
      label: 'Unknown age',
      note: `${policy.note} This broadcast's date is unknown, so nothing can be said about it.`
    }
  }

  const ageDays = (now - started) / 86_400_000
  const left = Math.floor(policy.days - ageDays)

  if (left <= 0) {
    return {
      urgency: 'gone',
      daysLeft: 0,
      hoursLeft: 0,
      certain: false,
      label: 'May already be gone',
      note: `${policy.note} This one is past that window — grab it now if it is still there.`
    }
  }

  const urgency: ExpiryUrgency = left <= CRITICAL_DAYS ? 'critical' : left <= SOON_DAYS ? 'soon' : 'safe'
  return {
    urgency,
    daysLeft: left,
    hoursLeft: Math.floor((policy.days - ageDays) * 24),
    certain: false,
    label: left === 1 ? 'About 1 day left' : `About ${left} days left`,
    note: policy.note
  }
}

/** Sorts the most-at-risk first, so what to archive next is obvious. */
export function byUrgency(a: ExpiryEstimate, b: ExpiryEstimate): number {
  const rank: Record<ExpiryUrgency, number> = {
    gone: 0,
    critical: 1,
    soon: 2,
    unknown: 3,
    safe: 4,
    permanent: 5
  }
  const diff = rank[a.urgency] - rank[b.urgency]
  if (diff !== 0) return diff
  return (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity)
}

/** True when this POV is worth archiving before doing anything else. */
export function atRisk(estimate: ExpiryEstimate): boolean {
  return estimate.urgency === 'gone' || estimate.urgency === 'critical' || estimate.urgency === 'soon'
}

/**
 * Column form: "18h", "2d 04h", "9d".
 *
 * The long `label` is for prose — a row that explains itself, a tooltip. This
 * one is for the aligned expiry column on the Backlog and the VODs list, where
 * the whole point is that the eye can run straight down it. An unknown date is
 * an em dash rather than a blank: a VOD nobody can place on the clock is a
 * thing to go and check, not a thing to hide.
 */
export function expiryShort(estimate: ExpiryEstimate): string {
  if (estimate.urgency === 'permanent') return '∞'
  if (estimate.urgency === 'unknown') return '—'
  if (estimate.urgency === 'gone') return 'gone'

  const days = estimate.daysLeft ?? 0
  if (days >= 7) return `${days}d`
  if (days >= 1) {
    const hours = Math.max(0, Math.floor((estimate.hoursLeft ?? days * 24) % 24))
    return `${days}d ${String(hours).padStart(2, "0")}h`
  }
  return `${estimate.hoursLeft ?? 0}h`
}
