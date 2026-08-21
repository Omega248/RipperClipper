import { isSynced, localToEvent, mapEventRangeToPov } from './sync.js'
import type { Coverage, PovRange } from './sync.js'
import type { ClipPovMapping, ClipSegment, PovClipStatus, VodSource } from './types.js'
import { roundMs } from './time.js'

/**
 * Clip ↔ POV mapping.
 *
 * A clip owns a real-world range; a POV's local range for that clip is a
 * projection of it through that POV's sync mapping. Those projections are
 * *materialised* onto the clip (`povMappings`) so a clip is a complete
 * multi-POV object the moment it is created and stays one on disk — but they
 * are always recomputed from the event time by `refreshClipMappings`, never
 * edited in place. Event time is the single source of truth; the stored
 * mappings are its current shadow, refreshed whenever a POV is added, removed
 * or re-synced, which is what lets a POV found days later join every existing
 * clip without anything being recreated.
 */

export interface ClipPovRange extends PovRange {
  clipId: string
  sourceId: string
  /** True for the POV the clip was authored from: its range is exact, not derived. */
  authored: boolean
  /** Per-clip hand correction applied on top of the POV's own mapping. */
  offsetSeconds: number
}

/** Where this clip sits in one POV. */
export function clipRangeInPov(clip: ClipSegment, source: VodSource): ClipPovRange {
  const base = { clipId: clip.id, sourceId: source.id }

  // The authoring POV keeps the editor's own numbers — deriving them back
  // through the mapping would introduce rounding the editor never asked for.
  if (source.id === clip.sourceId) {
    return {
      ...base,
      authored: true,
      offsetSeconds: 0,
      vodId: source.id,
      localStart: clip.startSeconds,
      localEnd: clip.endSeconds,
      requestedLocalStart: clip.startSeconds,
      requestedLocalEnd: clip.endSeconds,
      coverage: 'full',
      confidence: source.syncMapping?.confidence ?? 1,
      method: source.syncMapping?.method ?? 'manual'
    }
  }

  const mapping = source.syncMapping
  if (
    clip.eventStartTime === null ||
    clip.eventStartTime === undefined ||
    clip.eventEndTime === null ||
    clip.eventEndTime === undefined ||
    !mapping ||
    !isSynced(mapping)
  ) {
    return {
      ...base,
      authored: false,
      offsetSeconds: clip.povOffsets?.[source.id] ?? 0,
      vodId: source.id,
      localStart: 0,
      localEnd: 0,
      requestedLocalStart: 0,
      requestedLocalEnd: 0,
      coverage: 'unknown',
      confidence: mapping?.confidence ?? 0,
      method: mapping?.method ?? 'unsynced'
    }
  }

  // A per-clip correction shifts this POV for THIS clip only: the event range
  // is untouched, so every other clip keeps the alignment it already had.
  const nudge = clip.povOffsets?.[source.id] ?? 0
  const range = mapEventRangeToPov(
    mapping,
    source.durationSeconds,
    clip.eventStartTime + nudge,
    clip.eventEndTime + nudge
  )
  return { ...range, ...base, authored: false, offsetSeconds: nudge }
}

/** Every POV's take on one clip, in project order. */
export function clipPovRanges(clip: ClipSegment, sources: VodSource[]): ClipPovRange[] {
  return sources.map((source) => clipRangeInPov(clip, source))
}

export interface CoverageSummary {
  full: number
  partial: number
  none: number
  unknown: number
  /** POVs that show at least part of the clip. */
  usable: number
}

export function coverageSummary(ranges: ClipPovRange[]): CoverageSummary {
  const count = (c: Coverage): number => ranges.filter((r) => r.coverage === c).length
  const full = count('full')
  const partial = count('partial')
  return { full, partial, none: count('none'), unknown: count('unknown'), usable: full + partial }
}

/** Real-world range for a clip authored in a POV, when that POV is synced. */
export function eventRangeFor(
  source: VodSource | null | undefined,
  startSeconds: number,
  endSeconds: number
): { eventStartTime: number | null; eventEndTime: number | null } {
  if (!source?.syncMapping || !isSynced(source.syncMapping)) {
    return { eventStartTime: null, eventEndTime: null }
  }
  return {
    eventStartTime: localToEvent(source.syncMapping, startSeconds),
    eventEndTime: localToEvent(source.syncMapping, endSeconds)
  }
}

export interface ExportPart {
  source: VodSource
  startSeconds: number
  endSeconds: number
  /** Safety head/tail actually applied, in seconds. */
  paddingSeconds: number
}

