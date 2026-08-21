import type { StatusTone } from './status.js'

/**
 * Colour for a clip's triage tag ("Highlight", "Needs review", …).
 *
 * There's no colour picker: the same tag text always renders the same
 * colour, and different tags are usually a different one, which is enough
 * to tell a long clip list apart at a glance without asking the editor to
 * manage a palette.
 */
const TAG_TONES: StatusTone[] = ['accent', 'info', 'success', 'warning', 'danger']

export function tagTone(tag: string): StatusTone {
  let hash = 0
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) | 0
  }
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length]
}
