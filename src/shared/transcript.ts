/**
 * What was said, and when it was said in the real world (§11, §12).
 *
 * A transcript line is stored in its POV's own local time, exactly like every
 * other range in this application, and projected onto the event clock through
 * that POV's sync mapping when it is searched. That projection is the whole
 * feature: it is what makes "someone said 'you're under arrest' at 18:42:13"
 * a fact about the *event* rather than about one VOD, and therefore what lets
 * every other POV be positioned at the same instant.
 *
 * Where the words come from varies by platform and is deliberately not this
 * module's problem — YouTube publishes auto-captions, Twitch and Kick publish
 * nothing, and a future local speech-to-text pass would produce the same
 * shape. Everything below works identically whatever the source.
 */

import { isSynced, localToEvent } from './sync.js'
import type { VodTimeMapping } from './sync.js'

/** One spoken line, in its POV's own local time. */
export interface TranscriptLine {
  startSeconds: number
  endSeconds: number
  text: string
}

/** A stored transcript for one POV. */
export interface Transcript {
  sourceId: string
  /** BCP-47 tag, e.g. "en". */
  language: string
  /** How the words were obtained, so the UI can be honest about accuracy. */
  origin: 'captions' | 'auto-captions' | 'speech-to-text'
  lines: TranscriptLine[]
  fetchedAt: string
}

/** A search hit, carrying both clocks so the caller can seek either way. */
export interface TranscriptHit {
  sourceId: string
  startSeconds: number
  endSeconds: number
  text: string
  /** Real-world epoch seconds, or null when this POV is not on the event clock. */
  eventTimeSeconds: number | null
}

/**
 * WebVTT → lines.
 *
 * Written against the shape yt-dlp actually emits for YouTube auto-captions,
 * which is not the tidy WebVTT of the spec: cues repeat, carry inline
 * `<00:00:01.234>` word timings and `<c>` colour tags, and the same phrase is
 * emitted several times as the rolling caption grows. All of that is stripped
 * and de-duplicated here so search sees each sentence once.
 */
export function parseVtt(vtt: string): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  const blocks = vtt.replace(/\r/g, '').split('\n\n')

  for (const block of blocks) {
    const rows = block.split('\n')
    const timing = rows.find((r) => r.includes('-->'))
    if (!timing) continue

    const match = /(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})/.exec(
      timing
    )
    if (!match) continue

    const start = parseTimestamp(match[1])
    const end = parseTimestamp(match[2])
    if (start === null || end === null) continue

    const text = rows
      .filter((r) => !r.includes('-->') && r.trim() !== '' && !/^(WEBVTT|NOTE|Kind:|Language:)/i.test(r))
      // Inline word timings and cue tags carry no meaning for search.
      .map((r) => r.replace(/<[^>]*>/g, '').trim())
      .filter((r) => r !== '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (text === '') continue
    lines.push({ startSeconds: start, endSeconds: end, text })
  }

  return dedupeRolling(lines)
}

/**
 * YouTube's rolling captions repeat each phrase as it grows, so the same
 * sentence arrives several times with slightly different end times. Keeping
 * all of them would make one spoken line look like five separate moments.
 * The longest version of a repeated phrase wins, since it is the complete one.
 */
function dedupeRolling(lines: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of lines) {
    const previous = out[out.length - 1]
    if (previous && (previous.text === line.text || line.text.startsWith(previous.text))) {
      // Same phrase, extended: replace rather than append.
      out[out.length - 1] = { ...previous, endSeconds: line.endSeconds, text: line.text }
      continue
    }
    if (previous && previous.text.startsWith(line.text)) continue // a shorter repeat
    out.push(line)
  }
  return out
}

/** "01:02:03.456" or "02:03.456" → seconds. */
export function parseTimestamp(value: string): number | null {
  const parts = value.replace(',', '.').split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const numbers = parts.map(Number)
  if (numbers.some((n) => !Number.isFinite(n))) return null
  return parts.length === 3
    ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1]
}

/**
 * Search every loaded transcript at once (§11).
 *
 * Each hit carries the real-world instant it was said, projected through that
 * POV's own mapping — so results from three different VODs sort into one
 * chronological account of the event rather than three unrelated lists.
 */
export function searchTranscripts(
  transcripts: Transcript[],
  query: string,
  mappingFor: (sourceId: string) => VodTimeMapping | undefined,
  limit = 100
): TranscriptHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []

  const hits: TranscriptHit[] = []
  for (const transcript of transcripts) {
    const mapping = mappingFor(transcript.sourceId)
    const synced = mapping && isSynced(mapping)
    for (const line of transcript.lines) {
      if (!line.text.toLowerCase().includes(needle)) continue
      hits.push({
        sourceId: transcript.sourceId,
        startSeconds: line.startSeconds,
        endSeconds: line.endSeconds,
        text: line.text,
        eventTimeSeconds: synced ? localToEvent(mapping!, line.startSeconds) : null
      })
      if (hits.length >= limit * 4) break
    }
  }

  // Chronological by real-world time — the order the event actually happened
  // in. Hits from unsynced POVs cannot be placed, so they follow at the end
  // rather than being silently dropped or pretending to a position.
  return hits
    .sort((a, b) => {
      if (a.eventTimeSeconds === null && b.eventTimeSeconds === null) return 0
      if (a.eventTimeSeconds === null) return 1
      if (b.eventTimeSeconds === null) return -1
      return a.eventTimeSeconds - b.eventTimeSeconds
    })
    .slice(0, limit)
}

/**
 * The same real-world instant, in every POV that has a transcript (§12).
 *
 * Given one hit, this is what everyone else was saying at that moment —
 * which is the multi-POV move the whole application exists for, applied to
 * speech instead of pictures.
 */
export function transcriptsAtEventTime(
  transcripts: Transcript[],
  eventTimeSeconds: number,
  mappingFor: (sourceId: string) => VodTimeMapping | undefined,
  windowSeconds = 5
): TranscriptHit[] {
  const out: TranscriptHit[] = []
  for (const transcript of transcripts) {
    const mapping = mappingFor(transcript.sourceId)
    if (!mapping || !isSynced(mapping)) continue
    for (const line of transcript.lines) {
      const at = localToEvent(mapping, line.startSeconds)
      if (at === null) continue
      if (Math.abs(at - eventTimeSeconds) > windowSeconds) continue
      out.push({
        sourceId: transcript.sourceId,
        startSeconds: line.startSeconds,
        endSeconds: line.endSeconds,
        text: line.text,
        eventTimeSeconds: at
      })
    }
  }
  return out.sort((a, b) => (a.eventTimeSeconds ?? 0) - (b.eventTimeSeconds ?? 0))
}
