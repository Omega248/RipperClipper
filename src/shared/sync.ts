/**
 * Real-world event synchronisation.
 *
 * THE EVENT TIMELINE IS THE SOURCE OF TRUTH. Every POV is mapped onto a single
 * real-world clock (epoch seconds), and every clip is stored in event time.
 * A POV's local VOD timestamp is always *derived*:
 *
 *     eventTime = vodStartRealTime + localTime + offset + drift * localTime
 *     localTime = (eventTime - vodStartRealTime - offset) / (1 + drift)
 *
 * Storing clips this way is what lets a POV discovered days later inherit every
 * existing clip without the editor recreating anything.
 *
 * Everything here is pure so it can be unit tested without media or network.
 */

export type SyncMethod =
  | 'platform_metadata'
  | 'api_metadata'
  | 'media_metadata'
  | 'upload_metadata'
  | 'event_anchor'
  | 'transcript_anchor'
  | 'manual'
  | 'unsynced'

/** How reliable each method is on its own, before anchors refine it. */
export const METHOD_BASE_CONFIDENCE: Record<SyncMethod, number> = {
  platform_metadata: 0.95,
  api_metadata: 0.95,
  media_metadata: 0.8,
  upload_metadata: 0.6,
  event_anchor: 0.9,
  transcript_anchor: 0.75,
  manual: 1,
  unsynced: 0
}

export const METHOD_LABEL: Record<SyncMethod, string> = {
  platform_metadata: 'Platform broadcast metadata',
  api_metadata: 'Platform API metadata',
  media_metadata: 'Media container timestamps',
  upload_metadata: 'Upload metadata',
  event_anchor: 'Event anchor',
  transcript_anchor: 'Transcript alignment',
  manual: 'Manual',
  unsynced: 'Not synchronised'
}

/**
 * A confirmed correspondence between a real-world instant and a POV's local
 * VOD time. Anchors come from metadata, confirmed clips, manual pairing,
 * transcript matches or audio events, and are the evidence that survives.
 */
export interface SyncAnchor {
  id: string
  vodId: string
  /** Real-world instant, epoch seconds. */
  eventTime: number
  /** Local VOD time in seconds at that instant. */
  localTime: number
  source: SyncMethod
  /** 0..1 — how much this anchor should be trusted. */
  weight: number
  createdAt: string
  note?: string
}

export interface VodTimeMapping {
  vodId: string
  /**
   * Real-world epoch seconds at local time 0 — the moment the recording
   * started, per the strongest source available.
   */
  vodStartRealTime: number | null
  /** Correction applied on top of vodStartRealTime, in seconds. */
  offsetSeconds: number
  /**
   * Clock drift as a rate (seconds gained per second of VOD). Usually 0;
   * derived only when several anchors disagree consistently across time.
   */
  driftRate: number
  confidence: number
  method: SyncMethod
  anchorIds: string[]
  lastValidatedAt: string | null
  /** Set when the automatic result is uncertain and the editor should look. */
  warnings: string[]
}

export function unsyncedMapping(vodId: string): VodTimeMapping {
  return {
    vodId,
    vodStartRealTime: null,
    offsetSeconds: 0,
    driftRate: 0,
    confidence: 0,
    method: 'unsynced',
    anchorIds: [],
    lastValidatedAt: null,
    warnings: ['No real-world start time is known for this POV yet.']
  }
}

export function isSynced(mapping: VodTimeMapping | undefined | null): boolean {
  return Boolean(mapping && mapping.vodStartRealTime !== null && mapping.method !== 'unsynced')
}

/** Local VOD seconds → real-world epoch seconds. Null when unsynced. */
export function localToEvent(mapping: VodTimeMapping, localTime: number): number | null {
  if (mapping.vodStartRealTime === null) return null
  return round3(
    mapping.vodStartRealTime + localTime + mapping.offsetSeconds + mapping.driftRate * localTime
  )
}

/** Real-world epoch seconds → local VOD seconds. Null when unsynced. */
export function eventToLocal(mapping: VodTimeMapping, eventTime: number): number | null {
  if (mapping.vodStartRealTime === null) return null
  const base = eventTime - mapping.vodStartRealTime - mapping.offsetSeconds
  return round3(base / (1 + mapping.driftRate))
}

export type Coverage = 'full' | 'partial' | 'none' | 'unknown'

export interface PovRange {
  vodId: string
  /** Local VOD seconds. Clamped to the POV when coverage is partial. */
  localStart: number
  localEnd: number
  /** The requested range before clamping, for display. */
  requestedLocalStart: number
  requestedLocalEnd: number
  coverage: Coverage
  confidence: number
  method: SyncMethod
}

