export const MEDIA_MANIFEST_PATH = '/media/manifest'
export const MEDIA_SEGMENT_PATH = '/media/segment'

/**
 * The one place a media-proxy URL is spelled out.
 *
 * Both sides build these: the main process rewrites playlists, and the
 * renderer points the player at a POV. They were two separate string templates
 * until the proxy started requiring a per-run secret — at which point the
 * renderer's copy silently stopped working, because it did not know the secret
 * existed. Every POV 403'd.
 *
 * Shared so that cannot happen again: adding anything to this URL now reaches
 * both callers or neither.
 */
export function mediaProxyUrl(
  base: string,
  token: string,
  kind: 'manifest' | 'segment',
  target: string,
  /**
   * This recording is still being written, so its playlist is not final.
   *
   * See `rewritePlaylist`: a growing recording that advertises `#EXT-X-ENDLIST`
   * makes every player treat it as finished and stop refreshing the playlist,
   * which is why playback used to stop dead at whatever the broadcast had
   * reached when the angle was loaded.
   */
  growing = false
): string {
  const path = kind === 'manifest' ? MEDIA_MANIFEST_PATH : MEDIA_SEGMENT_PATH
  return (
    `${base.replace(/\/$/, '')}${path}?k=${encodeURIComponent(token)}` +
    `&u=${encodeURIComponent(target)}${growing ? '&growing=1' : ''}`
  )
}

/**
 * The master playlist a stored variant URL came from, when that is knowable.
 *
 * `playbackUrl` is derived data cached in the project file, and for a long time
 * it was derived wrongly — the highest *variant* rather than the master — so
 * every project saved before that fix has a URL pinning every angle to 1080p60.
 * The fix to the resolver cannot reach them: nothing re-resolves on open.
 *
 * Kick serves IVS, whose layout puts every rendition in a sibling directory of
 * the master: `.../media/hls/1080p60/playlist.m3u8` next to
 * `.../media/hls/master.m3u8`. That is a rewrite, not a guess, and it needs no
 * network.
 *
 * Twitch's master lives on usher behind a signed token and cannot be derived
 * from a storage URL, so those return null and are re-resolved instead.
 */
export function masterPlaylistFor(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!/(^|\.)kick\.com$/.test(parsed.hostname) && !parsed.hostname.includes('stream.kick.com')) {
      return null
    }
    const match = /^(.*\/media\/hls)\/[^/]+\/playlist\.m3u8$/.exec(parsed.pathname)
    if (!match) return null
    parsed.pathname = `${match[1]}/master.m3u8`
    return parsed.toString()
  } catch {
    return null
  }
}
