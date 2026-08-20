import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheManager } from '../../src/main/services/cache.js'
import { ConcurrencyLimiter } from '../../src/main/services/limiter.js'
import { Logger } from '../../src/main/services/logger.js'

/**
 * The disk-backed cache the Editor's filmstrips and waveforms sit behind: a
 * clip's thumbnails should survive a restart, and a burst of items mounting
 * at once should never turn into a burst of ffmpeg processes.
 */

let dir: string
let log: Logger
let cache: CacheManager

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vodclip-media-cache-'))
  log = new Logger(join(dir, 'logs'))
  cache = new CacheManager(log, join(dir, 'cache'), 50 * 1024 * 1024)
  await cache.ensure()
})

afterEach(async () => {
  await log.close()
  await rm(dir, { recursive: true, force: true })
})

describe('CacheManager JSON entries', () => {
  it('reads back exactly what was written', async () => {
    const key = cache.keyFor('pov-a:10.00:20.00:8')
    await cache.putJson(key, { frames: ['data:image/jpeg;base64,AAAA'], startSeconds: 10, endSeconds: 20 })
    const result = await cache.getJson<{ frames: string[] }>(key)
    expect(result?.frames).toEqual(['data:image/jpeg;base64,AAAA'])
  })

  it('misses cleanly when nothing was ever written', async () => {
    expect(await cache.getJson(cache.keyFor('never-written'))).toBeNull()
  })

  it('misses rather than throwing on a corrupt entry', async () => {
    const key = cache.keyFor('corrupt')
    await cache.put(key, Buffer.from('not json'))
    expect(await cache.getJson(key)).toBeNull()
  })

  it('gives two different ranges two different keys', () => {
    const a = cache.keyFor('pov-a:10.00:20.00:8')
    const b = cache.keyFor('pov-a:10.00:21.00:8')
    expect(a).not.toBe(b)
  })
})

describe('ConcurrencyLimiter', () => {
  it('never runs more than the configured number at once', async () => {
    const limiter = new ConcurrencyLimiter(2)
    let active = 0
    let peak = 0
    const task = async (): Promise<void> => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active--
    }
    await Promise.all(Array.from({ length: 8 }, () => limiter.run(task)))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('still runs every queued task, and returns each one its own result', async () => {
    const limiter = new ConcurrencyLimiter(2)
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => limiter.run(() => Promise.resolve(i)))
    )
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('lets the next task start once one finishes, even if that one failed', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const order: string[] = []
    const failing = limiter.run(async () => {
      order.push('fail-start')
      throw new Error('boom')
    })
    const following = limiter.run(async () => {
      order.push('next-start')
    })
    await expect(failing).rejects.toThrow('boom')
    await following
    expect(order).toEqual(['fail-start', 'next-start'])
  })
})

