/**
 * Finding every POV of a real-world event, across every platform at once.
 *
 * The rule is the one the rest of the application already syncs by, applied to
 * discovery: a broadcast belongs to an event when the two overlap on the wall
 * clock. `coverageOf` in eventStreams.ts owns that arithmetic and is reused
 * here rather than restated — this module is about everything *around* it:
 * deciding which candidates are worth offering, how confident we are that a
 * given broadcast is really this event, and folding several platforms' very
 * different result shapes into one list the editor can act on.
 *
 * Nothing here performs IO. The main process gathers raw candidates from
 * whichever platform sources are actually reachable (see
 * main/services/discovery.ts) and hands them through these pure functions, so
 * relevance and confidence can be tested against fixtures instead of the
 * network.
 */

import { coverageOf } from './eventStreams.js'
import type { OverlapCoverage } from './eventStreams.js'
import type { SearchableVod } from './vodSearch.js'
import type { PlatformId } from './types.js'

/**
 * Where a candidate came from. Kept on the result because the honest answer
 * to "did you search all of Twitch?" is different per source, and the UI has
 * to be able to say so rather than implying a complete sweep.
 */
export type DiscoverySource =
  /** A channel already in the streamer library. */
  | 'library'
  /** A keyword/category search against the platform. */
  | 'search'
  /** Already loaded into this project as a POV. */
  | 'loaded'

export interface DiscoveryCandidate extends SearchableVod {
  platform: PlatformId
  /** Channel handle as the platform spells it, without a leading @. */
  channelHandle: string
  /** Display name, when the platform gave one distinct from the handle. */
  channelName?: string
  thumbnailUrl?: string
  viewCount?: number
  /** Free-text tags/category the platform reported, when it reported any. */
  tags?: string[]
  category?: string
  source: DiscoverySource
  /** Set when this candidate is already a POV in the project. */
  sourceId?: string
  /** The saved streamer this came from, when it came from the library. */
  streamerId?: string
}

/**
 * One row in the discovery results — a candidate that provably overlaps the
 * event, scored and normalised so Twitch, Kick and YouTube results sit in one
 * sortable list.
 */
export interface DiscoveredStream {
  platform: PlatformId
  channelHandle: string
  /** What to show as the streamer's name: display name if known, else handle. */
  streamerName: string
  streamerId?: string
  vod: SearchableVod
  thumbnailUrl?: string
  tags?: string[]
  category?: string
  source: DiscoverySource
  sourceId?: string
  /** Real-world overlap with the requested event window. */
  coverage: OverlapCoverage
  /** 0..1 — how likely this really is the event asked for. See `matchConfidence`. */
  confidence: number
  /** Short human reasons behind the confidence, for a tooltip. */
  reasons: string[]
}

/** The event window a discovery run is asked about. */
export interface EventQuery {
  /** Epoch seconds. */
  startSeconds: number
  /**
   * Epoch seconds. The spec allows an open-ended event; callers that have no
   * end supply start + a default window rather than infinity, so coverage
   * fractions stay meaningful.
   */
  endSeconds: number
  /** Optional event name, e.g. "NoPixel bank robbery". Drives relevance. */
  name?: string
  /** Restrict results to one platform. Absent searches all of them. */
  platform?: PlatformId
}

/**
 * Terminology that marks a broadcast as belonging to the NoPixel/GTA-RP world.
 *
 * Deliberately broader than a literal title search (§1.2): a stream called
 * "THE BIG HEIST" with a GTA RP category is the exact case a title-only
 * match misses, so category and tags carry weight of their own and a title
 * that says nothing is not by itself disqualifying.
 */
const RP_TERMS = [
  'nopixel',
  'no pixel',
  'np ',
  'gta rp',
  'gtarp',
  'grand theft auto',
  'roleplay',
  'role play',
  'rp server'
]

/** Category names that, on their own, place a stream in the right world. */
const RP_CATEGORIES = ['grand theft auto v', 'grand theft auto', 'gta v', 'gta 5', 'gtav']

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function anyTermIn(haystack: string, terms: string[]): string | null {
  const text = normalise(haystack)
  for (const term of terms) if (text.includes(term)) return term
  return null
}

