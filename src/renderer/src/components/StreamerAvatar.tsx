import { useState } from 'react'
import type { PlatformId } from '@shared/types'

/**
 * A channel's face.
 *
 * On a wall of ten POVs a picture is recognised far faster than a string —
 * "kkrackd" and "MissBombastic" are genuinely hard to scan past. Where the
 * platform gives us one, that is what the library leads with.
 *
 * The fallback matters as much as the image: a channel whose avatar has not
 * been fetched, or whose platform would not give one, gets initials on a
 * colour derived from its own name. That is stable per channel, so the same
 * person always looks the same, and it never collapses to an anonymous grey
 * box that makes the list look broken.
 */

/** Each platform's own brand colour, used for the ring rather than the fill. */
export const PLATFORM_COLOR: Record<PlatformId, string> = {
  twitch: '#9147ff',
  kick: '#53fc18',
  youtube: '#ff0033'
}

/**
 * A stable hue from a name.
 *
 * Deterministic so a channel's colour never changes between sessions — a
 * fallback that shuffled on every launch would be worse than no colour, since
 * the whole point is recognising someone at a glance.
 */
function hueFor(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360
  return hash
}

/** Up to two letters: initials for two words, otherwise the first two characters. */
function initialsOf(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export default function StreamerAvatar({
  name,
  platform,
  url,
  size = 40
}: {
  name: string
  platform: PlatformId
  url?: string
  size?: number
}): JSX.Element {
  // A URL that 404s must fall back rather than leaving a broken-image icon.
  const [failed, setFailed] = useState(false)
  const showImage = Boolean(url) && !failed

  return (
    <span
      className="streamer-avatar"
      style={{
        width: size,
        height: size,
        // The ring says which platform without spending a whole badge on it.
        boxShadow: `0 0 0 2px ${PLATFORM_COLOR[platform]}`,
        background: showImage ? 'transparent' : `hsl(${hueFor(name)} 45% 32%)`,
        fontSize: Math.round(size * 0.36)
      }}
      aria-hidden="true"
    >
      {showImage ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} draggable={false} />
      ) : (
        initialsOf(name)
      )}
    </span>
  )
}
