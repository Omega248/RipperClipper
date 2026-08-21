import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelHandleFrom } from '../../src/main/services/sources.js'
import {
  StreamerService,
  channelVideosUrl,
  kickVodsFromChannel,
  parseChannelUrl,
  publishedAtFromRawInfo,
  sameStreamer,
  vodsFromFlatPlaylist
} from '../../src/main/services/streamers.js'
import { Logger } from '../../src/main/services/logger.js'
import { ResolverService } from '../../src/main/media/resolver.js'
import type { SavedStreamer } from '../../src/shared/ipc.js'

describe('channel links', () => {
  it('recognises channel pages on every platform', () => {
    expect(parseChannelUrl('https://www.twitch.tv/somestreamer')).toEqual({
      platform: 'twitch',
      handle: 'somestreamer'
    })
    expect(parseChannelUrl('kick.com/somestreamer')).toEqual({
      platform: 'kick',
      handle: 'somestreamer'
    })
    expect(parseChannelUrl('https://www.youtube.com/@somestreamer/streams')).toEqual({
      platform: 'youtube',
      handle: 'somestreamer'
    })
  })

  it('refuses VOD links, so a clip source is never saved as a channel', () => {
    expect(parseChannelUrl('https://www.twitch.tv/videos/123456')).toBeNull()
    expect(parseChannelUrl('https://kick.com/video/01a00c92-5600-7726-bca4-403b6524da32')).toBeNull()
    expect(parseChannelUrl('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(parseChannelUrl('not a url')).toBeNull()
  })

  it('points at each platform archive listing', () => {
    expect(channelVideosUrl('twitch', 'name')).toBe('https://www.twitch.tv/name/videos?filter=archives')
    expect(channelVideosUrl('youtube', '@name')).toBe('https://www.youtube.com/@name/streams')
    expect(channelVideosUrl('kick', 'name')).toBe('https://kick.com/name')
  })

  it('treats the same channel as the same streamer regardless of case', () => {
    const saved: SavedStreamer = {
      id: 's1',
      platform: 'twitch',
      handle: 'SomeStreamer',
      displayName: 'SomeStreamer',
      channelUrl: 'https://www.twitch.tv/SomeStreamer/videos?filter=archives',
      addedAt: '2026-08-01T00:00:00.000Z',
      lastUsedAt: null
    }
    expect(sameStreamer(saved, { platform: 'twitch', handle: 'somestreamer' })).toBe(true)
    expect(sameStreamer(saved, { platform: 'kick', handle: 'somestreamer' })).toBe(false)
  })
})

describe('recent VOD listings', () => {
  it('maps Kick channel videos to loadable links', () => {
    const vods = kickVodsFromChannel(
      [
        {
          session_title: 'NoPixel | Day 3',
          duration: 21_600_000,
          views: 4210,
          start_time: '2026-08-16 21:55:12',
          thumbnail: { src: 'https://images.kick.com/a.jpg' },
          video: { uuid: '3aaa767a-a079-4f64-b8bf-b2f783f88288' }
        },
        { session_title: 'no video record', duration: 100 }
      ],
      'somestreamer'
    )
    expect(vods).toHaveLength(1)
    expect(vods[0].url).toBe(
      'https://kick.com/somestreamer/videos/3aaa767a-a079-4f64-b8bf-b2f783f88288'
    )
    expect(vods[0].durationSeconds).toBe(21_600)
    expect(vods[0].publishedAt).toBe('2026-08-16T21:55:12.000Z')
    expect(vods[0].viewCount).toBe(4210)
  })

  it('maps a yt-dlp flat playlist and skips anything still live', () => {
    const vods = vodsFromFlatPlaylist({
      entries: [
        {
          url: 'https://www.twitch.tv/videos/111',
          title: 'Ranked session',
          duration: 3600.4,
          timestamp: 1_786_917_312
        },
        { url: 'https://www.twitch.tv/somestreamer', title: 'LIVE now', live_status: 'is_live' },
        { title: 'no url at all' }
      ]
    })
    expect(vods).toHaveLength(1)
    expect(vods[0].durationSeconds).toBe(3600)
    expect(vods[0].publishedAt).toBe(new Date(1_786_917_312 * 1000).toISOString())
  })

  it('accepts YouTube upload dates, which have no clock time', () => {
    const vods = vodsFromFlatPlaylist({
      entries: [{ url: 'https://youtu.be/abc', title: 'Stream', upload_date: '20260816' }]
    })
    expect(vods[0].publishedAt).toBe('2026-08-16T00:00:00.000Z')
  })

  it('returns nothing rather than throwing on an unexpected payload', () => {
    expect(kickVodsFromChannel(null, 'x')).toEqual([])
    expect(vodsFromFlatPlaylist({ nope: true })).toEqual([])
  })
})

describe('loading a POV remembers its streamer', () => {
  it('takes the handle from the resolver metadata, not the display name', () => {
    expect(
      channelHandleFrom({ uploader: 'Some Streamer', uploader_id: 'somestreamer' }, 'https://www.twitch.tv/videos/1')
    ).toBe('somestreamer')
  })

  it('prefers the channel slug in a Kick link', () => {
    expect(
      channelHandleFrom(
        { uploader: 'Some Streamer', uploader_id: '12345' },
        'https://kick.com/somestreamer/videos/01a00c92-5600-7726-bca4-403b6524da32'
      )
    ).toBe('somestreamer')
  })

  it('strips a leading @ from a YouTube handle', () => {
    expect(channelHandleFrom({ uploader_id: '@somestreamer' }, 'https://youtu.be/abc')).toBe(
      'somestreamer'
    )
  })

  it('refuses a handle with spaces, which would make a dead channel link', () => {
    expect(channelHandleFrom({ uploader: 'Some Streamer' }, 'https://youtu.be/abc')).toBeUndefined()
  })
})

describe('streamer groups', () => {
  let dir: string
  let log: Logger
  let service: StreamerService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cookieclip-streamers-'))
    log = new Logger(join(dir, 'logs'))
    service = new StreamerService(log, new ResolverService(log), dir)
  })

  afterEach(async () => {
    log.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts with no groups', async () => {
    expect(await service.listGroups()).toEqual([])
  })

  it('creates a group and does not duplicate one with the same name', async () => {
    await service.createGroup('PD')
    const again = await service.createGroup('pd')
    expect(again.map((g) => g.name)).toEqual(['PD'])
  })

  it('ignores a blank name rather than creating an empty group', async () => {
    expect(await service.createGroup('   ')).toEqual([])
  })

  it('renames a group', async () => {
    const [group] = await service.createGroup('Ballas')
    const renamed = await service.updateGroup(group.id, { name: 'Ballas Family' })
    expect(renamed[0].name).toBe('Ballas Family')
  })

  it('creates a group with an icon and colour', async () => {
    const [group] = await service.createGroup('PD', 'shield', '#3b82f6')
    expect(group.icon).toBe('shield')
    expect(group.color).toBe('#3b82f6')
  })

  it('rejects a colour outside the fixed palette rather than storing an arbitrary one', async () => {
    const [group] = await service.createGroup('Custom', undefined, '#123456')
    expect(group.color).toBeUndefined()
  })

  it('rejects an icon outside the fixed set rather than storing arbitrary text', async () => {
    const [group] = await service.createGroup('Custom', '🚓', undefined)
    expect(group.icon).toBeUndefined()
  })

  it('updates icon and colour independently of name', async () => {
    const [group] = await service.createGroup('EMS')
    const updated = await service.updateGroup(group.id, { icon: 'medical', color: '#22c55e' })
    expect(updated[0]).toMatchObject({ name: 'EMS', icon: 'medical', color: '#22c55e' })
  })

  it('clears an icon or colour by setting it to an empty string / invalid value', async () => {
    const [group] = await service.createGroup('EMS', 'medical', '#22c55e')
    const cleared = await service.updateGroup(group.id, { icon: '', color: 'not-a-colour' })
    expect(cleared[0].icon).toBeUndefined()
    expect(cleared[0].color).toBeUndefined()
  })

  it('assigns a streamer to groups and reports them back', async () => {
    const [pd] = await service.createGroup('PD')
    const [, ems] = await service.createGroup('EMS')
    const streamers = await service.add('twitch.tv/somestreamer')
    const streamer = streamers[0]

    const updated = await service.setGroups(streamer.id, [pd.id, ems.id])
    expect(updated[0].groupIds).toEqual([pd.id, ems.id])
  })

  it('deleting a group clears it from every streamer it was assigned to', async () => {
    const [pd] = await service.createGroup('PD')
    const streamers = await service.add('twitch.tv/somestreamer')
    await service.setGroups(streamers[0].id, [pd.id])

    await service.deleteGroup(pd.id)

    expect(await service.listGroups()).toEqual([])
    const after = await service.list()
    expect(after[0].groupIds).toEqual([])
  })

  it('deleting a group a streamer does not belong to leaves their groups untouched', async () => {
    const [pd] = await service.createGroup('PD')
    const [, ems] = await service.createGroup('EMS')
    const streamers = await service.add('twitch.tv/somestreamer')
    await service.setGroups(streamers[0].id, [pd.id])

    await service.deleteGroup(ems.id)

    const after = await service.list()
    expect(after[0].groupIds).toEqual([pd.id])
  })
})

