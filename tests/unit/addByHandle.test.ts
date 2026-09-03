import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformId } from '../../src/shared/types.js'

// The library is the only thing that knows whether a name exists anywhere, so
// the probe is what gets stubbed: no test should depend on three sites being
// up, and none should quietly reach them either.
const fetchProfile = vi.fn()
vi.mock('../../src/main/services/streamerProfile.js', async (orig) => {
  const actual = await orig<typeof import('../../src/main/services/streamerProfile.js')>()
  return { ...actual, fetchProfile: (...args: unknown[]) => fetchProfile(...args) }
})

const { StreamerService } = await import('../../src/main/services/streamers.js')
const { Logger } = await import('../../src/main/services/logger.js')
const { ResolverService } = await import('../../src/main/media/resolver.js')

describe('adding a streamer by name alone', () => {
  let dir: string
  let log: InstanceType<typeof Logger>
  let service: InstanceType<typeof StreamerService>

  beforeEach(async () => {
    fetchProfile.mockReset()
    dir = await mkdtemp(join(tmpdir(), 'cookieclip-addhandle-'))
    log = new Logger(join(dir, 'logs'))
    service = new StreamerService(log, new ResolverService(log), dir)
  })

  afterEach(async () => {
    log.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('saves the first platform the name actually exists on', async () => {
    fetchProfile.mockImplementation(async (platform: PlatformId) =>
      platform === 'kick' ? { displayName: 'basedLore' } : null
    )

    const saved = await service.add('basedLore')

    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ platform: 'kick', handle: 'basedLore' })
    // Twitch is asked first and answers no; the search stops at the hit.
    expect(fetchProfile.mock.calls.map((c) => c[0])).toEqual(['twitch', 'kick'])
  })

  it('strips a leading @', async () => {
    fetchProfile.mockImplementation(async (platform: PlatformId) =>
      platform === 'youtube' ? { displayName: 'someone' } : null
    )

    const saved = await service.add('@someone')

    expect(saved[0]).toMatchObject({ platform: 'youtube', handle: 'someone' })
  })

  it('re-adding a known name never touches the network', async () => {
    fetchProfile.mockResolvedValue(null)
    await service.add('twitch.tv/knownperson')
    fetchProfile.mockClear()

    const saved = await service.add('KnownPerson')

    expect(saved).toHaveLength(1)
    expect(fetchProfile).not.toHaveBeenCalled()
  })

  it('says the name was not found rather than talking about VOD links', async () => {
    fetchProfile.mockResolvedValue(null)

    await expect(service.add('nobodyhasthisname')).rejects.toMatchObject({
      code: 'unknown-channel'
    })
  })

  it('still calls a broken address a broken address', async () => {
    fetchProfile.mockResolvedValue(null)

    await expect(service.add('https://twitch.tv/videos/123')).rejects.toMatchObject({
      code: 'unsupported-url'
    })
  })
})
