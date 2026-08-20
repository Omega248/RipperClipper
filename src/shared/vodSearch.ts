/**
 * Finding the VODs that were live at a given moment.
 *
 * A NoPixel event happens at a wall-clock time, not at a VOD timestamp, so the
 * natural way to gather POVs is "who was streaming at 22:17 last Tuesday". A
 * VOD covers an instant when it started before it and ended after it.
 */

export interface SearchableVod {
  url: string
  title: string
  /** ISO 8601, or null when the platform did not say. */
  publishedAt: string | null
  durationSeconds: number | null
}

export interface VodAtTime<T extends SearchableVod = SearchableVod> {
  vod: T
  /** Seconds into the VOD where that instant falls. */
  offsetSeconds: number
  /**
   * True when the VOD's length is known and the instant is inside it. False
   * means it started before the instant but we cannot prove it was still
   * running — worth showing, clearly marked, rather than hiding.
   */
  certain: boolean
}

/** Milliseconds either side of a VOD still treated as "around" this moment. */
export const NEAR_MS = 5 * 60_000

/**
 * VODs covering `whenMs`, closest start first.
 *
 * A VOD with no known duration is included when it started within `maxLeadMs`
 * before the instant, but reported as uncertain: platforms often omit the
 * length of a recent broadcast, and dropping those would hide exactly the POVs
 * an editor is hunting for.
 */
export function vodsAtTime<T extends SearchableVod>(
  vods: T[],
  whenMs: number,
  maxLeadMs = 12 * 3600_000
): Array<VodAtTime<T>> {
  const out: Array<VodAtTime<T>> = []
  for (const vod of vods) {
    if (!vod.publishedAt) continue
    const started = Date.parse(vod.publishedAt)
    if (!Number.isFinite(started)) continue

    const lead = whenMs - started
    if (lead < -NEAR_MS) continue // the broadcast had not begun

    if (vod.durationSeconds !== null && vod.durationSeconds > 0) {
      if (lead > vod.durationSeconds * 1000 + NEAR_MS) continue // it had ended
      out.push({
        vod,
        offsetSeconds: Math.max(0, Math.round(lead / 1000)),
        certain: lead >= 0 && lead <= vod.durationSeconds * 1000
      })
      continue
    }

    if (lead > maxLeadMs) continue
    out.push({ vod, offsetSeconds: Math.max(0, Math.round(lead / 1000)), certain: false })
  }

  return out.sort((a, b) => a.offsetSeconds - b.offsetSeconds)
}

/** "2026-08-17T22:17" (a datetime-local value) → epoch ms in local time. */
export function parseLocalDateTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}