describe('publishedAtFromRawInfo', () => {
  it('prefers a numeric timestamp, converted from Unix seconds', () => {
    expect(publishedAtFromRawInfo({ timestamp: 1_767_225_600 })).toBe('2026-01-01T00:00:00.000Z')
  })

  it('falls back to an 8-digit upload_date when there is no timestamp', () => {
    expect(publishedAtFromRawInfo({ upload_date: '20260115' })).toBe('2026-01-15T00:00:00.000Z')
  })

  it('returns null when yt-dlp reported neither — the flat channel listing, usually', () => {
    expect(publishedAtFromRawInfo({})).toBeNull()
  })

  it('ignores an upload_date that is not exactly 8 digits rather than misparsing it', () => {
    expect(publishedAtFromRawInfo({ upload_date: '2026-01-15' })).toBeNull()
  })
})

describe('Twitch/YouTube VOD date enrichment', () => {
  let dir: string
  let log: Logger
  let resolver: ResolverService
  let service: StreamerService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cookieclip-streamers-'))
    log = new Logger(join(dir, 'logs'))
    resolver = new ResolverService(log)
    service = new StreamerService(log, resolver, dir)
  })

  afterEach(async () => {
    log.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('looks up each VOD missing a date individually, since the flat channel listing never has one', async () => {
    vi.spyOn(resolver, 'flatPlaylist').mockResolvedValue({
      entries: [
        { id: 'v1', title: 'VOD 1', url: 'https://www.twitch.tv/videos/1', duration: 100 },
        { id: 'v2', title: 'VOD 2', url: 'https://www.twitch.tv/videos/2', duration: 200 }
      ]
    })
    vi.spyOn(resolver, 'resolve').mockImplementation(async (url: string) => {
      if (url.endsWith('/1')) return { timestamp: 1_767_225_600 }
      throw new Error('rate limited')
    })

    const streamers = await service.add('twitch.tv/somechannel')
    const vods = await service.vods(streamers[0].id)

    const v1 = vods.find((v) => v.url.endsWith('/1'))
    const v2 = vods.find((v) => v.url.endsWith('/2'))
    expect(v1?.publishedAt).toBe('2026-01-01T00:00:00.000Z')
    // One VOD's lookup failing must not blank the rest of the list, or lose the VOD.
    expect(v2?.publishedAt).toBeNull()
  })

  it('never makes a per-video lookup for a VOD that already has a date', async () => {
    vi.spyOn(resolver, 'flatPlaylist').mockResolvedValue({
      entries: [
        {
          id: 'v1',
          title: 'VOD 1',
          url: 'https://www.twitch.tv/videos/1',
          duration: 100,
          timestamp: 1_767_225_600
        }
      ]
    })
    const resolveSpy = vi.spyOn(resolver, 'resolve')

    const streamers = await service.add('twitch.tv/somechannel')
    await service.vods(streamers[0].id)

    expect(resolveSpy).not.toHaveBeenCalled()
  })
})

