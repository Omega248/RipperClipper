/**
 * One search box over the whole event (§10).
 *
 * Everything the editor can name — clips, POVs, streamers, collections and
 * moments — is searchable from one place, because "find the
 * bank thing" should not require first deciding whether the bank thing is a
 * clip, a collection or something someone said.
 *
 * Matching is forgiving on purpose. An exact substring always wins, but a
 * query whose words all appear somewhere still matches, and a short query
 * still matches a prefix — so "pol chase" finds "Police Chase" and a typo’d
 * half-word does not silently return nothing. It is deliberately *not* a
 * fuzzy edit-distance match: those return confident nonsense for short
 * queries, which is worse than an honest empty result.
 */

import type { ClipSegment, EventInfo, ProjectFile, VodSource } from './types.js'
import { workflowOf } from './collections.js'

export type SearchKind = 'clip' | 'pov' | 'collection' | 'moment'

export interface SearchResult {
  kind: SearchKind
  /** The thing's own id — clip id, source id, collection id, moment id. */
  id: string
  title: string
  /** One line of context under the title. */
  subtitle?: string
  /** 0..1. Higher sorts first. */
  score: number
  /** Real-world epoch seconds, when this result has a place on the event clock. */
  eventTimeSeconds?: number
  /** The POV a result belongs to, when it has one. */
  sourceId?: string
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * How well `text` answers `query`, 0 (no match) to 1 (exact).
 *
 * Scores rather than a boolean so a query matching a clip's name outranks the
 * same query matching a word buried in a longer title — both are real
 * matches, but one is far more likely to be what was meant.
 */
export function matchScore(text: string, query: string): number {
  const haystack = normalise(text)
  const needle = normalise(query)
  if (needle === '' || haystack === '') return 0
  if (haystack === needle) return 1
  if (haystack.startsWith(needle)) return 0.9
  if (haystack.includes(needle)) return 0.8

  // Every word present somewhere, in any order: "chase police" finds
  // "Police Chase".
  const words = needle.split(' ').filter(Boolean)
  if (words.length === 0) return 0
  const hits = words.filter((w) => haystack.includes(w))
  if (hits.length === words.length) return 0.6

  // A short query matching the start of any word — "pol" → "police".
  const tokens = haystack.split(' ')
  if (words.length === 1 && words[0].length >= 3 && tokens.some((t) => t.startsWith(words[0]))) {
    return 0.5
  }

  // Partial multi-word matches are real but weak, and never beat a single
  // whole-word hit above.
  return hits.length > 0 ? 0.3 * (hits.length / words.length) : 0
}

/** The best score across several fields, so a match anywhere counts. */
function bestScore(query: string, ...texts: Array<string | undefined | null>): number {
  let best = 0
  for (const text of texts) {
    if (!text) continue
    const score = matchScore(text, query)
    if (score > best) best = score
  }
  return best
}

export interface SearchInput {
  project: ProjectFile
  /** How a POV should be named in results. Supplied by the caller so this stays UI-free. */
  povName?: (source: VodSource) => string
}

/**
 * Search everything in one pass.
 *
 * Results are capped per kind rather than globally, so one noisy kind can
 * never crowd out the one clip that was actually being looked for.
 */
export function searchEvent(input: SearchInput, query: string, limitPerKind = 8): SearchResult[] {
  const trimmed = query.trim()
  if (trimmed === '') return []

  const { project } = input
  const byKind = new Map<SearchKind, SearchResult[]>()
  const push = (result: SearchResult): void => {
    if (result.score <= 0) return
    const list = byKind.get(result.kind) ?? []
    list.push(result)
    byKind.set(result.kind, list)
  }

  for (const clip of project.clips) {
    push({
      kind: 'clip',
      id: clip.id,
      title: clip.name,
      subtitle: `Clip · ${workflowOf(clip)}${clip.tag ? ` · ${clip.tag}` : ''}`,
      score: bestScore(trimmed, clip.name, clip.tag ?? undefined),
      eventTimeSeconds: clip.eventStartTime ?? undefined
    })
  }

  for (const source of project.sources) {
    const name = input.povName?.(source) ?? source.creator ?? source.title
    push({
      kind: 'pov',
      id: source.id,
      title: name,
      subtitle: `${source.platform} · ${source.title}`,
      // A POV is findable by every name it goes by: the character being
      // played, the editor's own label, the channel, and the VOD title.
      score: bestScore(
        trimmed,
        name,
        source.character,
        source.povName,
        source.creator,
        source.channelHandle,
        source.title
      ),
      sourceId: source.id
    })
  }

  for (const collection of project.event?.collections ?? []) {
    push({
      kind: 'collection',
      id: collection.id,
      title: collection.name,
      subtitle: 'Collection',
      score: bestScore(trimmed, collection.name, collection.note)
    })
  }

  for (const moment of project.event?.moments ?? []) {
    push({
      kind: 'moment',
      id: moment.id,
      title: moment.name,
      subtitle: 'Moment',
      score: bestScore(trimmed, moment.name, moment.note),
      eventTimeSeconds: moment.timeSeconds
    })
  }

  const out: SearchResult[] = []
  for (const list of byKind.values()) {
    out.push(...list.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limitPerKind))
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
}

/** Clips filed under one collection, in their own order. Null lists the loose ones. */
export function clipsInCollection(clips: ClipSegment[], collectionId: string | null): ClipSegment[] {
  return clips
    .filter((c) => (c.collectionId ?? null) === collectionId)
    .sort((a, b) => a.order - b.order)
}

/** Every collection with how many clips it holds — for the sidebar's counts. */
export function collectionCounts(
  event: EventInfo | undefined,
  clips: ClipSegment[]
): Array<{ id: string | null; name: string; count: number }> {
  const counts: Array<{ id: string | null; name: string; count: number }> = [
    { id: null, name: 'Unfiled', count: clipsInCollection(clips, null).length }
  ]
  for (const collection of [...(event?.collections ?? [])].sort((a, b) => a.order - b.order)) {
    counts.push({
      id: collection.id,
      name: collection.name,
      count: clipsInCollection(clips, collection.id).length
    })
  }
  return counts
}
