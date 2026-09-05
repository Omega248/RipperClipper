import { AppError, Errors } from '../../shared/errors.js'
import type { StreamInfo, VodSource } from '../../shared/types.js'
import type { AdapterRegistry } from '../platforms/registry.js'
import type { UrlMatch } from '../platforms/types.js'
import type { ResolverService } from '../media/resolver.js'
import { toStreamInfos } from '../media/resolver.js'
import type { RawInfo } from '../media/resolver.js'
import { resolveKickDirect } from '../media/kickDirect.js'
import { resolveTwitchDirect } from '../media/twitchDirect.js'
import type { Logger } from './logger.js'

/**
 * Turns a pasted URL into a fully described VodSource.
 *
 * Metadata resolution and format inspection are separate steps: the editor only
 * needs metadata + a playback URL to start work, and formats are inspected
 * before an export so the quality panel never claims something untested.
 */
export class SourceService {
  private formatCache = new Map<string, { at: number; formats: StreamInfo[] }>()

  constructor(
    private readonly log: Logger,
    private readonly registry: AdapterRegistry,
    private readonly resolver: ResolverService,
    /**
     * Which browser's cookies yt-dlp may borrow, read fresh on each resolve.
     *
     * A function rather than a value because the setting can change while the
     * app runs, and a stale copy would silently keep failing on exactly the
     * VODs this exists to reach. Returns null when the person has not chosen
     * one, which is the default.
     */
    private readonly cookiesFromBrowser: () => string | null = () => null
  ) {}

  async resolve(url: string, opts: { signal?: AbortSignal } = {}): Promise<VodSource> {
    const { adapter, match } = this.registry.detect(url)
    this.log.info('source', 'Platform detected', {
      platform: adapter.id,
      vodId: match.vodId,
      url: match.canonicalUrl
    })

    const raw = await this.resolveRaw(adapter.id, match, opts.signal)

    /*
     * A broadcast in progress is a source like any other — it just has no end
     * yet. The rolling buffer is what makes it clippable (see LiveService),
     * and the archive replaces it as the media once the platform publishes
     * one. What it is NOT is a VOD with a duration, so the checks below that
     * exist to catch a broken VOD have to know the difference.
     */
    const isLive = raw.is_live === true

    /*
     * A channel link with no recording behind it is the one case where the
     * person asked about a person, not a recording, and the honest answer is
     * that there is nothing to open.
     *
     * `!isLive` alone is no longer that case. A live broadcast is now opened as
     * the recording the platform is already writing — hours of it, seekable and
     * clippable from the start — which arrives here as an ordinary VOD with
     * `is_live: false`. Formats are what say whether a recording was found.
     */
    if (match.kind === 'channel' && !isLive && (raw.formats?.length ?? 0) === 0) {
      throw Errors.vodUnavailable(
        `${raw.channel ?? raw.uploader ?? match.vodId} is not live right now. Paste a link to one of their VODs, or add them as a streamer to be told when they go live.`
      )
    }

    const source = {
      ...adapter.buildSource(match, raw),
      ...(isLive ? { isLive: true } : {}),
      // Opened from a channel that was on air: an ordinary VOD that is still
      // growing. See `still_recording` on RawInfo.
      ...(raw.still_recording === true ? { stillRecording: true } : {}),
      channelHandle: channelHandleFrom(raw, url)
    }

    // A live broadcast's "duration" is however much of it has happened so
    // far — a floor that moves, not a length — so an absent or zero one says
    // nothing is wrong. On a finished VOD it means the platform gave us
    // something we cannot cut against.
    if (!isLive && (!Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0)) {
      throw Errors.vodUnavailable('the platform did not report a duration for this VOD')
    }

    // Cache the formats we already have from this resolve, but do not mark the
    // source as inspected — that is an explicit, user-visible step.
    const formats = toStreamInfos(raw)
    if (formats.length > 0) {
      this.formatCache.set(source.id, { at: Date.now(), formats })
    }

    this.log.info('source', isLive ? 'Live broadcast resolved' : 'VOD resolved', {
      id: source.id,
      title: source.title,
      duration: source.durationSeconds,
      live: isLive,
      formats: formats.length
    })
    return source
  }

  /**
   * Re-ask the platform about a source already in the project.
   *
   * Two facts that go stale the moment they are read: whether the broadcast is
   * still on air, and how long the recording is *now*. A project saved an hour
   * ago holds neither — which is why a wall reopened from a saved project
   * showed "Not recording at this moment" on every angle but the focused one,
   * and why the timeline stopped where each broadcast was when it was added.
   *
   * One resolve per angle against the same document the original resolve used.
   */
  async liveStatus(source: VodSource, signal?: AbortSignal): Promise<LiveStatus | null> {
    const { adapter, match } = this.registry.detect(source.url)
    if (!adapter || !match) return null
    try {
      const raw = await this.resolveRaw(adapter.id, match, signal)
      return {
        durationSeconds: Number.isFinite(raw.duration) && (raw.duration ?? 0) > 0
          ? (raw.duration as number)
          : source.durationSeconds,
        stillRecording: raw.still_recording === true
      }
    } catch {
      // Best effort by design: an angle that cannot be re-asked keeps whatever
      // the project already knew rather than losing it.
      return null
    }
  }

