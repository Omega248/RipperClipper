import { net } from 'electron'
import type { PlatformId } from '../../shared/types.js'
import type { LiveNow } from '../../shared/ipc.js'
import type { ResolverService } from '../media/resolver.js'

/**
 * Who a channel actually is: their real name, their picture, their size.
 *
 * The library used to show whatever slug was typed in, which is both ugly and
 * genuinely unhelpful — "kkrackd" and "MissBombastic" are hard to scan, and
 * on a wall of ten POVs a face is recognised far faster than a string. Every
 * platform publishes this; they just publish it in three different places.
 *
 * Each route below is read-only public profile data, and each fails soft: a
 * channel whose profile cannot be fetched simply keeps its handle, which is
 * exactly where the library stood before this existed.
 */

export interface StreamerProfile {
  /** The name as the platform capitalises it — "xQc", not "xqc". */
  displayName: string
  avatarUrl?: string
  followers?: number
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * The public client id Twitch's own web player ships with.
 *
 * Twitch publishes no unauthenticated REST route for a channel's profile —
 * Helix requires an OAuth app — so this is the same GQL endpoint the site
 * itself uses, with a plain read-only query for public profile fields. It is
 * unofficial, which is why every failure here is soft and the handle is kept.
 */
const TWITCH_PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

export async function fetchProfile(
  platform: PlatformId,
  handle: string,
  resolver: ResolverService,
  signal?: AbortSignal
): Promise<StreamerProfile | null> {
  const name = handle.replace(/^@/, '').trim()
  if (name === '') return null

  try {
    if (platform === 'twitch') return await twitchProfile(name, signal)
    if (platform === 'kick') return await kickProfile(name, signal)
    return await youtubeProfile(name, resolver, signal)
  } catch {
    // Soft by design: a profile is decoration, and losing it must never stop
    // a channel being usable.
    return null
  }
}

async function twitchProfile(login: string, signal?: AbortSignal): Promise<StreamerProfile | null> {
  const query = `{ user(login: "${login.replace(/"/g, '')}") { displayName profileImageURL(width: 150) followers { totalCount } } }`
  const response = await net.fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
      'Content-Type': 'application/json',
      'user-agent': BROWSER_UA
    },
    body: JSON.stringify({ query }),
    signal
  })
  if (!response.ok) return null

  const body = (await response.json()) as {
    data?: {
      user?: {
        displayName?: string
        profileImageURL?: string
        followers?: { totalCount?: number }
      } | null
    }
  }
  const user = body.data?.user
  if (!user?.displayName) return null
  return {
    displayName: user.displayName,
    avatarUrl: user.profileImageURL,
    followers: user.followers?.totalCount
  }
}

async function kickProfile(slug: string, signal?: AbortSignal): Promise<StreamerProfile | null> {
  const response = await net.fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', referer: 'https://kick.com/' },
    signal
  })
  if (!response.ok) return null

  const body = (await response.json()) as {
    slug?: string
    // Kick sends this as a *string* — verified against the live API. Passing
    // it straight through would leave every `typeof === 'number'` check false
    // and silently hide the count.
    followers_count?: number | string
    user?: { username?: string; profile_pic?: string }
  }
  const displayName = body.user?.username ?? body.slug
  if (!displayName) return null
  const followers = Number(body.followers_count)
  return {
    displayName,
    avatarUrl: body.user?.profile_pic,
    followers: Number.isFinite(followers) ? followers : undefined
  }
}

/**
 * YouTube has no profile endpoint of its own here, but yt-dlp already reads
 * the channel page for the VOD listing — and that same document carries the
 * channel's name, avatar and subscriber count, so this costs one request
 * rather than a second mechanism.
 */
