/**
 * A fixed set of icons a streamer group can pick from — not free text, so a
 * group always renders a real icon rather than whatever a font failed to
 * substitute. The actual glyphs live in the renderer's own icon set
 * (ui/Icon.tsx); this list only names which of them are offered here, kept
 * in shared/ so the main process can validate what gets stored without
 * depending on renderer-only code.
 */
export const STREAMER_GROUP_ICON_NAMES = [
  'shield',
  'car',
  'medical',
  'skull',
  'crown',
  'flame',
  'star',
  'briefcase'
] as const

export type StreamerGroupIconName = (typeof STREAMER_GROUP_ICON_NAMES)[number]

export function isStreamerGroupIconName(value: unknown): value is StreamerGroupIconName {
  return typeof value === 'string' && (STREAMER_GROUP_ICON_NAMES as readonly string[]).includes(value)
}
