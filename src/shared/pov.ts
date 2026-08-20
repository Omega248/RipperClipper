import type { VodSource } from './types.js'

/** A POV's display name: the character, the editor's label, then the channel. */
export function povLabel(source: VodSource): string {
  return source.character || source.povName || source.creator || source.title
}