async function youtubeProfile(
  handle: string,
  resolver: ResolverService,
  signal?: AbortSignal
): Promise<StreamerProfile | null> {
  const raw = (await resolver.flatPlaylist(`https://www.youtube.com/@${handle}/streams`, {
    signal,
    limit: 1
  })) as {
    channel?: string
    uploader?: string
    channel_follower_count?: number
    thumbnails?: Array<{ url?: string; id?: string; width?: number }>
  } | null

  const displayName = raw?.channel ?? raw?.uploader
  if (!displayName) return null

  const thumbs = raw?.thumbnails ?? []
  // The uncropped avatar is the square one; otherwise take the largest, since
  // these are shown small and a banner would be the wrong shape entirely.
  const avatar =
    thumbs.find((t) => t.id === 'avatar_uncropped')?.url ??
    [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url

  return { displayName, avatarUrl: avatar, followers: raw?.channel_follower_count }
}

/** How old a stored profile may get before it is worth fetching again. */
export const PROFILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function profileIsStale(fetchedAt: string | undefined, now = Date.now()): boolean {
  if (!fetchedAt) return true
  const at = Date.parse(fetchedAt)
  return !Number.isFinite(at) || now - at > PROFILE_MAX_AGE_MS
}

/**
 * Whether a channel is broadcasting right now.
 *
 * Every platform already answers this on a route this file (or the VOD
 * listing) is calling anyway, so this is the same three requests with a
 * different field read — no new mechanism, no polling service, no websocket.
 *
 * Fails soft to `null`, which the interface shows as "not live". Getting it
 * wrong for one refresh is a badge that lags by a minute; throwing would be a
 * page that will not load.
 *
 * ponytail: YouTube costs a yt-dlp process per channel per check, unlike the
 * plain HTTP the other two use. Fine for a library of this size at a
 * minute's cadence; if it starts to bite, check YouTube on a slower cycle
 * than the rest rather than adding a service.
 */
export async function fetchLive(
  platform: PlatformId,
  handle: string,
  resolver: ResolverService,
  signal?: AbortSignal
): Promise<LiveNow | null> {
  const name = handle.replace(/^@/, '').trim()
  if (name === '') return null

  try {
    if (platform === 'twitch') return await twitchLive(name, signal)
    if (platform === 'kick') return await kickLive(name, signal)
    return await youtubeLive(name, resolver, signal)
  } catch {
    return null
  }
}

async function twitchLive(login: string, signal?: AbortSignal): Promise<LiveNow | null> {
  // Deliberately only `id` and `viewersCount`: both are certain to exist on
  // Stream, and a query naming a field that does not errors as a whole — which
  // would read as "offline" for a channel that is live. A title is not worth
  // that risk.
  const query = `{ user(login: "${login.replace(/"/g, '')}") { stream { id viewersCount } } }`
  const response = await net.fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
      'Content-Type': 'application/json',
      'user-agent': BROWSER_UA
    },
    body: JSON.stringify({ query }),
    signal
  })
  if (!response.ok) return null

  const body = (await response.json()) as {
    data?: { user?: { stream?: { id?: string; viewersCount?: number } | null } | null }
  }
  const stream = body.data?.user?.stream
  // Null `stream` is exactly how Twitch says "offline".
  if (!stream?.id) return null
  return typeof stream.viewersCount === 'number' ? { viewers: stream.viewersCount } : {}
}

async function kickLive(slug: string, signal?: AbortSignal): Promise<LiveNow | null> {
  const response = await net.fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', referer: 'https://kick.com/' },
    signal
  })
  if (!response.ok) return null

  const body = (await response.json()) as {
    livestream?: { is_live?: boolean; session_title?: string; viewer_count?: number } | null
  }
  const stream = body.livestream
  if (!stream || stream.is_live === false) return null
  return {
    ...(typeof stream.viewer_count === 'number' ? { viewers: stream.viewer_count } : {}),
    ...(stream.session_title ? { title: stream.session_title } : {})
  }
}

/**
 * YouTube marks a live broadcast in the same channel listing the VOD crawl
 * reads — `live_status: 'is_live'` on the entry. A handful of entries is
 * enough: a live broadcast is always at the top of /streams.
 */
async function youtubeLive(
  handle: string,
  resolver: ResolverService,
  signal?: AbortSignal
): Promise<LiveNow | null> {
  const raw = (await resolver.flatPlaylist(`https://www.youtube.com/@${handle}/streams`, {
    signal,
    limit: 3,
    priority: 'idle'
  })) as { entries?: Array<Record<string, unknown>> } | null

  const live = (raw?.entries ?? []).find((e) => e.live_status === 'is_live')
  if (!live) return null
  return {
    ...(typeof live.concurrent_view_count === 'number'
      ? { viewers: live.concurrent_view_count }
      : {}),
    ...(typeof live.title === 'string' ? { title: live.title } : {})
  }
}

/**
 * When every broadcast on a Twitch channel happened, in one request.
 *
 * This is the difference between a back catalogue that fills in over an
 * afternoon and one that is complete before you have finished reading the
 * page. Twitch's video listing carries no dates, so learning them the obvious
 * way costs one yt-dlp process per broadcast — three hundred VODs is three
 * hundred processes, which is why the crawl paces itself at one every few
 * seconds and takes seventeen minutes for a single channel.
 *
 * The same GQL endpoint used for profiles will hand over a hundred videos and
 * their publish times in a single call. Keyed by Twitch's own video id, which
 * is what a VOD URL ends with.
 *
 * Returns an empty map on any failure, which the caller reads as "ask the slow
 * way" — this is an accelerator, never the only route.
 */
export async function twitchVideoDates(
  login: string,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const query = `{ user(login: "${login.replace(/"/g, '')}") { videos(first: 100, type: ARCHIVE) { edges { node { id publishedAt } } } } }`
  try {
    const response = await net.fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
        'Content-Type': 'application/json',
        'user-agent': BROWSER_UA
      },
      body: JSON.stringify({ query }),
      signal
    })
    if (!response.ok) return {}

    const body = (await response.json()) as {
      data?: {
        user?: {
          videos?: { edges?: Array<{ node?: { id?: string; publishedAt?: string } }> } | null
        } | null
      }
    }
    const out: Record<string, string> = {}
    for (const edge of body.data?.user?.videos?.edges ?? []) {
      const id = edge?.node?.id
      const at = edge?.node?.publishedAt
      if (!id || !at) continue
      const parsed = Date.parse(at)
      if (Number.isFinite(parsed)) out[id] = new Date(parsed).toISOString()
    }
    return out
  } catch {
    return {}
  }
}