describe('same-person links', () => {
  let dir: string
  let log: Logger
  let service: StreamerService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cookieclip-streamers-'))
    log = new Logger(join(dir, 'logs'))
    service = new StreamerService(log, new ResolverService(log), dir)
  })

  afterEach(async () => {
    log.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('links two streamers to the same personId', async () => {
    await service.add('twitch.tv/leonarwho')
    await service.add('kick.com/leonarwho')
    const [a, b] = await service.list()

    const linked = await service.linkPerson(a.id, b.id)

    expect(linked[0].personId).toBeDefined()
    expect(linked[0].personId).toBe(linked[1].personId)
  })

  it('linking a third streamer to either half joins the same group rather than starting a new one', async () => {
    await service.add('twitch.tv/leonarwho')
    await service.add('kick.com/leonarwho')
    await service.add('youtube.com/@leonarwho')
    const [a, b, c] = await service.list()
    await service.linkPerson(a.id, b.id)

    const linked = await service.linkPerson(b.id, c.id)

    const [la, lb, lc] = linked
    expect(la.personId).toBe(lb.personId)
    expect(lb.personId).toBe(lc.personId)
  })

  it('linking a streamer to itself is a no-op', async () => {
    await service.add('twitch.tv/leonarwho')
    const [a] = await service.list()

    const result = await service.linkPerson(a.id, a.id)

    expect(result[0].personId).toBeUndefined()
  })

  it('unlinking one of a pair clears both — a link of one streamer alone is meaningless', async () => {
    await service.add('twitch.tv/leonarwho')
    await service.add('kick.com/leonarwho')
    const [a, b] = await service.list()
    await service.linkPerson(a.id, b.id)

    const after = await service.unlinkPerson(a.id)

    expect(after[0].personId).toBeUndefined()
    expect(after[1].personId).toBeUndefined()
  })

  it('unlinking one of three leaves the remaining two linked to each other', async () => {
    await service.add('twitch.tv/leonarwho')
    await service.add('kick.com/leonarwho')
    await service.add('youtube.com/@leonarwho')
    const [a, b, c] = await service.list()
    await service.linkPerson(a.id, b.id)
    await service.linkPerson(b.id, c.id)

    const after = await service.unlinkPerson(a.id)

    const [ua, ub, uc] = after
    expect(ua.personId).toBeUndefined()
    expect(ub.personId).toBeDefined()
    expect(ub.personId).toBe(uc.personId)
  })
})

