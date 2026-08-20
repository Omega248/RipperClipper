/**
 * Windows-safe filename handling: sanitisation, templating, collision suffixes.
 */

// Characters Windows forbids in a filename, plus control characters.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\x00-\x1f\x7f]/g

const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

const MAX_BASENAME = 150

/**
 * Turn arbitrary user text into a safe filename stem (no extension).
 * Never throws, never returns an empty string.
 */
export function sanitizeFilename(input: string, fallback = 'clip'): string {
  let name = (input ?? '').normalize('NFC').replace(ILLEGAL, '_')

  // Collapse whitespace runs, trim.
  name = name.replace(/\s+/g, ' ').trim()

  // Windows strips trailing dots/spaces; do it ourselves so the result is predictable.
  name = name.replace(/[. ]+$/g, '')

  if (name.length > MAX_BASENAME) name = name.slice(0, MAX_BASENAME).replace(/[. ]+$/g, '')

  if (name === '') return fallback

  // Reserved device names are unusable even with an extension.
  const stem = name.split('.')[0]?.toUpperCase() ?? ''
  if (RESERVED.has(stem)) name = `_${name}`

  return name
}

export interface TemplateContext {
  name: string
  /** Event/project name, for per-project folders. */
  project?: string
  vodTitle?: string
  creator?: string
  platform?: string
  /** ISO date of the VOD, or today's date when unknown. */
  date?: string
  index?: number
  start?: string
  end?: string
  duration?: string
}

const TOKEN_RE = /\{(\w+)\}/g

/**
 * Apply a filename template such as "{VODTitle} - {Name}".
 * Unknown tokens are dropped. The result is sanitised.
 * The template must NOT contain the extension.
 */
export function applyTemplate(template: string, ctx: TemplateContext): string {
  const tidied = fillTokens(template, ctx)
    // Clean up separators left behind by empty tokens (" - " at the ends, doubles).
    .replace(/\s*-\s*-\s*/g, ' - ')
    .replace(/^[\s\-_]+/, '')
    .replace(/[\s\-_]+$/, '')

  return sanitizeFilename(tidied, sanitizeFilename(ctx.name))
}

/** Replace {Tokens} with their values; unknown or empty tokens vanish. */
function fillTokens(template: string, ctx: TemplateContext): string {
  const lookup: Record<string, string | undefined> = {
    name: ctx.name,
    project: ctx.project,
    event: ctx.project,
    vodtitle: ctx.vodTitle,
    title: ctx.vodTitle,
    creator: ctx.creator,
    channel: ctx.creator,
    platform: ctx.platform,
    date: ctx.date,
    index: ctx.index === undefined ? undefined : String(ctx.index).padStart(2, '0'),
    start: ctx.start,
    end: ctx.end,
    duration: ctx.duration
  }

  return template.replace(TOKEN_RE, (_, token: string) => {
    const value = lookup[token.toLowerCase()]
    return value === undefined ? '' : value
  })
}

/**
 * Produce a filename that does not collide with `existing`.
 * "Clip.mp4" -> "Clip (2).mp4" -> "Clip (3).mp4"
 *
 * `existing` should contain names as they would appear on disk (case-insensitive
 * comparison, matching Windows semantics).
 */
export function uniqueFilename(
  stem: string,
  extension: string,
  existing: Iterable<string>
): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`
  const taken = new Set<string>()
  for (const e of existing) taken.add(e.toLowerCase())

  let candidate = `${stem}${ext}`
  if (!taken.has(candidate.toLowerCase())) return candidate

  for (let i = 2; i < 10_000; i++) {
    candidate = `${stem} (${i})${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  // Extremely unlikely; fall back to a timestamped name rather than overwriting.
  return `${stem} (${Date.now()})${ext}`
}

/** True when the string is a plausible single path segment (no traversal). */
export function isSafePathSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false
  if (segment.includes('/') || segment.includes('\\')) return false
  if (ILLEGAL.test(segment)) {
    ILLEGAL.lastIndex = 0
    return false
  }
  ILLEGAL.lastIndex = 0
  return true
}

/**
 * Turn a folder template into safe relative path segments.
 *
 * Every segment is sanitised on its own and anything that could climb out of
 * the output directory — "..", absolute paths, drive letters, separators
 * smuggled in through a clip name — is dropped, so a clip called
 * "../../Windows" cannot write outside the folder the editor chose. A level
 * whose tokens are all empty disappears rather than leaving a blank folder.
 *
 * Token substitution here deliberately does NOT fall back to the clip name the
 * way `applyTemplate` does: a missing {Project} must remove that level, not
 * silently name it after the clip.
 */
export function buildFolderSegments(template: string, ctx: TemplateContext): string[] {
  if (!template || template.trim() === '') return []
  const out: string[] = []
  for (const raw of template.split(/[\\/]+/)) {
    const part = fillTokens(raw.trim(), ctx).trim()
    if (part === '' || part === '.' || part === '..') continue
    // Leading dots are stripped as well: a value like "../../Windows" flattens
    // to one harmless segment, and Windows treats trailing/leading-dot names
    // badly enough to be worth avoiding entirely.
    const safe = sanitizeFilename(part, '').replace(/^\.+/, '').trim()
    // sanitizeFilename can legitimately empty a segment ("..", "?"), and a
    // segment that still is not safe is never guessed at — it is dropped.
    if (safe === '' || !isSafePathSegment(safe)) continue
    out.push(safe)
  }
  return out
}
