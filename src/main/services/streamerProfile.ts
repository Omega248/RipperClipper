import { net } from 'electron'
import type { PlatformId } from '../../shared/types.js'
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
