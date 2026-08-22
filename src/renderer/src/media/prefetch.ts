import { clipRangeInPov } from '@shared/povMapping'
import type { ClipSegment, VodSource } from '@shared/types'

/**
 * Must match `PREVIEW_PAD_SECONDS` in `../player/usePlayerViewport.tsx`
 * exactly — not imported from there to avoid a circular import through
 * store.ts, which both this module and that one depend on. The two are kept
 * in sync by hand; a mismatch only costs a cache miss, never incorrect
 * playback, so it's safe if they ever drift.
 */
const PREVIEW_PAD_SECONDS = 5

/**
 * How far a filmstrip/waveform request reaches past a clip's own marked
 * range. Small trims that stay inside this margin are served from the same
 * cached fetch instead of asking the main process to run ffmpeg again — see
 * `masterRangeFor` in TimelineEditor.tsx, which this constant is shared with
 * so a fresh clip's prefetch and its first render land on the same cache key.
 */
export const MASTER_PAD_SECONDS = 3

export function frameCountFor(durationSeconds: number): number {
  return Math.max(4, Math.min(30, Math.round(durationSeconds / 3)))
}

export function bucketsFor(durationSeconds: number): number {
  return Math.max(60, Math.min(800, Math.round(durationSeconds * 6)))
}

const inFlight = new Set<string>()

/**
 * Warms the disk-backed filmstrip/waveform cache for a clip across every
 * loaded POV that covers it, the moment the clip exists — not when it's
 * first dragged onto the Editor's timeline. Fire-and-forget: a failure here
 * just means the Editor computes it lazily later, the same as before this
 * existed.
 */
/**
 * Reads every POV's cut of a clip in the background, so the censor list is
 * already populated by the time anyone opens it.
 *
 * Fire-and-forget and deliberately silent: this was never asked for, so a
 * POV that cannot be read must not interrupt anyone. The main process
 * skips POVs already read and returns false when no model is installed,
 * which is why this is safe to call on every clip change.
 */
export function analyseClipPovs(clip: ClipSegment, sources: VodSource[]): void {
  for (const source of sources) {
    const range = clipRangeInPov(clip, source)
    if (range.coverage === 'none' || range.coverage === 'unknown') continue
    void window.api
      .clipAnalyse({
        clipId: clip.id,
        source,
        startSeconds: range.localStart,
        endSeconds: range.localEnd
      })
      .catch(() => undefined)
  }
}

export function prefetchClipMedia(clip: ClipSegment, sources: VodSource[]): void {
  for (const source of sources) {
    const range = clipRangeInPov(clip, source)
    if (range.coverage === 'none') continue
    const start = Math.max(0, range.localStart - MASTER_PAD_SECONDS)
    const end = Math.min(source.durationSeconds, range.localEnd + MASTER_PAD_SECONDS)
    const duration = end - start
    if (!(duration > 0)) continue

    const waveKey = `wave:${source.id}:${start.toFixed(2)}:${end.toFixed(2)}`
    if (!inFlight.has(waveKey)) {
      inFlight.add(waveKey)
      window.api
        .audioPeaks({ source, startSeconds: start, endSeconds: end, buckets: bucketsFor(duration) })
        .catch(() => undefined)
        .finally(() => inFlight.delete(waveKey))
    }

    const thumbKey = `thumb:${source.id}:${start.toFixed(2)}:${end.toFixed(2)}`
    if (!inFlight.has(thumbKey)) {
      inFlight.add(thumbKey)
      window.api
        .filmstrip({ source, startSeconds: start, endSeconds: end, frameCount: frameCountFor(duration), width: 96 })
        .catch(() => undefined)
        .finally(() => inFlight.delete(thumbKey))
    }

    // A local, instantly-playable copy — the Editor's actual media source,
    // the way a normal editor works from ingested proxies rather than
    // re-streaming the original every time a cut lands on this POV. Padded
    // exactly the way `usePlayerViewport.buildPreview` pads an explicit
    // target, so the first untrimmed play of this clip hits this same file
    // instead of narrowly missing it and building a second, near-identical one.
    const previewStart = Math.max(0, range.localStart - PREVIEW_PAD_SECONDS)
    const previewEnd = Math.min(source.durationSeconds, range.localEnd + PREVIEW_PAD_SECONDS)
    const previewKey = `preview:${source.id}:${previewStart.toFixed(3)}:${previewEnd.toFixed(3)}`
    if (!inFlight.has(previewKey)) {
      inFlight.add(previewKey)
      window.api
        .previewMedia({ source, startSeconds: previewStart, endSeconds: previewEnd })
        .catch(() => undefined)
        .finally(() => inFlight.delete(previewKey))
    }
  }
}
