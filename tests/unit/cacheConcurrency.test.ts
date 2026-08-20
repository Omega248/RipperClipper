import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheManager } from '../../src/main/services/cache.js'
import { Logger } from '../../src/main/services/logger.js'

/**
 * POVs of the same event share media, and the waveform reads while the player
 * plays, so the same segment is often written twice at once. A shared ".part"
 * name meant the first writer's rename won and the second failed with ENOENT —
 * a lost segment and a scary error line for a download that was fine.
 */

let dir: string
let log: Logger
let cache: CacheManager

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vodclip-cache-race-'))
  log = new Logger(join(dir, 'logs'))
  cache = new CacheManager(log, join(dir, 'cache'), 50 * 1024 * 1024)
  await cache.ensure()
})

afterEach(async () => {
  await log.close()
  await rm(dir, { recursive: true, force: true })
})

describe('concurrent cache writes', () => {
  it('survives many writers racing on the same key', async () => {
    const payload = Buffer.from('segment-bytes')
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => cache.put('same-key', payload))
    )
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)

    const path = (results[0] as PromiseFulfilledResult<string>).value
    expect(await readFile(path)).toEqual(payload)
  })

  it('leaves no scratch files behind', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => cache.put(`key-${i % 3}`, Buffer.from(`data-${i}`)))
    )
    const files = await readdir(join(dir, 'cache', 'segments'))
    expect(files.some((f) => f.includes('.part'))).toBe(false)
  })

  it('still reads back what was written under contention', async () => {
    await Promise.all([
      cache.put('a', Buffer.from('aaa')),
      cache.put('b', Buffer.from('bbb')),
      cache.put('a', Buffer.from('aaa'))
    ])
    expect(await cache.has('a')).not.toBeNull()
    expect(await cache.has('b')).not.toBeNull()
  })
})
