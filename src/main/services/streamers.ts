import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { net } from 'electron'
import { Errors } from '../../shared/errors.js'
import type { PlatformId } from '../../shared/types.js'
import type { EventOverlapReply, SavedStreamer, StreamerGroup, StreamerVod } from '../../shared/ipc.js'
import { streamsCoveringEvent } from '../../shared/eventStreams.js'
import type { WatermarkConfig } from '../../shared/watermark.js'
import { createId } from '../../shared/clips.js'
import { isStreamerGroupColor } from '../../shared/streamerGroupColors.js'
import { atomicWriteJson } from './projects.js'
import type { Logger } from './logger.js'
import type { ResolverService } from '../media/resolver.js'
import { ConcurrencyLimiter } from './limiter.js'

/**
 * The streamer library: channels the editor works with regularly, and their
 * recent VODs.
 *
 * A NoPixel event is covered by the same handful of people week after week, so
 * hunting down each one's channel page and copying a link every session is the
 * bulk of the busywork this app exists to remove.
 */

export interface StreamerListing {
  streamer: SavedStreamer
  vods: StreamerVod[]
}

/** Where a platform lists a channel's past broadcasts. */
export function channelVideosUrl(platform: PlatformId, handle: string): string {
  const name = handle.replace(/^@/, '')
  if (platform === 'twitch') return `https://www.twitch.tv/${name}/videos?filter=archives`
  if (platform === 'youtube') return `https://www.youtube.com/@${name}/streams`
  return `https://kick.com/${name}`
}

/**
 * Recognise a channel link (not a VOD link) and pull the handle out of it.
 * Returns null for anything that is not a channel page, so a pasted VOD URL is
 * never mistaken for a streamer.
 */
export function parseChannelUrl(input: string): { platform: PlatformId; handle: string } | null {
  const text = input.trim()
  if (text === '') return null

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'twitch.tv') {
    if (!parts[0] || ['videos', 'directory', 'settings'].includes(parts[0])) return null
    return { platform: 'twitch', handle: parts[0] }
  }
  if (host === 'kick.com') {
    if (!parts[0] || ['video', 'browse', 'categories', 'search'].includes(parts[0])) return null
    return { platform: 'kick', handle: parts[0] }
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const handle = parts.find((p) => p.startsWith('@'))
    if (handle) return { platform: 'youtube', handle: handle.slice(1) }
    if (parts[0] === 'c' && parts[1]) return { platform: 'youtube', handle: parts[1] }
    if (parts[0] === 'channel' && parts[1]) return { platform: 'youtube', handle: parts[1] }
    return null
  }
  return null
}

/** Same channel twice — by platform and handle, case-insensitively. */
export function sameStreamer(a: SavedStreamer, b: { platform: PlatformId; handle: string }): boolean {
  return a.platform === b.platform && a.handle.toLowerCase() === b.handle.toLowerCase()
}

/** Kick's channel VOD list → the shape the picker shows. */
export function kickVodsFromChannel(payload: unknown, slug: string): StreamerVod[] {
  if (!Array.isArray(payload)) return []
  const out: StreamerVod[] = []
  for (const entry of payload as Array<Record<string, any>>) {
    const uuid = entry?.video?.uuid
    if (typeof uuid !== 'string') continue
    const started = (entry.start_time ?? entry.created_at ?? '') as string
    out.push({
      url: `https://kick.com/${slug}/videos/${uuid}`,
      title: typeof entry.session_title === 'string' ? entry.session_title : `VOD ${uuid.slice(0, 8)}`,
      durationSeconds: typeof entry.duration === 'number' ? Math.round(entry.duration / 1000) : null,
      publishedAt: started ? new Date(started.replace(' ', 'T').replace(/Z?$/, 'Z')).toISOString() : null,
      thumbnailUrl:
        typeof entry.thumbnail?.src === 'string'
          ? entry.thumbnail.src
          : typeof entry.thumbnail?.url === 'string'
            ? entry.thumbnail.url
            : undefined,
      viewCount: typeof entry.views === 'number' ? entry.views : undefined
    })
  }
  return out
}

/** yt-dlp's flat playlist of a channel's videos → the same shape. */
/**
 * yt-dlp reports a video's date as either a Unix timestamp or an 8-digit
 * `YYYYMMDD` string, when it reports one at all — used both for the flat
 * channel listing (which usually has neither) and a full per-video lookup
 * (which reliably does).
 */