describe('VOD quality probing', () => {
  let dir: string
  let log: Logger
  let resolver: ResolverService
  let service: StreamerService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cookieclip-streamers-'))
    log = new Logger(join(dir, 'logs'))
    resolver = new ResolverService(log)
    service = new StreamerService(log, resolver, dir)
  })

  afterEach(async () => {
    log.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the tallest resolution offered for each VOD', async () => {
    vi.spyOn(resolver, 'resolve').mockImplementation(async (url: string) => {
      if (url === 'https://a') return { formats: [{ height: 480 }, { height: 1080 }, { height: 720 }] }
      throw new Error('unreachable')
    })

    const result = await service.probeQuality(['https://a', 'https://b'])

    expect(result['https://a']).toBe(1080)
    expect(result['https://b']).toBeNull()
  })
})

describe('favourites and undo', () => {
  let dir: string
  let log: Logger
  let service: StreamerService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cookieclip-streamers-'))
    log = new Logger(join(dir, 'logs'))
    service = new StreamerService(log, new ResolverService(log), dir)
  })

  afterEach(async () => {
    log.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('pins and unpins a streamer', async () => {
    await service.add('twitch.tv/leonarwho')
    const [streamer] = await service.list()

    const pinned = await service.setFavorite(streamer.id, true)
    expect(pinned[0].favorite).toBe(true)

    const unpinned = await service.setFavorite(streamer.id, false)
    expect(unpinned[0].favorite).toBeUndefined()
  })

  it('restores a removed streamer with its id and metadata intact', async () => {
    await service.add('twitch.tv/leonarwho')
    const [pd] = await service.createGroup('PD')
    const [streamer] = await service.list()
    await service.setGroups(streamer.id, [pd.id])
    const [withGroup] = await service.list()

    await service.remove(streamer.id)
    expect(await service.list()).toEqual([])

    const restored = await service.restore(withGroup)
    expect(restored).toEqual([withGroup])
  })

  it('restoring a streamer that is already present is a no-op', async () => {
    await service.add('twitch.tv/leonarwho')
    const [streamer] = await service.list()

    const result = await service.restore(streamer)

    expect(result).toEqual([streamer])
  })
})