  /**
   * The platform's own API first; yt-dlp only if that fails.
   *
   * Kick and Twitch are both resolved directly now, which leaves yt-dlp
   * carrying YouTube alone — where its signature-cipher work genuinely cannot
   * be reproduced cheaply, and where it earns the process spawn.
   *
   * These two used to be the other way round, and the log says what that cost:
   * nineteen "yt-dlp could not read this Kick VOD; trying Kick directly"
   * warnings, each one a process spawned, a bot check failed and a couple of
   * seconds spent, before falling back to the path that was always going to be
   * the one that worked. yt-dlp's Kick extractor does not match /video/<uuid>
   * links at all and needs its impersonation extra to get past Kick's bot
   * check; Kick's own API needs neither and is what the channel listing
   * already uses.
   *
   * yt-dlp is kept as the fallback rather than removed: it is the one that
   * handles the older /video/ link shapes if Kick ever changes the API shape
   * underneath us.
   */
  private async resolveRaw(
    platform: string,
    match: UrlMatch,
    signal?: AbortSignal
  ): Promise<RawInfo> {
    const direct =
      platform === 'kick'
        ? resolveKickDirect
        : platform === 'twitch'
          ? resolveTwitchDirect
          : null

    if (direct) {
      try {
        return await direct(match, this.log, signal)
      } catch (err) {
        if (err instanceof AppError && err.code === 'cancelled') throw err
        // An authentication requirement is a real answer, not a reason to go
        // and ask a second tool: yt-dlp without credentials will refuse a
        // subscriber-only VOD too, and burying the honest error under a
        // generic resolver failure is how "this VOD needs an account" turns
        // into "something went wrong".
        if (err instanceof AppError && err.code === 'auth-required') throw err
        this.log.warn('source', `${platform} API could not read this VOD; trying yt-dlp`, err)
        try {
          return await this.resolver.resolve(match.canonicalUrl, {
            signal,
            cookiesFromBrowser: this.cookiesFromBrowser()
          })
        } catch (fallbackErr) {
          // Report whichever failure tells the user the most.
          throw fallbackErr instanceof AppError && fallbackErr.code !== 'resolver-failed'
            ? fallbackErr
            : err
        }
      }
    }
    return this.resolver.resolve(match.canonicalUrl, {
      signal,
      cookiesFromBrowser: this.cookiesFromBrowser()
    })
  }

  /**
   * Inspect the real media formats. Signed media URLs expire, so a cached
   * inspection older than the TTL is refreshed from the platform.
   */
  async inspectFormats(
    source: VodSource,
    opts: { signal?: AbortSignal; maxAgeMs?: number } = {}
  ): Promise<StreamInfo[]> {
    const maxAge = opts.maxAgeMs ?? 4 * 60 * 1000
    const cached = this.formatCache.get(source.id)
    if (cached && Date.now() - cached.at < maxAge) return cached.formats

    const { match } = this.registry.detect(source.url)
    const raw = await this.resolveRaw(source.platform, match, opts.signal)
    const formats = toStreamInfos(raw)
    if (formats.length === 0) {
      throw Errors.qualityUnavailable(
        'any downloadable stream',
        'the resolver reported no usable formats for this VOD'
      )
    }
    this.formatCache.set(source.id, { at: Date.now(), formats })
    return formats
  }

  invalidate(sourceId: string): void {
    this.formatCache.delete(sourceId)
  }
}

/**
 * The channel's handle as its platform spells it. yt-dlp reports the login in
 * `uploader_id` (`channel` on some extractors); Kick links carry the slug in
 * the path. Display names are a last resort because they can contain spaces
 * and change without the channel changing.
 */
export function channelHandleFrom(raw: RawInfo, url: string): string | undefined {
  const fromPath = kickSlug(url)
  const candidate = fromPath ?? raw.uploader_id ?? raw.channel ?? raw.uploader
  const handle = (candidate ?? '').trim().replace(/^@/, '')
  return handle === '' || /\s/.test(handle) ? undefined : handle
}

function kickSlug(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (!/(^|\.)kick\.com$/i.test(parsed.hostname)) return undefined
    const parts = parsed.pathname.split('/').filter(Boolean)
    return parts[1] === 'videos' ? parts[0] : undefined
  } catch {
    return undefined
  }
}

/**
 * Is this recording still being written, and how long is it now?
 *
 * Two facts that are only true for a moment. A broadcast opened as the VOD the
 * platform is already making keeps growing, so its length is a floor rather
 * than a limit — and a project saved an hour ago holds neither fact any more.
 * Re-asking is one request per angle against the same document the resolve
 * already used.
 */
export interface LiveStatus {
  durationSeconds: number
  stillRecording: boolean
}
