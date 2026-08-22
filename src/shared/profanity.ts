import type { TranscriptLine } from './transcription.js'

/**
 * Finding the words to censor.
 *
 * This is a *suggestion* engine, never an automatic censor. Every hit is
 * offered to the editor to accept, reject or nudge, because the cost of the
 * two mistakes is wildly asymmetric: a missed word is a re-upload, while a
 * word silenced that was never said — or a false match inside an innocent
 * word — is a hole punched in someone's dialogue for no reason.
 *
 * Matching is on word boundaries against a stemmed form, so "fucking" and
 * "fucks" are caught from one entry, while "Scunthorpe", "assassin",
 * "classic" and "shitake" are not. That last part is why substring matching
 * is not used: it is the difference between a useful tool and one that
 * mangles ordinary speech.
 */

export type CensorAction = 'mute' | 'bleep'

/**
 * The default list.
 *
 * Deliberately short and blunt — the words a stream actually gets demonetised
 * or clipped for. Anything more specific belongs in the project's own list,
 * because what needs censoring depends entirely on where the clip is going.
 */
export const DEFAULT_PROFANITY: string[] = [
  'fuck',
  'shit',
  'bitch',
  'cunt',
  'dick',
  'piss',
  'bastard',
  'asshole',
  'arsehole',
  'wanker',
  'prick',
  'twat',
  'slut',
  'whore',
  'nigga',
  'nigger',
  'faggot',
  'retard',
  'cock',
  'pussy',
  'bollocks',
  'motherfucker'
]

/** A word found in a POV's transcript, in that POV's own clip time. */
export interface ProfanityHit {
  sourceId: string
  /** The matched word as it was actually said. */
  word: string
  /** The list entry it matched, so a hit can be traced to a rule. */
  matched: string
  /** Seconds within the clip — 0 is the clip's start. */
  startSeconds: number
  endSeconds: number
  /** The whole line it appeared in, for context in the review list. */
  context: string
  /**
   * How confident the timing is.
   *
   * Whisper times *segments*, not words, so a word inside a long line has its
   * position estimated by where it falls in the text. A short line is a tight
   * bound; a long one is a guess, and the editor should look before trusting
   * it. Never presented as exact.
   */
  timingConfidence: 'tight' | 'estimated'
}

/**
 * Padding either side of a detected word, in seconds.
 *
 * Speech does not start and stop on the frame the estimate says. A little
 * either side is the difference between a clean censor and clipping the
 * first consonant, and over-covering by a fraction of a second costs nothing
 * intelligible.
 */
export const HIT_PAD_SECONDS = 0.12

/**
 * Normalise for matching: lowercase, undo the usual letter-for-symbol
 * substitutions, and drop everything else.
 *
 * `*` is kept as a literal, because it is not a substitution for any
 * particular letter — it is a censor mark standing in for *any* one of them
 * ("f*ck"). Turning it into a fixed letter here is what would make "f*ck"
 * silently fail to match; `wordMatches` treats it as a wildcard instead.
 */
function normaliseWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/@/g, 'a')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/3/g, 'e')
    .replace(/[^a-z*]/g, '')
}

/** Compare two normalised forms, treating `*` in the spoken word as any single letter. */
function sameWord(word: string, target: string): boolean {
  if (!word.includes('*')) return word === target
  if (word.length !== target.length) return false
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== '*' && word[i] !== target[i]) return false
  }
  return true
}

/** Whether `word` begins with `target`, honouring `*` as any single letter. */
function startsWithWord(word: string, target: string): boolean {
  return word.length >= target.length && sameWord(word.slice(0, target.length), target)
}

/** Whether `word` ends with `target`, honouring `*` as any single letter. */
function endsWithWord(word: string, target: string): boolean {
  return word.length >= target.length && sameWord(word.slice(word.length - target.length), target)
}

/**
 * Whether a spoken word matches a list entry.
 *
 * Allows the ordinary inflections of the entry — plurals, -ing, -ed, -er —
 * so one list entry covers a family, without allowing the entry to appear
 * merely *inside* a longer unrelated word. "assassin" must not match "ass".
 */
