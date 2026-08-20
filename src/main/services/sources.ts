import { AppError, Errors } from '../../shared/errors.js'
import type { StreamInfo, VodSource } from '../../shared/types.js'
import type { AdapterRegistry } from '../platforms/registry.js'
import type { UrlMatch } from '../platforms/types.js'
import type { ResolverService } from '../media/resolver.js'
import { toStreamInfos } from '../media/resolver.js'
import type { RawInfo } from '../media/resolver.js'
import { resolveKickDirect } from '../media/kickDirect.js'
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
    private readonly resolver: ResolverService
  ) {}

  async resolve(url: string, opts: { signal?: AbortSignal } = {}): Promise<VodSource> {
    const { adapter, match } = this.registry.detect(url)
    this.log.info('source', 'Platform detected', {
      platform: adapter.id,
      vodId: match.vodId,
      url: match.canonicalUrl
    })

    const raw = await this.resolveRaw(adapter.id, match, opts.signal)

    if (raw.is_live) {
      throw Errors.vodUnavailable(
        'This URL points at a live broadcast rather than a finished VOD. Wait until the stream ends and the VOD is published.'
      )
    }

    const source = { ...adapter.buildSource(match, raw), channelHandle: channelHandleFrom(raw, url) }
    if (!Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0) {
      throw Errors.vodUnavailable('the platform did not report a duration for this VOD')
    }

    // Cache the formats we already have from this resolve, but do not mark the
    // source as inspected — that is an explicit, user-visible step.
    const formats = toStreamInfos(raw)
    if (formats.length > 0) {
      this.formatCache.set(source.id, { at: Date.now(), formats })
    }

    this.log.info('source', 'VOD resolved', {
      id: source.id,
      title: source.title,
      duration: source.durationSeconds,
      formats: formats.length
    })
    return source
  }

  /**
   * yt-dlp first, then Kick's own API.
   *
   * yt-dlp's Kick extractor does not match /video/<uuid> links at all and needs
   * its impersonation extra to get past Kick's bot check, so a working link can
   * fail on an otherwise healthy install. Other platforms have no such fallback
   * and surface the resolver's error directly.
   */
  private async resolveRaw(
    platform: string,
    match: UrlMatch,
    signal?: AbortSignal
  ): Promise<RawInfo> {
    try {
      return await this.resolver.resolve(match.canonicalUrl, { signal })
    } catch (err) {
      if (platform !== 'kick' || (err instanceof AppError && err.code === 'cancelled')) throw err
      this.log.warn('source', 'yt-dlp could not read this Kick VOD; trying Kick directly', err)
      try {
        return await resolveKickDirect(match, this.log, signal)
      } catch (fallbackErr) {
        // Report whichever failure tells the user the most.
        throw fallbackErr instanceof AppError && fallbackErr.code !== 'resolver-failed'
          ? fallbackErr
          : err
      }
    }
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