/**
 * Map an event range onto one POV, reporting honestly how much of the event
 * that POV actually covers. Never invents coverage.
 */
export function mapEventRangeToPov(
  mapping: VodTimeMapping,
  durationSeconds: number,
  eventStart: number,
  eventEnd: number
): PovRange {
  const vodId = mapping.vodId
  if (!isSynced(mapping) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return {
      vodId,
      localStart: 0,
      localEnd: 0,
      requestedLocalStart: 0,
      requestedLocalEnd: 0,
      coverage: 'unknown',
      confidence: mapping.confidence,
      method: mapping.method
    }
  }

  const rawStart = eventToLocal(mapping, eventStart)!
  const rawEnd = eventToLocal(mapping, eventEnd)!

  const clampedStart = Math.max(0, Math.min(durationSeconds, rawStart))
  const clampedEnd = Math.max(0, Math.min(durationSeconds, rawEnd))
  const overlap = Math.max(0, clampedEnd - clampedStart)
  const requested = Math.max(0, rawEnd - rawStart)

  let coverage: Coverage
  if (overlap <= 0.001) coverage = 'none'
  else if (overlap >= requested - 0.05) coverage = 'full'
  else coverage = 'partial'

  return {
    vodId,
    localStart: round3(clampedStart),
    localEnd: round3(clampedEnd),
    requestedLocalStart: round3(rawStart),
    requestedLocalEnd: round3(rawEnd),
    coverage,
    confidence: mapping.confidence,
    method: mapping.method
  }
}

/** The same instant in every synced POV — the "Find in all POVs" result. */
export interface PovMoment {
  vodId: string
  localTime: number
  /** True when the instant lies inside this POV's recording. */
  withinVod: boolean
  confidence: number
  method: SyncMethod
}

export function findMomentInPovs(
  eventTime: number,
  povs: Array<{ mapping: VodTimeMapping; durationSeconds: number }>
): PovMoment[] {
  const out: PovMoment[] = []
  for (const pov of povs) {
    if (!isSynced(pov.mapping)) continue
    const local = eventToLocal(pov.mapping, eventTime)!
    out.push({
      vodId: pov.mapping.vodId,
      localTime: round3(local),
      withinVod: local >= 0 && local <= pov.durationSeconds,
      confidence: pov.mapping.confidence,
      method: pov.mapping.method
    })
  }
  return out
}

// ------------------------------------------------------------ solving ----

export interface TimingEvidence {
  /** Epoch seconds the recording started, from the strongest source found. */
  startRealTime: number | null
  method: SyncMethod
}

export interface SolveInput {
  vodId: string
  durationSeconds: number
  evidence: TimingEvidence
  anchors: SyncAnchor[]
  /** Existing mapping, so a manual correction is never silently discarded. */
  previous?: VodTimeMapping
}

/**
 * Derive a POV's mapping from its metadata plus every anchor that references
 * it. Two or more anchors spread over time reveal drift; a single anchor gives
 * a constant offset; no anchors falls back to metadata alone.
 */