export function wordMatches(spoken: string, entry: string): boolean {
  const word = normaliseWord(spoken)
  // A list entry is written plainly, so any `*` in it is meaningless.
  const target = normaliseWord(entry).replace(/\*/g, '')
  if (word === '' || target === '') return false
  if (sameWord(word, target)) return true

  // A suffix on the entry: fuck -> fucks, fucking, fucked, fucker, fuckers.
  if (startsWithWord(word, target)) {
    const rest = word.slice(target.length)
    return /^(s|es|ed|er|ers|ing|in|y|ies|a|as)$/.test(rest)
  }

  // A compound built on the entry, where the entry is the tail: motherfucker
  // is on the list in its own right, but "clusterfuck" should still be caught.
  if (endsWithWord(word, target) && word.length - target.length >= 3) return true

  return false
}

/**
 * Where a word sits inside a transcript line, in seconds.
 *
 * Whisper gives per-segment timing only, so a word's position is interpolated
 * by character offset across the line. That is accurate enough to censor
 * against for a short line and openly approximate for a long one — which is
 * what `timingConfidence` reports, rather than pretending to a precision that
 * does not exist.
 */
function timeOfWord(
  line: TranscriptLine,
  charStart: number,
  charEnd: number
): { startSeconds: number; endSeconds: number; confidence: ProfanityHit['timingConfidence'] } {
  const span = Math.max(0.001, line.endSeconds - line.startSeconds)
  const length = Math.max(1, line.text.length)
  const start = line.startSeconds + (charStart / length) * span
  const end = line.startSeconds + (charEnd / length) * span
  return {
    startSeconds: Math.max(line.startSeconds, start - HIT_PAD_SECONDS),
    endSeconds: Math.min(line.endSeconds, end + HIT_PAD_SECONDS),
    // A short segment bounds the word tightly whatever the interpolation says.
    confidence: span <= 3 ? 'tight' : 'estimated'
  }
}

/** Every listed word spoken in one POV's transcript, earliest first. */
export function findProfanity(
  lines: TranscriptLine[],
  sourceId: string,
  words: string[] = DEFAULT_PROFANITY
): ProfanityHit[] {
  const hits: ProfanityHit[] = []
  const list = words.filter((w) => w.trim() !== '')
  if (list.length === 0) return hits

  for (const line of lines) {
    // Split keeping offsets, so a hit can be placed inside the line.
    const pattern = /[A-Za-z0-9*@$!|]+/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line.text)) !== null) {
      const spoken = match[0]
      const entry = list.find((w) => wordMatches(spoken, w))
      if (!entry) continue
      const timing = timeOfWord(line, match.index, match.index + spoken.length)
      hits.push({
        sourceId,
        word: spoken,
        matched: entry,
        startSeconds: timing.startSeconds,
        endSeconds: timing.endSeconds,
        context: line.text.trim(),
        timingConfidence: timing.confidence
      })
    }
  }

  return hits.sort((a, b) => a.startSeconds - b.startSeconds)
}

/**
 * Merge hits that overlap or nearly touch, per POV.
 *
 * Two words in a row ("fucking bitch") are one censor, not two: separate
 * edits would leave an audible sliver of the second word between them, and
 * are more fiddly to adjust than the single range the editor actually wants.
 */
export function mergeHits(hits: ProfanityHit[], gapSeconds = 0.25): ProfanityHit[] {
  const byPov = new Map<string, ProfanityHit[]>()
  for (const hit of hits) {
    const list = byPov.get(hit.sourceId) ?? []
    list.push(hit)
    byPov.set(hit.sourceId, list)
  }

  const out: ProfanityHit[] = []
  for (const list of byPov.values()) {
    const sorted = [...list].sort((a, b) => a.startSeconds - b.startSeconds)
    for (const hit of sorted) {
      const previous = out[out.length - 1]
      const joins =
        previous !== undefined &&
        previous.sourceId === hit.sourceId &&
        hit.startSeconds - previous.endSeconds <= gapSeconds
      if (!joins) {
        out.push({ ...hit })
        continue
      }
      previous.endSeconds = Math.max(previous.endSeconds, hit.endSeconds)
      previous.word = `${previous.word} ${hit.word}`
      // A merged range is only as trustworthy as its least certain part.
      if (hit.timingConfidence === 'estimated') previous.timingConfidence = 'estimated'
    }
  }

  return out.sort((a, b) => a.startSeconds - b.startSeconds)
}

/** The project's word list, falling back to the default when none is set. */
export function effectiveWordList(custom: string[] | undefined): string[] {
  if (!custom) return DEFAULT_PROFANITY
  const cleaned = custom.map((w) => w.trim()).filter((w) => w !== '')
  return cleaned.length > 0 ? cleaned : DEFAULT_PROFANITY
}
