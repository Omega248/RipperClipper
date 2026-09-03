import type { SavedStreamer } from './ipc.js'

/**
 * One person, however many platforms they restream to.
 *
 * `personId` is what links their accounts (see `StreamerService.linkPerson`);
 * an unlinked streamer is a person of one. Everything here is presentation
 * logic shared by the roster and the detail header, kept out of both so it can
 * be tested without rendering anything.
 */

/**
 * The name to show for a person with several accounts.
 *
 * The platforms disagree about capitalisation — the same person is
 * "TotallyNotBelltower" on one and "totallynotbelltower" on another — and the
 * handle is what an account falls back to before its profile has been read. A
 * name the platform actually published beats a slug, and among those the one
 * that bothered with capitals is the one the person chose for themselves.
 */
export function personName(accounts: SavedStreamer[]): string {
  if (accounts.length === 0) return ''
  const named = accounts.filter((a) => a.displayName.toLowerCase() !== a.handle.toLowerCase())
  const pool = named.length > 0 ? named : accounts
  return (
    pool.find((a) => /[A-Z]/.test(a.displayName))?.displayName ??
    pool[0]?.displayName ??
    accounts[0].displayName
  )
}

/**
 * URL fragments that mark a platform's stand-in avatar rather than a real one.
 *
 * Every platform serves a placeholder for an account that never set a picture,
 * and it is served from a path that says so. Matching on the path is the only
 * signal available without fetching and looking at the pixels, and it is
 * enough: these paths are stable, and a miss costs a grey circle rather than
 * anything breaking.
 */
const DEFAULT_AVATAR_MARKERS = [
  // Twitch: .../user-default-pictures-uv/<uuid>-profile_image-150x150.png
  'user-default-pictures',
  // Kick: .../img/default-profile-pictures/default2.jpeg
  'default-profile-pictures',
  'default_profile',
  // Generated stand-ins some platforms fall back to.
  'dicebear',
  'gravatar.com/avatar'
]

/** Whether this is a platform's placeholder rather than a picture someone chose. */
export function isDefaultAvatar(url: string | undefined): boolean {
  if (!url) return true
  const lower = url.toLowerCase()
  return DEFAULT_AVATAR_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * The picture to show for a person with several accounts.
 *
 * A real photo on any one platform beats a grey placeholder on the one that
 * happens to sort first — which is the whole reason this exists: a streamer
 * who set an avatar on Twitch and never bothered on Kick should not appear as
 * an anonymous circle just because their Kick channel is the one on air.
 *
 * Returns undefined when nobody has set one, which is the caller's cue to draw
 * its own initials.
 */
export function personAvatar(accounts: SavedStreamer[]): string | undefined {
  return (
    accounts.find((a) => !isDefaultAvatar(a.avatarUrl))?.avatarUrl ??
    accounts.find((a) => a.avatarUrl)?.avatarUrl
  )
}
