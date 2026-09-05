import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { net } from 'electron'
import { Errors } from '../../shared/errors.js'
import type { PlatformId } from '../../shared/types.js'
import type {
  LiveNow,
  EventOverlapReply,
  SavedStreamer,
  StreamerGroup,
  StreamerParticipation,
  StreamerVod,
  StreamerVodShelf
} from '../../shared/ipc.js'
import { streamsCoveringEvent } from '../../shared/eventStreams.js'
import type { WatermarkConfig } from '../../shared/watermark.js'
import { createId } from '../../shared/clips.js'
import { isStreamerGroupColor } from '../../shared/streamerGroupColors.js'
import { isStreamerGroupIconName } from '../../shared/streamerGroupIcons.js'
import { atomicWriteJson, parseJsonSalvagingTail } from './projects.js'
import type { Logger } from './logger.js'
import type { ResolverService } from '../media/resolver.js'
import { ConcurrencyLimiter } from './limiter.js'
import type { ProcessPriority } from './process.js'
import {
  fetchLive,
  fetchProfile,
  profileIsStale,
  twitchVideoDates
} from './streamerProfile.js'

/**
 * The streamer library: channels the editor works with regularly, and their
 * recent VODs.
 *
 * A NoPixel event is covered by the same handful of people week after week, so
 * hunting down each one's channel page and copying a link every session is the
 * bulk of the busywork this app exists to remove.
 */

/**
 * How stale a saved live snapshot may be before it is ignored on startup.
 *
 * Long enough to survive a restart mid-session, short enough that it never
 * tells you somebody is on air because they were when you closed the app last
 * night.
 */
const LIVE_SNAPSHOT_MAX_AGE_MS = 5 * 60_000

/**
 * How long a YouTube live answer is carried over.
 *
 * Its check costs a yt-dlp process, unlike the plain HTTP the other two use,
 * so it runs on a slower clock than the rest of the poll.
 */
const YOUTUBE_LIVE_TTL_MS = 5 * 60_000

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
/**
 * One spelling of a channel name, so the same channel is recognised as itself.
 *
 * The handle arrives from three places that disagree: a pasted URL, a resolved
 * POV's `channelHandle` (YouTube's comes back with the leading `@`), and the
 * sibling search, which uses whatever the *other* platform spells it. Stored
 * as-is, "@name" and "name" are two different channels — so the duplicate
 * check misses, both get saved, and the roster shows the same person twice.
 */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '')
}

/** The key two records must share to be the same channel: platform + name. */
export function channelKey(platform: PlatformId, handle: string): string {
  return `${platform}:${normalizeHandle(handle).toLowerCase()}`
}

