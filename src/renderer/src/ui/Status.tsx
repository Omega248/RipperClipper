import type { ReactNode } from 'react'
import { STATUS } from '@shared/status'
import type { StatusKey, StatusMeaning, StatusTone } from '@shared/status'

/**
 * The status badge.
 *
 * Colour is never the only signal: every badge carries a glyph and a word, so
 * it survives a colour-blind reader, a greyscale screenshot and a glance from
 * across the room. The words come from `shared/status.ts`, which is the only
 * place in the application allowed to name a state.
 */

export function Badge({
  tone = 'neutral',
  glyph,
  children
}: {
  tone?: StatusTone
  glyph?: string
  children: ReactNode
}): JSX.Element {
  return (
    <span className={`ui-badge is-${tone}`}>
      {glyph && (
        <span className="ui-badge-glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
    </span>
  )
}

function meaningBadge(meaning: StatusMeaning, override?: string): JSX.Element {
  return (
    <Badge tone={meaning.tone} glyph={meaning.glyph}>
      {override ?? meaning.label}
    </Badge>
  )
}

/** A state from the shared vocabulary. */
export function StatusBadge({ status, label }: { status: StatusKey; label?: string }): JSX.Element {
  return meaningBadge(STATUS[status], label)
}

/**
 * A dot for places too tight for a badge — a list row, a table cell. The
 * accessible name still carries the word, so nothing is colour-only.
 */
export function StatusDot({ status }: { status: StatusKey }): JSX.Element {
  const meaning = STATUS[status]
  return (
    <span className={`ui-dot is-${meaning.tone}${meaning.busy ? ' is-busy' : ''}`}>
      <span className="ui-sr-only">{meaning.label}</span>
    </span>
  )
}