export function solveMapping(input: SolveInput): VodTimeMapping {
  const { vodId, evidence, previous } = input
  const anchors = input.anchors.filter((a) => a.vodId === vodId).sort((a, b) => a.localTime - b.localTime)

  // A manual mapping is authoritative until the editor changes it.
  if (previous?.method === 'manual' && previous.vodStartRealTime !== null) {
    return { ...previous, anchorIds: anchors.map((a) => a.id), lastValidatedAt: nowIso() }
  }

  const warnings: string[] = []

  // Anchors imply a real start time even with no usable metadata.
  const base =
    evidence.startRealTime ??
    (anchors.length > 0 ? anchors[0].eventTime - anchors[0].localTime : null)

  if (base === null) {
    return { ...unsyncedMapping(vodId), anchorIds: anchors.map((a) => a.id) }
  }

  let method: SyncMethod = evidence.startRealTime !== null ? evidence.method : 'event_anchor'
  let offset = 0
  let driftRate = 0
  let confidence = METHOD_BASE_CONFIDENCE[method]

  if (anchors.length === 1) {
    const a = anchors[0]
    offset = a.eventTime - (base + a.localTime)
    method = evidence.startRealTime !== null ? 'event_anchor' : method
    // One anchor pins the offset but cannot reveal drift, so it stays below the
    // confidence a corroborating set of anchors earns.
    confidence = Math.min(0.93, Math.max(confidence, METHOD_BASE_CONFIDENCE[a.source] * 0.95) + 0.02)
    if (Math.abs(offset) > 120) {
      warnings.push(
        `The anchor disagrees with the platform's start time by ${offset.toFixed(1)}s — worth checking.`
      )
      confidence = Math.min(confidence, 0.7)
    }
  } else if (anchors.length >= 2) {
    // Weighted least squares of residual against localTime gives offset + drift.
    const points = anchors.map((a) => ({
      x: a.localTime,
      y: a.eventTime - (base + a.localTime),
      w: Math.max(0.05, a.weight)
    }))
    const fit = weightedLinearFit(points)
    offset = fit.intercept
    driftRate = fit.slope
    method = 'event_anchor'

    const spread = points[points.length - 1].x - points[0].x
    // Drift is only believable when the anchors are far enough apart.
    if (spread < 60 || Math.abs(driftRate) < 1e-6) {
      driftRate = 0
      offset = weightedMean(points.map((p) => ({ v: p.y, w: p.w })))
    }

    const residuals = points.map((p) => Math.abs(p.y - (offset + driftRate * p.x)))
    const worst = Math.max(...residuals)
    confidence = Math.min(1, 0.9 + Math.min(0.09, anchors.length * 0.02))
    if (worst > 2) {
      warnings.push(
        `Anchors disagree by up to ${worst.toFixed(2)}s — synchronisation may be approximate.`
      )
      confidence = Math.max(0.5, confidence - Math.min(0.35, worst / 20))
    }
    if (driftRate !== 0) {
      warnings.push(
        `Clock drift of ${(driftRate * 3600).toFixed(1)}s per hour was detected and is being corrected.`
      )
    }
  }

  if (evidence.startRealTime === null) {
    warnings.push('Synchronised from anchors only; no platform start time was available.')
  }

  return {
    vodId,
    vodStartRealTime: round3(base),
    offsetSeconds: round3(offset),
    driftRate,
    confidence: round3(Math.max(0, Math.min(1, confidence))),
    method,
    anchorIds: anchors.map((a) => a.id),
    lastValidatedAt: nowIso(),
    warnings
  }
}

/**
 * Compare a freshly solved mapping with the one currently in use. Material
 * changes must be surfaced rather than silently moving the editor's clips.
 */
export interface MappingChange {
  vodId: string
  previous: VodTimeMapping
  next: VodTimeMapping
  /** How far an existing clip would move, in seconds. */
  shiftSeconds: number
  material: boolean
}

export function compareMappings(
  previous: VodTimeMapping,
  next: VodTimeMapping,
  sampleLocalTime = 0
): MappingChange {
  const before = localToEvent(previous, sampleLocalTime)
  const after = localToEvent(next, sampleLocalTime)
  const shift = before === null || after === null ? 0 : Math.abs(after - before)
  return {
    vodId: next.vodId,
    previous,
    next,
    shiftSeconds: round3(shift),
    // Half a second is roughly where a viewer starts to notice a cut moving.
    material: before !== null && after !== null && shift > 0.5
  }
}

/**
 * Build an anchor set from a confirmed cross-POV correspondence — e.g. the
 * editor says "this moment in A is this moment in B".
 */
export function anchorsFromPairing(
  pairing: Array<{ vodId: string; localTime: number }>,
  eventTime: number,
  source: SyncMethod,
  makeId: (prefix: string) => string,
  weight = 1
): SyncAnchor[] {
  const createdAt = nowIso()
  return pairing.map((p) => ({
    id: makeId('anchor'),
    vodId: p.vodId,
    eventTime: round3(eventTime),
    localTime: round3(p.localTime),
    source,
    weight,
    createdAt
  }))
}

/** Overall coverage of an event window across every POV. */
export function eventCoverageSummary(ranges: PovRange[]): {
  full: number
  partial: number
  none: number
  unknown: number
} {
  const summary = { full: 0, partial: 0, none: 0, unknown: 0 }
  for (const r of ranges) summary[r.coverage] += 1
  return summary
}

// ------------------------------------------------------------- maths ----

function weightedLinearFit(points: Array<{ x: number; y: number; w: number }>): {
  slope: number
  intercept: number
} {
  const sw = points.reduce((s, p) => s + p.w, 0)
  if (sw === 0) return { slope: 0, intercept: 0 }
  const mx = points.reduce((s, p) => s + p.w * p.x, 0) / sw
  const my = points.reduce((s, p) => s + p.w * p.y, 0) / sw
  let num = 0
  let den = 0
  for (const p of points) {
    num += p.w * (p.x - mx) * (p.y - my)
    den += p.w * (p.x - mx) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  return { slope, intercept: my - slope * mx }
}

function weightedMean(values: Array<{ v: number; w: number }>): number {
  const sw = values.reduce((s, x) => s + x.w, 0)
  if (sw === 0) return 0
  return values.reduce((s, x) => s + x.v * x.w, 0) / sw
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function nowIso(): string {
  return new Date().toISOString()
}