export function sameStreamer(a: SavedStreamer, b: { platform: PlatformId; handle: string }): boolean {
  return channelKey(a.platform, a.handle) === channelKey(b.platform, b.handle)
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

/**
 * How far back a single channel listing reaches.
 *
 * High enough to be "everything" for any real channel, and still a number
 * rather than infinity: yt-dlp will happily walk a listing until it runs out,
 * and a bound is what stops one pathological channel turning a background
 * crawl into an unbounded one.
 */
const CHANNEL_LISTING_MAX = 5000

export class StreamerService {
  private readonly file: string
  private readonly liveFile: string
  private cache: SavedStreamer[] | null = null
  private readonly groupsFile: string
  private groupsCache: StreamerGroup[] | null = null
  /** Bounds concurrent yt-dlp full resolves — used for date enrichment and quality probing alike. */
  private readonly resolveLimiter = new ConcurrencyLimiter(4)
  /** Profile lookups hit three different platforms; keep it gentle. */
  /**
   * Whether adding a streamer should go looking for their other channels.
   *
   * Set by the app at startup, off by default: this is the one thing here that
   * does work nobody asked for, and it must be something a caller opts into.
   */
  autoDiscoverSiblings = false

  /**
   * The crawled VOD library, as a lookup. Set by the app at startup; left
   * unset in tests, where a live listing is what is being tested.
   */
  shelfFor: ((streamerId: string) => StreamerVodShelf | null) | null = null

  private readonly profileLimiter = new ConcurrencyLimiter(3)

  constructor(
    private readonly log: Logger,
    private readonly resolver: ResolverService,
    stateDir: string
  ) {
    this.file = join(stateDir, 'streamers.json')
    this.groupsFile = join(stateDir, 'streamer-groups.json')
    this.liveFile = join(stateDir, 'streamer-live.json')
  }

  async list(): Promise<SavedStreamer[]> {
    if (this.cache) return this.cache
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = parseJsonSalvagingTail(text)

      /*
       * A file with a damaged tail is repaired, not refused.
       *
       * `atomicWriteJson` used to stage every concurrent write to one shared
       * temp file, so a library could be published as a complete array
       * followed by the tail of a longer one. The streamers are all still
       * there, in front of the damage — so take them, say so, and write the
       * file back clean. The staging bug is fixed; this is for the files it
       * already produced.
       */
      if (parsed === null) {
        throw new Error(`${this.file} is not readable JSON, even in part`)
      }
      if (text.trim() !== JSON.stringify(parsed, null, 2).trim() && Array.isArray(parsed)) {
        const salvaged = (parsed as SavedStreamer[]).filter(isStreamer)
        this.log.warn('streamers', 'Repaired a damaged streamer library', {
          recovered: salvaged.length,
          bytes: text.length
        })
        this.cache = salvaged
        void atomicWriteJson(this.file, salvaged).catch(() => undefined)
        return this.cache
      }

      this.cache = Array.isArray(parsed) ? (parsed as SavedStreamer[]).filter(isStreamer) : []
      return this.cache
    } catch (err) {
      /*
       * "No file yet" and "could not read the file" are NOT the same answer,
       * and treating them as one destroyed libraries.
       *
       * This used to return `[]` for any failure, and `[]` is a perfectly
       * valid list — so the very next write persisted it straight over a good
       * file and every saved streamer was gone. The read only has to fail
       * once, and it can: `atomicWriteJson` writes a temp file and renames it,
       * and on Windows a read landing inside that rename fails with EPERM or
       * EBUSY. Several writers running at once made that a matter of time.
       *
       * Missing is genuinely empty. Anything else is unknown, and unknown
       * refuses to be written over — the caller fails loudly instead, which is
       * recoverable, unlike silence.
       */
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.cache = []
        return this.cache
      }
      this.log.error('streamers', 'Could not read the streamer library', err)
      throw err
    }
  }

  async listGroups(): Promise<StreamerGroup[]> {
    if (this.groupsCache) return this.groupsCache
    try {
      const parsed = JSON.parse(await readFile(this.groupsFile, 'utf8')) as unknown
      this.groupsCache = Array.isArray(parsed)
        ? (parsed as StreamerGroup[]).filter(isGroup).map((g) => ({
            ...g,
            icon: isStreamerGroupIconName(g.icon) ? g.icon : undefined,
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
      ...(isStreamerGroupIconName(icon) ? { icon } : {}),
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
          if (isStreamerGroupIconName(patch.icon)) next.icon = patch.icon
          else delete next.icon
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

  /** Re-inserts a specific removed streamer as-is — the renderer's undo, not a plain re-add. */
  async restore(streamer: SavedStreamer): Promise<SavedStreamer[]> {
    const current = await this.list()
    if (current.some((s) => s.id === streamer.id)) return current
    return this.write([...current, streamer])
  }

  /** Pins/unpins a streamer to the top of the list, regardless of last-used date. */
  async setFavorite(streamerId: string, favorite: boolean): Promise<SavedStreamer[]> {
    const current = await this.list()
    return this.write(
      current.map((s) => {
        if (s.id !== streamerId) return s
        if (favorite) return { ...s, favorite: true }
        const { favorite: _drop, ...rest } = s
        return rest
      })
    )
  }

  /**
   * Mark two saved streamers as the same real person restreaming to more than
   * one platform. If either is already linked to others, the new streamer
   * joins that existing group rather than starting a second one.
   */
  async linkPerson(idA: string, idB: string): Promise<SavedStreamer[]> {
    if (idA === idB) return this.list()
    const current = await this.list()
    const a = current.find((s) => s.id === idA)
    const b = current.find((s) => s.id === idB)
    if (!a || !b) return current
    const personId = a.personId ?? b.personId ?? createId('person')
    return this.write(
      current.map((s) => (s.id === idA || s.id === idB ? { ...s, personId } : s))
    )
  }

  /** Undoes linkPerson for one streamer — a "link" of one streamer alone is meaningless. */
  async unlinkPerson(id: string): Promise<SavedStreamer[]> {
    const current = await this.list()
    const streamer = current.find((s) => s.id === id)
    if (!streamer?.personId) return current
    const personId = streamer.personId
    const others = current.filter((s) => s.personId === personId && s.id !== id)
    const stripPersonIds = new Set([id, ...(others.length === 1 ? [others[0]!.id] : [])])
    return this.write(
      current.map((s) => {
        if (!stripPersonIds.has(s.id)) return s
        const { personId: _drop, ...rest } = s
        return rest
      })
    )
  }

  /**
   * Best resolution available for each VOD, so a moment covered by two linked
   * streamers can be resolved to whichever copy is actually the better watch.
   * Bounded to a handful at once via the same limiter as date enrichment,
   * since both are the same underlying yt-dlp full resolve.
   */
  async probeQuality(urls: string[], signal?: AbortSignal): Promise<Record<string, number | null>> {
    const entries = await Promise.all(
      urls.map(async (url): Promise<[string, number | null]> => {
        try {
          const info = await this.resolveLimiter.run(() => this.resolver.resolve(url, { signal }))
          const heights = (info.formats ?? []).map((f) => f.height ?? 0)
          const best = heights.length > 0 ? Math.max(...heights) : 0
          return [url, best > 0 ? best : null]
        } catch {
          return [url, null]
        }
      })
    )
    return Object.fromEntries(entries)
  }

  private async writeGroups(next: StreamerGroup[]): Promise<StreamerGroup[]> {
    this.groupsCache = next
    await atomicWriteJson(this.groupsFile, next)
    return next
  }

  /** Add by channel URL or "platform:handle"; adding an existing one is a no-op. */
  async add(input: string, platformHint?: PlatformId): Promise<SavedStreamer[]> {
    const parsed =
      parseChannelUrl(input) ?? handleOnly(input, platformHint) ?? (await this.findHandle(input))
    if (!parsed) {
      throw normalizeHandle(input).includes('/')
        ? Errors.unsupportedUrl(
            `${input} — paste a channel address such as twitch.tv/name, kick.com/name or youtube.com/@name.`
          )
        : Errors.unknownChannel(input)
    }

    // The existence check and the insert have to be one step, or two callers
    // adding the same channel at once both find nothing and both add it.
    const before = await this.list()
    const saved = await this.mutate((current) => {
      if (current.some((s) => sameStreamer(s, parsed))) return { next: current, result: current }

      const streamer: SavedStreamer = {
        id: createId('str'),
        platform: parsed.platform,
        handle: parsed.handle,
        displayName: parsed.handle,
        channelUrl: channelVideosUrl(parsed.platform, parsed.handle),
        addedAt: new Date().toISOString(),
        lastUsedAt: null
      }
      const next = [...current, streamer]
      return { next, result: next }
    })
    this.discoverInBackground(before, saved)
    return saved
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
    /** The event this POV was loaded into, for §13's participation record. */
    event?: { projectId: string; projectName: string; eventName?: string }
  }): Promise<SavedStreamer[]> {
    const handle = normalizeHandle(source.channelHandle ?? '')
    if (handle === '' || /\s/.test(handle)) {
      // No usable handle — a display name with spaces would produce a channel
      // URL that lists nothing, which is worse than not saving it.
      return this.list()
    }
    // One step, for the same reason as `add`: loading several POVs from the
    // same channel at once must not save that channel several times.
    const before = await this.list()
    const saved = await this.mutate((current) => {
      const existing = current.find((s) => sameStreamer(s, { platform: source.platform, handle }))

      // An already-known channel still gains the participation record: the
      // point of §13 is what they have worked on, which grows every time.
      if (existing) {
        const next = source.event
          ? current.map((s) => (s.id === existing.id ? withParticipation(s, source.event!) : s))
          : current
        return { next, result: next }
      }

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
      const next = [...current, source.event ? withParticipation(streamer, source.event) : streamer]
      return { next, result: next }
    })
    // A POV loaded from a link is the same statement as adding by hand: this
    // person matters, so find the rest of their channels too.
    this.discoverInBackground(before, saved)
    return saved
  }

  async remove(id: string): Promise<SavedStreamer[]> {
    const current = await this.list()
    return this.write(current.filter((s) => s.id !== id), { allowEmpty: true })
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

    this.log.info('streamers', 'Searched the library for an event', {
      streamers: library.length,
      vods: library.reduce((n, entry) => n + entry.vods.length, 0),
      matched: streams.length,
      unreachable: unreachable.length
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

  /**
   * Fill in a channel's real name, picture and size.
   *
   * Fails soft on purpose: a profile is decoration, so a channel whose
   * platform will not answer keeps its handle and stays perfectly usable.
   * `profileFetchedAt` is written either way, so an unreachable channel is
   * not retried on every render.
   */
  async refreshProfile(id: string, force = false): Promise<SavedStreamer[]> {
    const current = await this.list()
    const streamer = current.find((s) => s.id === id)
    if (!streamer) return current
    if (!force && !profileIsStale(streamer.profileFetchedAt)) return current

    const profile = await this.profileLimiter.run(() =>
      fetchProfile(streamer.platform, streamer.handle, this.resolver)
    )
    const fetchedAt = new Date().toISOString()

    return this.write(
      current.map((s) =>
        s.id === id
          ? {
              ...s,
              profileFetchedAt: fetchedAt,
              ...(profile
                ? {
                    displayName: profile.displayName,
                    avatarUrl: profile.avatarUrl ?? s.avatarUrl,
                    followers: profile.followers ?? s.followers
                  }
                : {})
            }
          : s
      )
    )
  }

  /**
   * Bring every stale profile up to date, oldest first.
   *
   * Bounded and quiet: this runs when the library is opened, so it must not
   * stampede three platforms at once or complain when one of them is down.
   */
  async refreshStaleProfiles(): Promise<SavedStreamer[]> {
    const current = await this.list()
    const stale = current.filter((s) => profileIsStale(s.profileFetchedAt))
    if (stale.length === 0) return current
    for (const streamer of stale) {
      await this.refreshProfile(streamer.id).catch(() => undefined)
    }
    return this.list()
  }

  /**
   * Who is broadcasting right now, across every saved channel.
   *
   * Not persisted and not cached: a live badge is worthless the moment it is
   * stale, and the answer is cheap enough to just ask for. Bounded by the same
   * limiter the profile fetches use so opening the page never fires twenty
   * requests at three platforms at once.
   */
  /**
   * Who was live the last time anyone asked, and when that was.
   *
   * Held for the life of the app, not persisted: it means the Streamers page
   * shows who is on air the instant it opens instead of blinking empty for a
   * few seconds every time it is navigated to, and a page that is opened and
   * closed repeatedly does not re-ask three platforms each time.
   */
  private lastLive: Record<string, LiveNow> = {}
  private lastLiveAt = 0
  private liveLoaded = false
  private lastYouTubeLiveAt = 0

  /** How long a live answer is served from memory before it is asked for again. */
  private static readonly LIVE_TTL_MS = 45_000

  /**
   * The last known live status, without asking anyone.
   *
   * Read from disk on first use, so the page has something to draw the moment
   * it opens on a cold start rather than an empty roster that fills in a few
   * seconds later. It is a snapshot of who was live when the app last looked,
   * and the caller refreshes it immediately — see `liveNow`.
   */
  async liveCached(): Promise<Record<string, LiveNow>> {
    if (!this.liveLoaded) {
      this.liveLoaded = true
      try {
        const parsed = JSON.parse(await readFile(this.liveFile, 'utf8')) as {
          at?: number
          live?: Record<string, LiveNow>
        }
        // Anything older than a few minutes is not "who is live", it is who
        // was live when the app was last open — which could be yesterday.
        if (parsed?.live && Date.now() - (parsed.at ?? 0) < LIVE_SNAPSHOT_MAX_AGE_MS) {
          this.lastLive = parsed.live
        }
      } catch {
        // No snapshot yet, or one we cannot read. Either is a normal cold
        // start: the refresh that follows fills it in.
      }
    }
    return this.lastLive
  }

  async liveNow(signal?: AbortSignal): Promise<Record<string, LiveNow>> {
    if (Date.now() - this.lastLiveAt < StreamerService.LIVE_TTL_MS) return this.lastLive
    const current = await this.list()
    const out: Record<string, LiveNow> = {}
    const now = Date.now()

    /*
     * YouTube is asked far less often than the other two.
     *
     * Twitch and Kick answer over plain HTTP — a request each, cheap enough to
     * repeat every minute. YouTube has no such route, so its check is a
     * yt-dlp process per channel, and at the page's polling rate that was a
     * process per YouTube channel per minute for as long as anyone had the
     * Streamers page open. Its answer is carried over from the last look in
     * between, which for "are they live" is accurate to within a few minutes.
     */
    const dueForYouTube = now - this.lastYouTubeLiveAt >= YOUTUBE_LIVE_TTL_MS
    if (dueForYouTube) this.lastYouTubeLiveAt = now

    await Promise.all(
      current.map((streamer) => {
        if (streamer.platform === 'youtube' && !dueForYouTube) {
          const carried = this.lastLive[streamer.id]
          if (carried) out[streamer.id] = carried
          return Promise.resolve()
        }
        return this.profileLimiter
          .run(() => fetchLive(streamer.platform, streamer.handle, this.resolver, signal))
          .then((live) => {
            if (live) out[streamer.id] = live
          })
          // One unreachable channel must not blank the badge on the other
          // nineteen.
          .catch(() => undefined)
      })
    )
    this.lastLive = out
    this.lastLiveAt = Date.now()
    this.liveLoaded = true
    // Written so the next cold start has something to show at once. Failing
    // to write it costs a blank roster for one second, so it is never worth
    // failing the call over.
    void atomicWriteJson(this.liveFile, { at: this.lastLiveAt, live: out }).catch(() => undefined)
    return out
  }

  /**
   * A bare name, with no platform to go with it.
   *
   * People know each other by name, not by address — "add basedLore" is the
   * request, and asking which of three sites they are on is the app making its
   * own plumbing the user's problem. So the name is looked up on each platform
   * in turn and the first channel that actually exists is the one saved;
   * sibling discovery picks up the rest a moment later, which is exactly what
   * it does for a pasted address too.
   *
   * A name already in the library short-circuits the lookup: re-adding
   * somebody must not depend on three sites being reachable.
   */
  private async findHandle(
    input: string
  ): Promise<{ platform: PlatformId; handle: string } | null> {
    const handle = normalizeHandle(input)
    if (handle === '' || /[\s/]/.test(handle)) return null

    const order: PlatformId[] = ['twitch', 'kick', 'youtube']
    const known = (await this.list()).find((s) => order.some((p) => sameStreamer(s, { platform: p, handle })))
    if (known) return { platform: known.platform, handle: known.handle }

    for (const platform of order) {
      const profile = await this.profileLimiter
        .run(() => fetchProfile(platform, handle, this.resolver))
        .catch(() => null)
      if (profile) return { platform, handle }
    }
    return null
  }

  /**
   * The same person's channels on the other platforms, found by name.
   *
   * A restreamer almost always uses the same handle everywhere, so the cheap
   * profile lookup this page already does for pictures answers "do they exist
   * on Twitch too" for free. Anything found is saved and linked to the one
   * that was asked about, so the three entries behave as one person with three
   * places to watch from.
   *
   * Fails soft per platform and never invents a link: a handle that resolves
   * to somebody else's channel is indistinguishable from the right one here,
   * which is why this only ever matches an identical name and leaves the
   * unlink in the user's hands.
   */
  async discoverSiblings(id: string, force = false): Promise<SavedStreamer[]> {
    const current = await this.list()
    const streamer = current.find((s) => s.id === id)
    if (!streamer) return current
    if (!force && streamer.siblingsCheckedAt) return current

    const others: PlatformId[] = (['twitch', 'kick', 'youtube'] as PlatformId[]).filter(
      (p) => p !== streamer.platform
    )

    for (const platform of others) {
      // Already saved on that platform? Link it rather than adding a duplicate.
      const known = (await this.list()).find((s) => sameStreamer(s, { platform, handle: streamer.handle }))
      if (known) {
        if (known.personId !== streamer.personId || !streamer.personId) {
          await this.linkPerson(streamer.id, known.id)
        }
        continue
      }

      const profile = await this.profileLimiter
        .run(() => fetchProfile(platform, streamer.handle, this.resolver))
        .catch(() => null)
      if (!profile) continue

      const added = await this.add(streamer.handle, platform).catch(() => null)
      const fresh = (added ?? (await this.list())).find((s) =>
        sameStreamer(s, { platform, handle: streamer.handle })
      )
      if (fresh) await this.linkPerson(streamer.id, fresh.id)
    }

    // Recorded whether anything was found or not: "checked, and they are only
    // on Kick" is an answer worth keeping, or every launch re-asks.
    const checkedAt = new Date().toISOString()
    return this.write(
      (await this.list()).map((s) => (s.id === id ? { ...s, siblingsCheckedAt: checkedAt } : s))
    )
  }

  /**
   * Search the other platforms for a newly added streamer, in the background.
   *
   * Not awaited by the caller: adding a channel must be instant, and the
   * result of this is decoration that arrives a moment later. Failures are
   * swallowed for the same reason — a platform being unreachable is not a
   * reason for "add streamer" to fail.
   */
  private discoverInBackground(before: SavedStreamer[], after: SavedStreamer[]): void {
    // Off unless the app turns it on. A service that starts unawaited writes
    // of its own is a service no test can tear down cleanly — the write lands
    // after the temp directory is gone.
    if (!this.autoDiscoverSiblings) return
    const known = new Set(before.map((s) => s.id))
    for (const streamer of after) {
      if (known.has(streamer.id) || streamer.siblingsCheckedAt) continue
      void this.discoverSiblings(streamer.id).catch(() => undefined)
    }
  }

  /**
   * Collapse accounts that are the same channel saved twice.
   *
   * `add` has always refused a handle it already holds, but it did so by
   * reading the list, checking, and writing — and several callers run
   * unprompted and concurrently (sibling discovery, "remember this POV"), so
   * two of them could read the same list, each find nothing, and each add the
   * same channel. The staging bug that corrupted the library made that window
   * much wider. This is the cleanup for the rows it already produced;
   * `mutate` below is what stops new ones.
   *
   * Nothing is thrown away: the surviving row inherits the groups, the pin,
   * the watermark, the person link and the earliest date from every copy.
   * `preferIds` is how the caller says which id has a back catalogue already
   * crawled against it, so the expensive half of the data keeps its owner.
   */
  async dedupe(preferIds?: ReadonlySet<string>): Promise<{ removed: string[] }> {
    return this.mutate((current) => {
      const byChannel = new Map<string, SavedStreamer[]>()
      for (const streamer of current) {
        const key = channelKey(streamer.platform, streamer.handle)
        const group = byChannel.get(key)
        if (group) group.push(streamer)
        else byChannel.set(key, [streamer])
      }

      const removed: string[] = []
      const kept: SavedStreamer[] = []

      for (const copies of byChannel.values()) {
        if (copies.length === 1) {
          const only = copies[0]
          kept.push(
            only.handle === normalizeHandle(only.handle)
              ? only
              : { ...only, handle: normalizeHandle(only.handle) }
          )
          continue
        }

        const ranked = copies.slice().sort((a, b) => {
          // The one with a crawled back catalogue wins: everything else here
          // is cheap to re-fetch and that is not.
          const shelvedA = preferIds?.has(a.id) === true
          const shelvedB = preferIds?.has(b.id) === true
          if (shelvedA !== shelvedB) return shelvedA ? -1 : 1
          const richness = (x: SavedStreamer): number =>
            (x.avatarUrl ? 2 : 0) +
            (x.displayName.toLowerCase() !== x.handle.toLowerCase() ? 2 : 0) +
            (x.groupIds?.length ?? 0) +
            (x.watermark ? 1 : 0)
          if (richness(a) !== richness(b)) return richness(b) - richness(a)
          return (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt)
        })

        const [winner, ...losers] = ranked
        kept.push({
          ...winner,
          handle: normalizeHandle(winner.handle),
          groupIds: [...new Set(copies.flatMap((c) => c.groupIds ?? []))],
          personId: copies.find((c) => c.personId)?.personId ?? winner.personId,
          watermark: copies.find((c) => c.watermark)?.watermark ?? winner.watermark,
          favorite: copies.some((c) => c.favorite) ? true : winner.favorite,
          addedAt: copies.map((c) => c.addedAt).sort()[0] ?? winner.addedAt,
          lastUsedAt:
            copies
              .map((c) => c.lastUsedAt)
              .filter((at): at is string => typeof at === 'string')
              .sort()
              .pop() ?? winner.lastUsedAt
        })
        removed.push(...losers.map((l) => l.id))
      }

      /*
       * Second pass: the same person, twice, on the same platform, where only
       * one of them has any broadcasts.
       *
       * The pass above matches on the handle, and the handle is exactly what
       * disagrees when a channel gets saved twice — so it cannot catch the
       * ones that matter. This matches on the displayed name instead and
       * settles it by evidence: a row with a crawled back catalogue is a real
       * channel; a row on the same platform, under the same name, with
       * nothing behind it is the accident. The empty one goes.
       *
       * Never empties a name: if none of them have broadcasts, nothing is
       * chosen and both stay, because then there is no evidence either way.
       */
      const byName = new Map<string, SavedStreamer[]>()
      for (const streamer of kept) {
        const key = `${streamer.platform}:${streamer.displayName.trim().toLowerCase()}`
        const group = byName.get(key)
        if (group) group.push(streamer)
        else byName.set(key, [streamer])
      }

      const survivors: SavedStreamer[] = []
      for (const group of byName.values()) {
        if (group.length === 1) {
          survivors.push(group[0])
          continue
        }

        const withBroadcasts = group.filter((a) => preferIds?.has(a.id) === true)
        if (withBroadcasts.length === 0 || withBroadcasts.length === group.length) {
          survivors.push(...group)
          continue
        }

        const empties = group.filter((a) => preferIds?.has(a.id) !== true)
        const winner = withBroadcasts[0]

        // The empty row still knew things — its groups, its pin, its person
        // link. Those move across before it goes.
        survivors.push({
          ...winner,
          groupIds: [...new Set(group.flatMap((c) => c.groupIds ?? []))],
          personId: group.find((c) => c.personId)?.personId ?? winner.personId,
          watermark: group.find((c) => c.watermark)?.watermark ?? winner.watermark,
          favorite: group.some((c) => c.favorite) ? true : winner.favorite,
          addedAt: group.map((c) => c.addedAt).sort()[0] ?? winner.addedAt
        })
        survivors.push(...withBroadcasts.slice(1))
        removed.push(...empties.map((e) => e.id))
      }

      if (removed.length > 0) {
        this.log.warn('streamers', 'Collapsed duplicate channels', { removed: removed.length })
      }
      return { next: survivors, result: { removed } }
    })
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

    /*
     * The crawled shelf first, and this is not an optimisation.
     *
     * Every caller that wants a channel's broadcasts — the overlap search, the
     * discovery sweep, the dialog — went through here, and here went to the
     * platform: one listing per channel plus one request per undated VOD. With
     * forty-five saved streamers, asking "who else filmed this" listed
     * forty-five channels live and then asked YouTube for a thousand dates,
     * which YouTube answers with a bot check. The dates never arrived, and a
     * VOD without a date cannot be matched to a moment (`coverageOf` returns
     * null), so the search worked hardest exactly when it returned nothing.
     *
     * The shelf is the same data, already merged and already dated, filled in
     * slowly by VodCrawler — which is the one thing allowed to spend requests
     * on this. A channel with no shelf yet is still listed live, because the
     * first thing you do after adding a streamer must not be to wait for a
     * crawl.
     */
    const shelf = this.shelfFor?.(id) ?? null
    if (shelf && shelf.vods.length > 0) return shelf.vods

    return this.channelVods(streamer.platform, streamer.handle, signal)
  }

  /**
   * Recent VODs for any channel, newest first — saved or not.
   *
   * Separate from `vods` because a channel does not have to be in the library
   * to matter: a broadcast loaded from a pasted link needs its archive found
   * when it ends, and nobody should have to add the streamer first for that
   * to work.
   */
  async channelVods(
    platform: PlatformId,
    handle: string,
    signal?: AbortSignal
  ): Promise<StreamerVod[]> {
    const vods = await this.listChannelVods(platform, handle, { signal })
    const dated = await this.enrichWithDates(vods, signal)
    return dated
      .slice()
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
      .slice(0, 40)
  }

  /**
   * A channel's broadcasts as the platform lists them — titles and links, no
   * dates.
   *
   * The cheap half, deliberately separated from the expensive half. One
   * request lists a whole channel; learning *when* each of those happened
   * costs a request each on Twitch and YouTube (Kick's own API includes the
   * date, so its list comes back complete). The background crawl wants the
   * cheap half immediately and the expensive half spread over hours, and it
   * can only do that if it can ask for them apart.
   */
  async listChannelVods(
    platform: PlatformId,
    handle: string,
    opts: { signal?: AbortSignal; limit?: number; priority?: ProcessPriority } = {}
  ): Promise<StreamerVod[]> {
    const channel = { platform, handle, channelUrl: channelVideosUrl(platform, handle) }
    const vods =
      platform === 'kick'
        ? await this.kickVods(channel, opts.signal)
        : vodsFromFlatPlaylist(
            await this.resolver.flatPlaylist(channel.channelUrl, {
              ...(opts.signal ? { signal: opts.signal } : {}),
              // No limit by default: the whole point of the library is that
              // it holds a channel's history, not its recent past.
              limit: opts.limit ?? CHANNEL_LISTING_MAX,
              ...(opts.priority ? { priority: opts.priority } : {})
            })
          )

    this.log.info('streamers', 'Listed channel VODs', { platform, handle, count: vods.length })
    return vods
  }

  /**
   * When one broadcast happened, or null if the platform will not say.
   *
   * One process. The crawl calls this a few thousand times over a session,
   * which is exactly why it is one call the caller can pace rather than a
   * batch this service decides the speed of.
   */
  async vodDate(
    url: string,
    opts: { signal?: AbortSignal; priority?: ProcessPriority } = {}
  ): Promise<string | null> {
    const info = await this.resolveLimiter.run(() =>
      this.resolver.resolve(url, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.priority ? { priority: opts.priority } : {})
      })
    )
    return publishedAtFromRawInfo(info)
  }

  /**
   * Dates for a whole channel at once, where the platform will give them.
   *
   * Twitch will, through the same GQL endpoint the profile lookup uses — a
   * hundred broadcasts and their publish times in one request, instead of one
   * process each. Kick's listing already carries dates, so nothing here has
   * anything to add. YouTube has no equivalent, so it keeps to the slow path.
   *
   * Returns a map keyed by VOD url. An empty map means "no shortcut for this
   * one", never "this channel has no broadcasts" — the caller falls back to
   * asking one at a time.
   */
  async bulkVodDates(
    platform: PlatformId,
    handle: string,
    vods: StreamerVod[],
    signal?: AbortSignal
  ): Promise<Record<string, string>> {
    if (platform !== 'twitch' || vods.length === 0) return {}

    const byId = await twitchVideoDates(handle.replace(/^@/, ''), signal)
    if (Object.keys(byId).length === 0) return {}

    const out: Record<string, string> = {}
    for (const vod of vods) {
      // A Twitch VOD url ends with its numeric id: /videos/1234567890.
      const id = /\/videos\/(\d+)/.exec(vod.url)?.[1]
      const at = id ? byId[id] : undefined
      if (at) out[vod.url] = at
    }
    return out
  }

  private async kickVods(
    streamer: { handle: string },
    signal?: AbortSignal
  ): Promise<StreamerVod[]> {
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
          const info = await this.resolveLimiter.run(() => this.resolver.resolve(vod.url, { signal }))
          const publishedAt = publishedAtFromRawInfo(info)
          return publishedAt ? { ...vod, publishedAt } : vod
        } catch {
          return vod
        }
      })
    )
  }

  /**
   * One write at a time, and never an unexplained wipe.
   *
   * Two guards, both learned the hard way:
   *
   * `writing` serialises. Every mutation here is read-modify-write against a
   * cached list, and several of them run unprompted — sibling discovery, the
   * profile refresh, the crawl. Interleaved, two of them read the same list
   * and the second write silently drops the first one's change.
   *
   * The emptiness check is the backstop. Going from a populated library to
   * none of it is either the user removing their last streamer or something
   * having gone wrong; the first is rare and the second was catastrophic, so
   * it is refused unless the caller says it means it.
   */
  private writing: Promise<unknown> = Promise.resolve()

  /**
   * Read, change, write — with nobody else in between.
   *
   * `write` alone only serialised the writing. The dangerous part is the gap
   * before it: two callers read the same list, each decides the channel is
   * missing, and each adds it. Running the whole read-modify-write inside the
   * same chain closes that gap, so "does this already exist" is asked against
   * a list nobody else is about to change.
   */
  private async mutate<T>(
    change: (current: SavedStreamer[]) => { next: SavedStreamer[]; result: T } | Promise<{ next: SavedStreamer[]; result: T }>,
    opts: { allowEmpty?: boolean } = {}
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const current = await this.list()
      const { next, result } = await change(current)
      await this.writeNow(next, opts)
      return result
    }
    const queued = this.writing.then(run, run)
    this.writing = queued.catch(() => undefined)
    return queued
  }

  private async write(
    next: SavedStreamer[],
    opts: { allowEmpty?: boolean } = {}
  ): Promise<SavedStreamer[]> {
    const queued = this.writing.then(
      () => this.writeNow(next, opts),
      () => this.writeNow(next, opts)
    )
    this.writing = queued.catch(() => undefined)
    return queued
  }

  /** The write itself. Only ever called from inside the serialised chain. */
  private async writeNow(
    next: SavedStreamer[],
    opts: { allowEmpty?: boolean } = {}
  ): Promise<SavedStreamer[]> {
    const had = this.cache?.length ?? 0
    if (next.length === 0 && had > 0 && !opts.allowEmpty) {
      this.log.error('streamers', 'Refused to empty the streamer library', { had })
      return this.cache ?? []
    }

    this.cache = next
    await atomicWriteJson(this.file, next)
    return next
  }
}

/** How many events a streamer's profile remembers. A recency aid, not an archive. */
const MAX_PARTICIPATION = 20

/**
 * Record that this channel supplied a POV for an event (§13).
 *
 * Keyed by project, so re-loading a second POV from the same channel into the
 * same event updates that entry rather than listing the event twice — and so
 * renaming the event later corrects the record instead of leaving a stale
 * duplicate beside it.
 */
export function withParticipation(
  streamer: SavedStreamer,
  event: { projectId: string; projectName: string; eventName?: string }
): SavedStreamer {
  const entry: StreamerParticipation = { ...event, at: new Date().toISOString() }
  const rest = (streamer.participation ?? []).filter((p) => p.projectId !== event.projectId)
  return { ...streamer, participation: [entry, ...rest].slice(0, MAX_PARTICIPATION) }
}

function handleOnly(
  input: string,
  platform: PlatformId | undefined
): { platform: PlatformId; handle: string } | null {
  const text = normalizeHandle(input)
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