export interface ExportPlan {
  video: ExportPart
  audio?: ExportPart
  /** Anything the editor should know before the file is written. */
  warnings: string[]
}

/**
 * Alignment good enough to cut on without a safety margin. Anything less and
 * the export is padded rather than risking a clip that starts after the moment.
 */
export const TRUSTED_CONFIDENCE = 0.9

/** A hand-aligned POV is trusted; a guessed one gets padding. */
export function needsPadding(range: ClipPovRange): boolean {
  if (range.authored) return false
  if (range.method === 'manual') return false
  return range.confidence < TRUSTED_CONFIDENCE
}

/**
 * Which media actually gets cut for a clip: the chosen video POV, plus a
 * separate audio POV when one is set. Falls back to the authoring POV rather
 * than silently exporting a POV that cannot cover the range.
 */
export function planExport(
  clip: ClipSegment,
  sources: VodSource[],
  opts: { paddingSeconds?: number } = {}
): ExportPlan | null {
  const padding = opts.paddingSeconds ?? 0
  const warnings: string[] = []
  const authoring = sources.find((s) => s.id === clip.sourceId)

  const pick = (id: string | undefined, role: 'video' | 'audio'): ExportPart | null => {
    const source = sources.find((s) => s.id === (id ?? clip.sourceId))
    if (!source) return null
    const range = clipRangeInPov(clip, source)
    if (range.coverage === 'none' || range.coverage === 'unknown') {
      warnings.push(
        `${source.title} does not cover this clip (${range.coverage}), so the ${role} came from ${
          authoring?.title ?? 'the original POV'
        } instead.`
      )
      return null
    }
    if (range.coverage === 'partial') {
      warnings.push(
        `${source.title} only covers part of this clip; the ${role} is the ${roundMs(
          range.localEnd - range.localStart
        )}s that exist.`
      )
    }

    // Where the alignment is a guess rather than a hand-checked fact, take a
    // little extra either side: a clip that starts a second late has lost the
    // moment, while a clip with a second of run-up is still usable.
    const pad = needsPadding(range) ? Math.max(0, padding) : 0
    const start = Math.max(0, roundMs(range.localStart - pad))
    const end = Math.min(source.durationSeconds, roundMs(range.localEnd + pad))
    if (pad > 0) {
      warnings.push(
        `${source.title} is aligned to ${Math.round(range.confidence * 100)}% confidence, so the ${role} was padded by ${pad}s at each end. Line it up in Manual sync to cut it tight.`
      )
    }
    return { source, startSeconds: start, endSeconds: end, paddingSeconds: pad }
  }

  const video = pick(clip.videoSourceId, 'video') ?? (authoring ? pick(authoring.id, 'video') : null)
  if (!video) return null

  const audioId = clip.audioSourceId
  if (!audioId || audioId === video.source.id) return { video, warnings }

  const audio = pick(audioId, 'audio')
  return audio ? { video, audio, warnings } : { video, warnings }
}

/** Below this, the editor is told to check the timing rather than trust it. */
export const LOW_CONFIDENCE = 0.7

export function povStatusFor(range: ClipPovRange): PovClipStatus {
  if (range.authored) return 'available'
  if (range.coverage === 'unknown') return 'sync_required'
  if (range.coverage === 'none') return 'out_of_range'
  if (range.confidence < LOW_CONFIDENCE) return 'sync_low_confidence'
  return range.coverage === 'partial' ? 'partial' : 'available'
}

/**
 * Every loaded POV's mapping for one clip, built in a single pass.
 *
 * This is what makes clip creation atomic: the clip and its complete POV set
 * are produced together, so a clip never exists in a half-attached state.
 * `nowIso` is passed in rather than read from the clock so the result is
 * deterministic in tests.
 */
export function buildClipMappings(
  clip: Pick<ClipSegment, 'id' | 'sourceId' | 'startSeconds' | 'endSeconds' | 'eventStartTime' | 'eventEndTime'>,
  sources: VodSource[],
  nowIso: string
): ClipPovMapping[] {
  return sources.map((source) => {
    const range = clipRangeInPov(clip as ClipSegment, source)
    const status = povStatusFor(range)
    const covers = status !== 'out_of_range' && status !== 'sync_required'

    /*
     * Picture and sound for this POV. They share the range because they are
     * the same seconds of the same recording; what can differ is whether the
     * source offers that stream at all. A POV the editor cannot take sound
     * from should say so here rather than failing at export.
     */
    const span = { startSeconds: range.localStart, endSeconds: range.localEnd }
    const none = { available: false, startSeconds: 0, endSeconds: 0 }

    return {
      sourceId: source.id,
      vodStartSeconds: range.localStart,
      vodEndSeconds: range.localEnd,
      requestedStartSeconds: range.requestedLocalStart,
      requestedEndSeconds: range.requestedLocalEnd,
      status,
      confidence: range.confidence,
      method: range.method,
      authored: range.authored,
      updatedAt: nowIso,
      media: {
        video: covers && sourceHasVideo(source) ? { available: true, ...span } : none,
        audio: covers && sourceHasAudio(source) ? { available: true, ...span } : none
      }
    }
  })
}

