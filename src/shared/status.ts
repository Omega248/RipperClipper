/**
 * The application's status vocabulary.
 *
 * Every state the editor is shown — a clip's export, a POV's coverage, a
 * tool install, a queue job — is mapped onto one of these eight words. The
 * point is not the colour: it is that "Needs review" is called "Needs
 * review" on every page, and that colour is never the only carrier of the
 * meaning. Each tone also has a shape (the `glyph`) and a word.
 */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

export type StatusKey =
  | 'ready'
  | 'loading'
  | 'processing'
  | 'needs-review'
  | 'approved'
  | 'complete'
  | 'failed'
  | 'unavailable'

export interface StatusMeaning {
  /** The one word shown to the editor. Never varied per page. */
  label: string
  tone: StatusTone
  /** A non-colour signal, so status survives greyscale and colour blindness. */
  glyph: string
  /** True while something is actively running — drives spinners and bars. */
  busy: boolean
}

export const STATUS: Record<StatusKey, StatusMeaning> = {
  ready: { label: 'Ready', tone: 'neutral', glyph: '○', busy: false },
  loading: { label: 'Loading', tone: 'info', glyph: '◐', busy: true },
  processing: { label: 'Processing', tone: 'info', glyph: '◐', busy: true },
  'needs-review': { label: 'Needs review', tone: 'warning', glyph: '▲', busy: false },
  approved: { label: 'Approved', tone: 'success', glyph: '✓', busy: false },
  complete: { label: 'Complete', tone: 'success', glyph: '✓', busy: false },
  failed: { label: 'Failed', tone: 'danger', glyph: '✕', busy: false },
  unavailable: { label: 'Unavailable', tone: 'neutral', glyph: '—', busy: false }
}

export function statusLabel(key: StatusKey): string {
  return STATUS[key].label
}

/** Export queue stages, said in the shared vocabulary. */
export function jobStatus(stage: string): StatusKey {
  switch (stage) {
    case 'complete':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'unavailable'
    case 'queued':
    case 'paused':
      return 'ready'
    case 'resolving':
      return 'loading'
    default:
      return 'processing'
  }
}

/** A clip's own export state. */
export function clipStatus(status: string): StatusKey {
  switch (status) {
    case 'complete':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'unavailable'
    case 'queued':
      return 'ready'
    case 'idle':
      return 'ready'
    case 'resolving':
      return 'loading'
    default:
      return 'processing'
  }
}

/** Whether a POV covers a clip, in the shared vocabulary. */
export function coverageStatus(coverage: string): StatusKey {
  switch (coverage) {
    case 'full':
    case 'available':
      return 'complete'
    case 'partial':
      return 'needs-review'
    case 'sync_required':
    case 'sync_low_confidence':
      return 'needs-review'
    default:
      return 'unavailable'
  }
}