export function publishedAtFromRawInfo(entry: {
  timestamp?: number
  upload_date?: string
}): string | null {
  if (typeof entry.timestamp === 'number') return new Date(entry.timestamp * 1000).toISOString()
  if (typeof entry.upload_date === 'string' && /^\d{8}$/.test(entry.upload_date)) {
    return `${entry.upload_date.slice(0, 4)}-${entry.upload_date.slice(4, 6)}-${entry.upload_date.slice(6, 8)}T00:00:00.000Z`
  }
  return null
}

export function vodsFromFlatPlaylist(payload: unknown): StreamerVod[] {
  const entries = (payload as { entries?: Array<Record<string, any>> } | null)?.entries
  if (!Array.isArray(entries)) return []
  const out: StreamerVod[] = []
  for (const entry of entries) {
    const url =
      typeof entry.url === 'string'
        ? entry.url
        : typeof entry.webpage_url === 'string'
          ? entry.webpage_url
          : null
    if (!url || entry.live_status === 'is_live') continue
    out.push({
      url,
      title: typeof entry.title === 'string' ? entry.title : url,
      durationSeconds: typeof entry.duration === 'number' ? Math.round(entry.duration) : null,
      publishedAt: publishedAtFromRawInfo(entry),
      thumbnailUrl: typeof entry.thumbnail === 'string' ? entry.thumbnail : undefined,
      viewCount: typeof entry.view_count === 'number' ? entry.view_count : undefined
    })
  }
  return out
}

export class StreamerService {
  private readonly file: string
  private cache: SavedStreamer[] | null = null
  private readonly groupsFile: string
  private groupsCache: StreamerGroup[] | null = null
  private readonly dateLookupLimiter = new ConcurrencyLimiter(4)

  constructor(
    private readonly log: Logger,
    private readonly resolver: ResolverService,
    stateDir: string
  ) {
    this.file = join(stateDir, 'streamers.json')
    this.groupsFile = join(stateDir, 'streamer-groups.json')
  }

