import type { AdapterCapabilities, PlaybackKind, VodSource } from '../../shared/types.js'
import type { RawInfo } from '../media/resolver.js'
import { firstCodec, parseMaster, sortVariants, variantLabel } from '../media/hls.js'
import { isoDateFrom, parseOffset, previewKindFromFormats, safeUrl } from './types.js'
import type { PlatformAdapter, UrlMatch } from './types.js'

/**
 * Twitch VODs are delivered as HLS, so an arbitrary time range maps cleanly to
 * a contiguous run of media segments. Twitch's Helix "create clip" endpoint is
 * NOT used for this: it only produces short clips from a live broadcast and
 * cannot express an arbitrary VOD range.
 */
/** twitch.tv paths that are site furniture rather than someone's channel. */
const RESERVED = new Set([
  'directory', 'videos', 'settings', 'downloads', 'jobs', 'turbo', 'friends',
  'subscriptions', 'inventory', 'wallet', 'drops', 'prime', 'store', 'p',
  'popout', 'moderator', 'u', 'team', 'search', 'following', 'login', 'signup'
])

export class TwitchAdapter implements PlatformAdapter {
  readonly id = 'twitch' as const
  readonly displayName = 'Twitch'

  readonly capabilities: AdapterCapabilities = {
    notes: [
      'Sub-only VODs require an authenticated session; choose your browser under Settings → Setup → Restricted VODs.',
      "Twitch's official clip API cannot produce arbitrary-length VOD segments, so ranges are extracted from the VOD's own HLS segments instead."
    ]
  }

  match(url: string): UrlMatch | null {
    const parsed = safeUrl(url)
    if (!parsed) return null
    if (!/(^|\.)twitch\.tv$/i.test(parsed.hostname)) return null

    const parts = parsed.pathname.split('/').filter(Boolean)
    // https://www.twitch.tv/videos/123456789
    let vodId: string | null = null
    if (parts[0] === 'videos' && parts[1]) vodId = parts[1]
    // https://www.twitch.tv/<channel>/video/123456789 (legacy)
    else if (parts[1] === 'video' && parts[2]) vodId = parts[2]
    // https://www.twitch.tv/videos/123456789?t=1h2m3s

    if (vodId && /^\d+$/.test(vodId)) {
      return {
        platform: this.id,
        vodId,
        kind: 'vod',
        canonicalUrl: `https://www.twitch.tv/videos/${vodId}`,
        startSeconds: parseOffset(parsed.searchParams.get('t'))
      }
    }

    /*
     * https://www.twitch.tv/<channel> — the broadcast happening right now.
     *
     * Three things have to hold, and each rules out a real URL that would
     * otherwise be read as a person: the host must be Twitch's main site
     * (clips.twitch.tv/<slug> is a clip, not a channel), the path must be a
     * single segment, and that segment must not be one of Twitch's own pages.
     */
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const login = parts[0]
    if (
      (host === 'twitch.tv' || host === 'm.twitch.tv') &&
      /*
       * The channel itself, or one of its listing tabs.
       *
       * `twitch.tv/<login>/videos?filter=archives` is the page a person is
       * actually looking at when they go to find someone's recordings, and it
       * was answered with "That link is not a Twitch, Kick or YouTube VOD
       * address" — which is both wrong and unhelpful about a twitch.tv URL.
       * The tab is not part of the identity: every one of these means the
       * same channel.
       */
      (parts.length === 1 ||
        (parts.length === 2 && ['videos', 'clips', 'about', 'schedule', 'home'].includes(parts[1]))) &&
      login &&
      /^[A-Za-z0-9_]{3,25}$/.test(login) &&
      !RESERVED.has(login.toLowerCase())
    ) {
      return {
        platform: this.id,
        // No recording exists yet, so the channel's own name is the only
        // stable identity this source has until its archive is published.
        vodId: login.toLowerCase(),
        kind: 'channel',
        canonicalUrl: `https://www.twitch.tv/${login}`
      }
    }

    return null
  }

  playbackKind(raw: RawInfo): PlaybackKind {
    return previewKindFromFormats(raw)
  }

  /**
   * Twitch's own video document + master playlist → the shape the rest of the
   * pipeline expects from yt-dlp.
   *
   * Pure on purpose, exactly like `KickAdapter.fromApi`: the network half
   * lives in `media/twitchDirect.ts` and imports Electron, which would make
   * this untestable if the two were one function.
   */
  fromApi(
    meta: {
      id: string
      title?: string
      lengthSeconds?: number
      publishedAt?: string
      previewThumbnailURL?: string
      owner?: { login?: string; displayName?: string }
    },
    master: { text: string; url: string },
    canonicalUrl?: string
  ): RawInfo {
    const parsed = parseMaster(master.text, master.url)
    const variants = sortVariants(parsed.variants)
    return {
      id: meta.id,
      title: meta.title ?? undefined,
      uploader: meta.owner?.displayName ?? meta.owner?.login,
      channel: meta.owner?.login,
      duration: typeof meta.lengthSeconds === 'number' ? meta.lengthSeconds : undefined,
      timestamp: meta.publishedAt ? Math.floor(Date.parse(meta.publishedAt) / 1000) : undefined,
      thumbnail: meta.previewThumbnailURL ?? undefined,
      is_live: false,
      extractor_key: 'TwitchVod',
      webpage_url: canonicalUrl,
      formats: variants.map((v, index) => ({
        // Twitch calls the source rendition's *group* "chunked" and puts the
        // readable "1080p60" on the media line instead; `variantLabel` joins
        // them. Everything downstream sorts on height, so this is for people.
        format_id: variantLabel(v, parsed.media) ?? `variant-${index}`,
        url: v.uri,
        // The master this came from — what playback should be handed. See the
        // note on `playbackUrl` in kick.ts.
        manifest_url: master.url,
        ext: 'mp4',
        protocol: 'm3u8_native',
        vcodec: firstCodec(v.codecs, 'video') ?? 'unknown',
        acodec: firstCodec(v.codecs, 'audio') ?? 'unknown',
        width: v.width,
        height: v.height,
        fps: v.frameRate,
        tbr: v.bandwidth > 0 ? Math.round(v.bandwidth / 1000) : undefined
      }))
    }
  }

  buildSource(match: UrlMatch, raw: RawInfo): VodSource {
    const hls = (raw.formats ?? [])
      .filter((f) => (f.protocol ?? '').startsWith('m3u8') && f.url)
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]

    return {
      id: `twitch:${match.vodId}`,
      platform: 'twitch',
      vodId: match.vodId,
      url: match.canonicalUrl,
      title: raw.title ?? `Twitch VOD ${match.vodId}`,
      creator: raw.uploader ?? raw.channel ?? raw.uploader_id ?? 'Unknown channel',
      durationSeconds: Number(raw.duration ?? 0),
      createdAt: isoDateFrom(raw),
      thumbnailUrl: raw.thumbnail,
      // The master, not the biggest rung — see the note in kick.ts. A media
      // playlist here pins every angle to one rendition.
      playbackUrl: hls?.manifest_url ?? hls?.url ?? raw.url,
      playbackKind: this.playbackKind(raw),
      capabilities: this.capabilities,
      formatsInspected: false
    }
  }
}
