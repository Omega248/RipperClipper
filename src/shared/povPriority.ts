import type { PlatformId } from './types.js'

/**
 * One angle per person, and Twitch first.
 *
 * A restreamer is on Twitch, Kick and YouTube at the same time with the same
 * face and the same three hours of footage. To the matcher those are three
 * separate broadcasts that all cover the moment, so a sweep finds three of
 * them and a nine-person scene turns into twenty-seven candidates — and
 * loading two of the same person's simulcast is worse than useless, because
 * the wall now shows the same angle twice and the export offers a choice that
 * is not a choice.
 *
 * So: collapse to one per person, and when there is a choice, take Twitch.
 * Not arbitrary — Twitch VODs are the ones this app can place on the clock
 * most reliably (a published start time and a stable duration), which is what
 * the whole sync model runs on. Kick is second because its API answers with a
 * date; YouTube is last because dating it costs a request per video and often
 * a bot check.
 */

export const PLATFORM_PRIORITY: PlatformId[] = ['twitch', 'kick', 'youtube']

export function platformRank(platform: string): number {
  const index = PLATFORM_PRIORITY.indexOf(platform as PlatformId)
  return index === -1 ? PLATFORM_PRIORITY.length : index
}

/** Twitch, then Kick, then YouTube, then anything unrecognised. */
export function byPlatformPriority(a: string, b: string): number {
  return platformRank(a) - platformRank(b)
}

/**
 * Who this broadcast belongs to, as a key two accounts can share.
 *
 * The library's own person link is the honest answer when there is one — it is
 * what "these are the same human" means here, and it is set deliberately, by
 * discovery or by hand. Falling back to the name is a guess, and a reasonable
 * one: a restreamer almost always uses one handle everywhere, which is exactly
 * why sibling discovery matches on it too. Two genuinely different people with
 * the same name on two platforms would be merged; that is rarer than one
 * person being listed three times, and the editor can still add the second
 * from the streamer library by hand.
 */
export function personKey(
  input: { streamerId?: string; streamerName: string },
  personIdFor?: (streamerId: string) => string | undefined
): string {
  const linked = input.streamerId ? personIdFor?.(input.streamerId) : undefined
  if (linked) return `person:${linked}`
  return `name:${input.streamerName.trim().toLowerCase().replace(/\s+/g, '')}`
}

/**
 * Every key one identity could be known by.
 *
 * `personKey` answers with the *best* key it can — the library's person link
 * when there is one, the name otherwise. That is right for grouping a single
 * list, and wrong for comparing two lists built from different information: a
 * candidate the sweep knows as `person:p1` and a loaded POV known only by name
 * are the same human, and matching one key against the other silently finds
 * nothing. Comparing whole sets of aliases is what makes that work.
 */
export function personAliases(
  input: { streamerId?: string; streamerName: string },
  personIdFor?: (streamerId: string) => string | undefined
): string[] {
  const keys = [personKey({ streamerName: input.streamerName })]
  const linked = input.streamerId ? personIdFor?.(input.streamerId) : undefined
  if (linked) keys.push(`person:${linked}`)
  return keys
}

/** True when two identities share any name the other is also known by. */
export function samePerson(a: string[], known: ReadonlySet<string>): boolean {
  return a.some((key) => known.has(key))
}

/**
 * Keep the best broadcast per person, in the order the list was already in.
 *
 * `better` is the caller's own idea of quality — how well a candidate matches
 * the moment — and it wins over the platform. Platform only decides a tie,
 * which is the case this exists for: the same person's simulcast, covering the
 * same seconds, equally well, on three sites.
 *
 * Order is preserved rather than re-sorted: the caller has usually already
 * sorted by match strength, and quietly reordering behind their back is how a
 * "best first" list stops being one.
 */
export function oneAnglePerStreamer<T>(
  items: T[],
  read: {
    key: (item: T) => string
    platform: (item: T) => string
    /** Negative when `a` is the better angle. Ties fall through to platform. */
    better?: (a: T, b: T) => number
  }
): T[] {
  const best = new Map<string, { item: T; index: number }>()

  items.forEach((item, index) => {
    const key = read.key(item)
    const held = best.get(key)
    if (!held) {
      best.set(key, { item, index })
      return
    }
    const quality = read.better ? read.better(item, held.item) : 0
    const wins =
      quality !== 0
        ? quality < 0
        : byPlatformPriority(read.platform(item), read.platform(held.item)) < 0
    if (wins) best.set(key, { item, index: held.index })
  })

  return [...best.values()].sort((a, b) => a.index - b.index).map((entry) => entry.item)
}