  async list(): Promise<SavedStreamer[]> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      this.cache = Array.isArray(parsed) ? (parsed as SavedStreamer[]).filter(isStreamer) : []
    } catch {
      this.cache = []
    }
    return this.cache
  }

  async listGroups(): Promise<StreamerGroup[]> {
    if (this.groupsCache) return this.groupsCache
    try {
      const parsed = JSON.parse(await readFile(this.groupsFile, 'utf8')) as unknown
      this.groupsCache = Array.isArray(parsed)
        ? (parsed as StreamerGroup[]).filter(isGroup).map((g) => ({
            ...g,
            color: isStreamerGroupColor(g.color) ? g.color : undefined
          }))
        : []
    } catch {
      this.groupsCache = []
    }
    return this.groupsCache
  }

  async createGroup(name: string, icon?: string, color?: string): Promise<StreamerGroup[]> {
    const trimmed = name.trim()
    if (trimmed === '') return this.listGroups()
    const current = await this.listGroups()
    const existing = current.find((g) => g.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return current
    const group: StreamerGroup = {
      id: createId('grp'),
      name: trimmed,
      ...(icon?.trim() ? { icon: icon.trim() } : {}),
      ...(isStreamerGroupColor(color) ? { color } : {})
    }
    return this.writeGroups([...current, group])
  }

  async updateGroup(
    id: string,
    patch: Partial<Pick<StreamerGroup, 'name' | 'icon' | 'color'>>
  ): Promise<StreamerGroup[]> {
    const current = await this.listGroups()
    return this.writeGroups(
      current.map((g) => {
        if (g.id !== id) return g
        const next = { ...g }
        if (patch.name !== undefined && patch.name.trim() !== '') next.name = patch.name.trim()
        if (patch.icon !== undefined) {
          if (patch.icon.trim() === '') delete next.icon
          else next.icon = patch.icon.trim()
        }
        if (patch.color !== undefined) {
          if (isStreamerGroupColor(patch.color)) next.color = patch.color
          else delete next.color
        }
        return next
      })
    )
  }

  /** Also strips the group from every streamer's membership list. */
  async deleteGroup(id: string): Promise<StreamerGroup[]> {
    const [groups, streamers] = await Promise.all([this.listGroups(), this.list()])
    const stillMember = streamers.filter((s) => s.groupIds?.includes(id))
    if (stillMember.length > 0) {
      await this.write(
        streamers.map((s) =>
          s.groupIds?.includes(id) ? { ...s, groupIds: s.groupIds.filter((g) => g !== id) } : s
        )
      )
    }
    return this.writeGroups(groups.filter((g) => g.id !== id))
  }

  /** Replaces a streamer's whole group membership list — the renderer sends the final set. */
  async setGroups(streamerId: string, groupIds: string[]): Promise<SavedStreamer[]> {
    const current = await this.list()
    return this.write(current.map((s) => (s.id === streamerId ? { ...s, groupIds } : s)))
  }

  private async writeGroups(next: StreamerGroup[]): Promise<StreamerGroup[]> {
    this.groupsCache = next
    await atomicWriteJson(this.groupsFile, next)
    return next
  }

  /** Add by channel URL or "platform:handle"; adding an existing one is a no-op. */
  async add(input: string, platformHint?: PlatformId): Promise<SavedStreamer[]> {
    const parsed = parseChannelUrl(input) ?? handleOnly(input, platformHint)
    if (!parsed) {
      throw Errors.unsupportedUrl(
        `${input} — paste a channel address such as twitch.tv/name, kick.com/name or youtube.com/@name.`
      )
    }

    const current = await this.list()
    const existing = current.find((s) => sameStreamer(s, parsed))
    if (existing) return current

    const streamer: SavedStreamer = {
      id: createId('str'),
      platform: parsed.platform,
      handle: parsed.handle,
      displayName: parsed.handle,
      channelUrl: channelVideosUrl(parsed.platform, parsed.handle),
      addedAt: new Date().toISOString(),
      lastUsedAt: null
    }
    return this.write([...current, streamer])
  }

  /**
   * Remember the channel behind a POV that was just loaded. Adding a VOD is a
   * statement that this streamer matters, so the library learns it without the
   * editor typing it twice; an existing entry is left exactly as it is.
   */
  async remember(source: {
    platform: PlatformId
    channelHandle?: string
    creator?: string
    title?: string
  }): Promise<SavedStreamer[]> {
    const handle = (source.channelHandle ?? '').trim()
    if (handle === '' || /\s/.test(handle)) {
      // No usable handle — a display name with spaces would produce a channel
      // URL that lists nothing, which is worse than not saving it.
      return this.list()
    }
    const current = await this.list()
    const existing = current.find((s) => sameStreamer(s, { platform: source.platform, handle }))
    if (existing) return current

    const streamer: SavedStreamer = {
      id: createId('str'),
      platform: source.platform,
      handle,
      displayName: (source.creator ?? handle).trim() || handle,
      channelUrl: channelVideosUrl(source.platform, handle),
      addedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString()
    }
    this.log.info('streamers', 'Saved a streamer from a loaded POV', {
      platform: source.platform,
      handle
    })
    return this.write([...current, streamer])
  }

  async remove(id: string): Promise<SavedStreamer[]> {
    const current = await this.list()
    return this.write(current.filter((s) => s.id !== id))
  }

  /**
   * Store this streamer's default watermark, or clear it.
   *
   * Only ever called when the editor explicitly asks — editing a VOD's own
   * watermark must not quietly rewrite the default for every other broadcast
   * from that channel.
   */
  async setWatermark(id: string, watermark: WatermarkConfig | null): Promise<SavedStreamer[]> {
    const current = await this.list()
    return this.write(
      current.map((s) =>
        s.id === id ? { ...s, watermark: watermark ?? undefined } : s
      )
    )
  }

  /**
   * Which saved streamers were broadcasting during an event.
   *
   * Every saved channel is asked for its recent broadcasts, and the overlap is
   * decided on the wall clock. One unreachable channel does not sink the
   * answer — it is named in `unreachable` so a partial result is never passed
   * off as a complete one.
   */
  async coveringEvent(req: {
    eventStartSeconds: number
    eventEndSeconds: number
    loadedUrls: string[]
  }): Promise<EventOverlapReply> {
    const streamers = await this.list()
    const unreachable: string[] = []

    const library = await Promise.all(
      streamers.map(async (streamer) => {
        try {
          return {
            streamerId: streamer.id,
            streamerName: streamer.displayName,
            platform: streamer.platform,
            vods: await this.vods(streamer.id)
          }
        } catch (err) {
          this.log.warn('streamers', 'Could not list a channel while searching an event', {
            handle: streamer.handle,
            error: err
          })
          unreachable.push(streamer.displayName)
          return {
            streamerId: streamer.id,
            streamerName: streamer.displayName,
            platform: streamer.platform,
            vods: [] as StreamerVod[]
          }
        }
      })
    )

    // A URL can appear under more than one id if the same VOD was loaded twice;
    // the first wins, which is the one the project actually holds.
    const loaded = new Map<string, string>()
    for (const url of req.loadedUrls) if (!loaded.has(url)) loaded.set(url, url)

    const streams = streamsCoveringEvent({
      eventStartSeconds: req.eventStartSeconds,
      eventEndSeconds: req.eventEndSeconds,
      library,
      loaded
    })

    return {
      streams: streams.map((s) => ({
        streamerId: s.streamerId,
        streamerName: s.streamerName,
        platform: s.platform as SavedStreamer['platform'],
        vod: s.vod,
        availability: s.availability,
        coverage: {
          fraction: s.coverage.fraction,
          complete: s.coverage.complete,
          offsetSeconds: s.coverage.offsetSeconds,
          certain: s.coverage.certain
        }
      })),
      unreachable
    }
  }

  async touch(id: string): Promise<SavedStreamer[]> {
    const current = await this.list()
    return this.write(
      current.map((s) => (s.id === id ? { ...s, lastUsedAt: new Date().toISOString() } : s))
    )
  }

  /** Recent VODs for one saved streamer, newest first. */
  async vods(id: string, signal?: AbortSignal): Promise<StreamerVod[]> {
    const streamer = (await this.list()).find((s) => s.id === id)
    if (!streamer) throw Errors.unsupportedUrl(`unknown streamer ${id}`)

    const vods =
      streamer.platform === 'kick'
        ? await this.kickVods(streamer, signal)
        : await this.resolverVods(streamer, signal)

    this.log.info('streamers', 'Listed recent VODs', {
      platform: streamer.platform,
      handle: streamer.handle,
      count: vods.length
    })
    return vods
      .slice()
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
      .slice(0, 40)
  }

  private async kickVods(streamer: SavedStreamer, signal?: AbortSignal): Promise<StreamerVod[]> {
    // yt-dlp has no Kick channel extractor, and Kick's own list is what makes
    // its new-style VOD links resolvable anyway.
    const url = `https://kick.com/api/v2/channels/${encodeURIComponent(streamer.handle)}/videos`
    const response = await net.fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        accept: 'application/json',
        referer: 'https://kick.com/'
      },
      signal
    })
    if (!response.ok) {
      if (response.status === 404) {
        throw Errors.vodUnavailable(`Kick has no channel called ${streamer.handle}.`)
      }
      throw Errors.kickBlocked(`Kick answered HTTP ${response.status} listing ${streamer.handle}'s VODs`)
    }
    return kickVodsFromChannel(await response.json(), streamer.handle)
  }

  private async resolverVods(streamer: SavedStreamer, signal?: AbortSignal): Promise<StreamerVod[]> {
    const raw = await this.resolver.flatPlaylist(streamer.channelUrl, { signal })
    const vods = vodsFromFlatPlaylist(raw)
    return this.enrichWithDates(vods, signal)
  }

  /**
   * The flat channel listing yt-dlp uses to list VODs in one request never
   * carries a date for Twitch or YouTube (Kick's own API always does — see
   * kickVods). The date only exists on each VOD's own page, so getting it
   * costs one extra yt-dlp call per VOD; bounded to a handful at once so a
   * channel with many VODs doesn't spawn dozens of processes together, and
   * one VOD's lookup failing (deleted, rate-limited, whatever) only leaves
   * that one undated rather than failing the whole list.
   */
  private async enrichWithDates(vods: StreamerVod[], signal?: AbortSignal): Promise<StreamerVod[]> {
    return Promise.all(
      vods.map(async (vod) => {
        if (vod.publishedAt !== null) return vod
        try {
          const info = await this.dateLookupLimiter.run(() => this.resolver.resolve(vod.url, { signal }))
          const publishedAt = publishedAtFromRawInfo(info)
          return publishedAt ? { ...vod, publishedAt } : vod
        } catch {
          return vod
        }
      })
    )
  }

  private async write(next: SavedStreamer[]): Promise<SavedStreamer[]> {
    this.cache = next
    await atomicWriteJson(this.file, next)
    return next
  }
}

function handleOnly(
  input: string,
  platform: PlatformId | undefined
): { platform: PlatformId; handle: string } | null {
  const text = input.trim().replace(/^@/, '')
  if (!platform || text === '' || /[\s/]/.test(text)) return null
  return { platform, handle: text }
}

function isStreamer(value: unknown): value is SavedStreamer {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return typeof s.id === 'string' && typeof s.handle === 'string' && typeof s.platform === 'string'
}

function isGroup(value: unknown): value is StreamerGroup {
  if (typeof value !== 'object' || value === null) return false
  const g = value as Record<string, unknown>
  return typeof g.id === 'string' && typeof g.name === 'string'
}