/**
 * How strongly a candidate looks like the event that was asked for, 0..1.
 *
 * Overlap alone is not enough — half of Twitch overlaps any given half hour.
 * What separates a real POV from noise is the combination of *when* it was
 * live and *what it was*, so title, tags and category all contribute, and a
 * candidate that came from the editor's own streamer library starts ahead
 * because they already said that channel matters.
 *
 * Never returns 0 for something that overlaps: a stream that was demonstrably
 * live during the event is always worth showing, just ranked below the
 * obvious matches. Hiding it would defeat the point of the sweep.
 */
export function matchConfidence(
  candidate: Pick<DiscoveryCandidate, 'title' | 'tags' | 'category' | 'source'>,
  query: Pick<EventQuery, 'name'>,
  coverage: Pick<OverlapCoverage, 'fraction' | 'certain'>
): { confidence: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0.2

  // The editor's own library is the strongest signal available: they already
  // decided this channel covers the events they care about.
  if (candidate.source === 'library' || candidate.source === 'loaded') {
    score += 0.25
    reasons.push('A channel from your streamer library')
  }

  const categoryHit = candidate.category ? anyTermIn(candidate.category, RP_CATEGORIES) : null
  if (categoryHit) {
    score += 0.2
    reasons.push(`Category: ${candidate.category}`)
  }

  const tagText = (candidate.tags ?? []).join(' ')
  const tagHit = tagText ? anyTermIn(tagText, RP_TERMS) : null
  if (tagHit) {
    score += 0.15
    reasons.push(`Tagged "${tagHit.trim()}"`)
  }

  const titleHit = anyTermIn(candidate.title, RP_TERMS)
  if (titleHit) {
    score += 0.15
    reasons.push(`Title mentions "${titleHit.trim()}"`)
  }

  // The event's own name, when given, is matched word by word rather than as
  // one string: "bank robbery" should still reward a title reading
  // "ROBBING THE BANK", which a substring test would miss entirely.
  if (query.name && query.name.trim() !== '') {
    const words = normalise(query.name)
      .split(' ')
      .filter((w) => w.length > 2 && !RP_TERMS.includes(w))
    const title = normalise(candidate.title)
    const hits = words.filter((w) => title.includes(w))
    if (words.length > 0 && hits.length > 0) {
      score += 0.2 * (hits.length / words.length)
      reasons.push(`Matches the event name (${hits.join(', ')})`)
    }
  }

  // Covering the whole window beats clipping the edge of it.
  score += 0.15 * coverage.fraction
  if (!coverage.certain) {
    score -= 0.1
    reasons.push('Broadcast length unknown — overlap is an estimate')
  }

  return { confidence: Math.max(0.05, Math.min(1, score)), reasons }
}

/**
 * Two candidates are the same broadcast when they are the same VOD.
 *
 * Compared on platform + a normalised URL rather than the raw string, because
 * the same Twitch VOD legitimately arrives as `twitch.tv/videos/123`,
 * `www.twitch.tv/videos/123` and `.../videos/123?t=1h` depending on which
 * source found it, and offering the editor the same broadcast three times is
 * exactly what §1.7 exists to prevent.
 */
