import type { PlatformId, StreamInfo, VodSource } from '../../shared/types.js'
import type { PlatformQuality, PlatformComparison, StreamerVod } from '../../shared/ipc.js'
import { rankVideo, selectStreams } from '../media/formats.js'
import { channelVideosUrl } from './streamers.js'
import { fetchProfile } from './streamerProfile.js'
import type { ResolverService } from '../media/resolver.js'
import type { Logger } from './logger.js'

/**
 * The same person, on all three platforms, ranked by what their broadcast
 * actually looks like there.
 *
 * A restreamer publishes the same session to Kick, Twitch and YouTube, and the
 * copies are not equal: one platform's archive may be 1080p60 where another's
 * is 720p30, and the difference is invisible until you have already cut from
 * the wrong one. Nobody wants to resolve three URLs by hand to find that out.
 *
 * Every step fails soft and independently. A handle that exists on one
 * platform and not the others is the normal case, not an error, and a channel
 * that cannot be read says so in its own row rather than emptying the table.
 */

export interface CrossPlatformDeps {
  log: Logger
  resolver: ResolverService
  /** Newest broadcasts for a channel, cheaply — no per-VOD date lookups. */
  listChannelVods: (platform: PlatformId, handle: string) => Promise<StreamerVod[]>
  /** Full resolve of one VOD, which is what carries the formats. */
  resolveSource: (url: string) => Promise<VodSource>
}

const PLATFORMS: PlatformId[] = ['twitch', 'kick', 'youtube']

export async function compareAcrossPlatforms(
  handle: string,
  deps: CrossPlatformDeps
): Promise<PlatformComparison> {
  const name = handle.replace(/^@/, '').trim()
  const options = await Promise.all(
    PLATFORMS.map((platform) => onePlatform(platform, name, deps))
  )
  return { handle: name, options, bestPlatform: bestOf(options) }
}

async function onePlatform(
  platform: PlatformId,
  handle: string,
  deps: CrossPlatformDeps
): Promise<PlatformQuality> {
  const base: PlatformQuality = {
    platform,
    handle,
    channelUrl: channelVideosUrl(platform, handle),
    found: false
  }

  try {
    // The cheap question first: a channel that does not exist costs one
    // request, not a listing and a resolve.
    const profile = await fetchProfile(platform, handle, deps.resolver)
    if (!profile) return base

    const vods = await deps.listChannelVods(platform, handle)
    const newest = vods[0]
    if (!newest) {
      return { ...base, found: true, displayName: profile.displayName }
    }

    const source = await deps.resolveSource(newest.url)
    const formats = source.formats ?? []
    if (formats.length === 0) {
      return {
        ...base,
        found: true,
        displayName: profile.displayName,
        vod: { url: newest.url, title: newest.title, publishedAt: newest.publishedAt },
        error: 'No downloadable streams were offered for that broadcast.'
      }
    }

    const best = selectStreams(formats, 'best')
    return {
      ...base,
      found: true,
      displayName: profile.displayName,
      vod: { url: newest.url, title: newest.title, publishedAt: newest.publishedAt },
      ...(best.video ? { video: describeVideo(best.video) } : {}),
      ...(best.audio ? { audio: describeAudio(best.audio) } : {})
    }
  } catch (err) {
    deps.log.debug('streamers', 'Cross-platform check failed', { platform, handle, err })
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

function describeVideo(stream: StreamInfo): NonNullable<PlatformQuality['video']> {
  return {
    label: stream.label,
    ...(stream.width !== undefined ? { width: stream.width } : {}),
    ...(stream.height !== undefined ? { height: stream.height } : {}),
    ...(stream.fps !== undefined ? { fps: stream.fps } : {}),
    ...(stream.bitrate !== undefined ? { bitrate: stream.bitrate } : {}),
    ...(stream.codec !== undefined ? { codec: stream.codec } : {})
  }
}

function describeAudio(stream: StreamInfo): NonNullable<PlatformQuality['audio']> {
  return {
    ...(stream.bitrate !== undefined ? { bitrate: stream.bitrate } : {}),
    ...(stream.channels !== undefined ? { channels: stream.channels } : {}),
    ...(stream.sampleRate !== undefined ? { sampleRate: stream.sampleRate } : {}),
    ...(stream.codec !== undefined ? { codec: stream.codec } : {})
  }
}

/**
 * Which platform to cut from — the same ranking the exporter uses to pick a
 * format, so the answer here and the file that comes out agree.
 *
 * Exported for its own test: this is the one line of the feature that is a
 * judgement rather than a fetch.
 */
export function bestOf(options: PlatformQuality[]): PlatformId | null {
  const withVideo = options.filter((o) => o.video)
  if (withVideo.length === 0) return null
  return withVideo.slice().sort((a, b) =>
    rankVideo(
      { ...(a.video as object), id: '', protocol: 'hls', label: '', url: '', hasVideo: true, hasAudio: false } as StreamInfo,
      { ...(b.video as object), id: '', protocol: 'hls', label: '', url: '', hasVideo: true, hasAudio: false } as StreamInfo
    )
  )[0].platform
}