/**
 * Whether a source offers a stream at all.
 *
 * Formats are only known once a source has actually been inspected, and
 * Ripper Clipper never guesses what a platform offers. Until then both are
 * assumed present, which is true of every VOD the app can load — the point of
 * these flags is the case where inspection has happened and come back short.
 */
export function sourceHasVideo(source: VodSource): boolean {
  if (!source.formatsInspected || !source.formats?.length) return true
  return source.formats.some((f) => f.hasVideo)
}

export function sourceHasAudio(source: VodSource): boolean {
  if (!source.formatsInspected || !source.formats?.length) return true
  return source.formats.some((f) => f.hasAudio)
}

/** Every POV that can supply this clip's sound, in project order. */
export function audioCapablePovs(clip: ClipSegment, sources: VodSource[]): VodSource[] {
  const mappings = clip.povMappings ?? buildClipMappings(clip, sources, new Date().toISOString())
  return sources.filter((source) =>
    mappings.some((m) => m.sourceId === source.id && m.media?.audio.available)
  )
}

/** Every POV that can supply this clip's picture, in project order. */
export function videoCapablePovs(clip: ClipSegment, sources: VodSource[]): VodSource[] {
  const mappings = clip.povMappings ?? buildClipMappings(clip, sources, new Date().toISOString())
  return sources.filter((source) =>
    mappings.some((m) => m.sourceId === source.id && m.media?.video.available)
  )
}

/** Which POV(s) a clip exports as — chosen per row on the Export page, or all at once. */
export type PovExportMode =
  | { kind: 'main' }
  | { kind: 'all' }
  | { kind: 'certain'; sourceIds: Set<string> }

/**
 * Turns each target clip into one or more POV-specific variants per its
 * chosen export mode. A variant's id is suffixed by source so a clip
 * exported from several POVs at once doesn't collide on the clip list's own
 * status tracking, which keys off the plain clip id — the same trick "export
 * every POV" already used before this existed as a per-clip choice.
 */
export function expandClipsForExport(
  targets: ClipSegment[],
  sources: VodSource[],
  modeFor: (clipId: string) => PovExportMode
): ClipSegment[] {
  const out: ClipSegment[] = []
  for (const clip of targets) {
    const mode = modeFor(clip.id)
    if (mode.kind === 'main') {
      out.push(clip)
      continue
    }
    const candidates = videoCapablePovs(clip, sources)
    const picked = mode.kind === 'all' ? candidates : candidates.filter((s) => mode.sourceIds.has(s.id))
    if (picked.length === 0) {
      out.push(clip)
      continue
    }
    for (const source of picked) {
      out.push({ ...clip, id: `${clip.id}-${source.id}`, videoSourceId: source.id, audioSourceId: undefined })
    }
  }
  return out
}

/**
 * Rebuild every clip's POV set. Called whenever the POV list or a sync mapping
 * changes — adding a POV, removing one, or correcting timing — so the stored
 * mappings can never disagree with the event timeline they came from.
 */
export function refreshClipMappings(
  clips: ClipSegment[],
  sources: VodSource[],
  nowIso: string
): ClipSegment[] {
  return clips.map((clip) => ({ ...clip, povMappings: buildClipMappings(clip, sources, nowIso) }))
}

/** The POVs that can actually be used for this clip, best coverage first. */
export function usableMappings(clip: ClipSegment): ClipPovMapping[] {
  return (clip.povMappings ?? []).filter(
    (m) => m.status === 'available' || m.status === 'partial' || m.status === 'sync_low_confidence'
  )
}

export const POV_STATUS_LABEL: Record<PovClipStatus, string> = {
  available: 'Available',
  partial: 'Partial',
  out_of_range: 'Out of range',
  sync_required: 'Sync required',
  sync_low_confidence: 'Low confidence'
}
