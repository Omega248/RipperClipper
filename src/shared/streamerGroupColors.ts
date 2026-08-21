/**
 * A fixed palette for streamer groups, not a colour picker — a swatch grid of
 * options that always look intentional next to each other, the same reason
 * clip tags are hashed onto a fixed set rather than free RGB entry.
 */
export const STREAMER_GROUP_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899'
] as const

export type StreamerGroupColor = (typeof STREAMER_GROUP_COLORS)[number]

export const DEFAULT_STREAMER_GROUP_COLOR: StreamerGroupColor = STREAMER_GROUP_COLORS[5]

export function isStreamerGroupColor(value: unknown): value is StreamerGroupColor {
  return typeof value === 'string' && (STREAMER_GROUP_COLORS as readonly string[]).includes(value)
}