export function candidateKey(candidate: Pick<DiscoveryCandidate, 'platform' | 'url'>): string {
  let path = candidate.url.trim().toLowerCase()
  try {
    const parsed = new URL(/^https?:\/\//i.test(path) ? path : `https://${path}`)
    path = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    // Not a parseable URL — compare the raw text, which is still stable.
  }
  return `${candidate.platform}:${path}`
}

/**
 * Candidates → the ranked, de-duplicated list the discovery panel shows.
 *
 * Anything that does not provably overlap the event window is dropped, not
 * ranked low: §1.1 asks for streams that were live during the event, and a
 * broadcast that had already ended is not one of them regardless of how well
 * its title matches.
 *
 * When the same broadcast is found twice — once in the library, once by a
 * platform search — the richer record wins rather than the first seen, so a
 * search result that happens to carry tags is not discarded in favour of a
 * bare library entry for the same VOD.
 */
export function rankDiscoveries(
  candidates: DiscoveryCandidate[],
  query: EventQuery
): DiscoveredStream[] {
  const best = new Map<string, DiscoveryCandidate>()
  for (const candidate of candidates) {
    if (query.platform && candidate.platform !== query.platform) continue
    const key = candidateKey(candidate)
    const existing = best.get(key)
    if (!existing || preferCandidate(candidate, existing)) best.set(key, candidate)
  }

  const out: DiscoveredStream[] = []
  for (const candidate of best.values()) {
    const coverage = coverageOf(candidate, query.startSeconds, query.endSeconds)
    if (!coverage) continue
    const { confidence, reasons } = matchConfidence(candidate, query, coverage)
    out.push({
      platform: candidate.platform,
      channelHandle: candidate.channelHandle,
      streamerName: candidate.channelName?.trim() || candidate.channelHandle,
      streamerId: candidate.streamerId,
      vod: {
        url: candidate.url,
        title: candidate.title,
        publishedAt: candidate.publishedAt,
        durationSeconds: candidate.durationSeconds
      },
      thumbnailUrl: candidate.thumbnailUrl,
      tags: candidate.tags,
      category: candidate.category,
      source: candidate.source,
      sourceId: candidate.sourceId,
      coverage,
      confidence,
      reasons
    })
  }

  return sortDiscoveries(out, 'confidence')
}

/**
 * Which of two records for the same broadcast to keep. Already-loaded wins
 * outright (it carries the project's own source id, which nothing else can
 * supply); otherwise the one that actually knows how long the broadcast was,
 * then the one carrying more metadata to score with.
 */
function preferCandidate(next: DiscoveryCandidate, current: DiscoveryCandidate): boolean {
  if (next.source === 'loaded' && current.source !== 'loaded') return true
  if (current.source === 'loaded') return false
  const nextKnown = next.durationSeconds !== null && next.durationSeconds > 0
  const currentKnown = current.durationSeconds !== null && current.durationSeconds > 0
  if (nextKnown !== currentKnown) return nextKnown
  const richness = (c: DiscoveryCandidate): number =>
    (c.tags?.length ? 1 : 0) + (c.category ? 1 : 0) + (c.publishedAt ? 1 : 0) + (c.streamerId ? 1 : 0)
  return richness(next) > richness(current)
}

export type DiscoverySort = 'confidence' | 'coverage' | 'start' | 'platform' | 'name'

/** §1.5's sort options, as one pure function so the panel holds no ordering logic. */
export function sortDiscoveries(streams: DiscoveredStream[], sort: DiscoverySort): DiscoveredStream[] {
  const byName = (a: DiscoveredStream, b: DiscoveredStream): number =>
    a.streamerName.localeCompare(b.streamerName)
  const startOf = (s: DiscoveredStream): number =>
    s.vod.publishedAt ? Date.parse(s.vod.publishedAt) : Number.POSITIVE_INFINITY

  const sorted = [...streams]
  switch (sort) {
    case 'coverage':
      return sorted.sort((a, b) => b.coverage.fraction - a.coverage.fraction || byName(a, b))
    case 'start':
      return sorted.sort((a, b) => startOf(a) - startOf(b) || byName(a, b))
    case 'platform':
      return sorted.sort((a, b) => a.platform.localeCompare(b.platform) || byName(a, b))
    case 'name':
      return sorted.sort(byName)
    case 'confidence':
    default:
      return sorted.sort(
        (a, b) => b.confidence - a.confidence || b.coverage.fraction - a.coverage.fraction || byName(a, b)
      )
  }
}

export interface DiscoveryFilter {
  platform?: PlatformId | 'all'
  /** Hide anything covering less of the event than this, 0..1. */
  minCoverage?: number
  /** Free-text match against streamer name and title. */
  search?: string
  /** Hide broadcasts already loaded as POVs. */
  hideLoaded?: boolean
}

/** §1.5's filters. Empty/absent fields never filter anything out. */
export function filterDiscoveries(
  streams: DiscoveredStream[],
  filter: DiscoveryFilter
): DiscoveredStream[] {
  const needle = normalise(filter.search ?? '')
  return streams.filter((s) => {
    if (filter.platform && filter.platform !== 'all' && s.platform !== filter.platform) return false
    if (filter.minCoverage !== undefined && s.coverage.fraction < filter.minCoverage) return false
    if (filter.hideLoaded && s.source === 'loaded') return false
    if (needle !== '') {
      const hay = `${normalise(s.streamerName)} ${normalise(s.vod.title)} ${normalise(s.channelHandle)}`
      if (!hay.includes(needle)) return false
    }
    return true
  })
}
