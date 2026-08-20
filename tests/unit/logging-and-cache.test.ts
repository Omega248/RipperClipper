import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger, redact, redactUrl } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { estimateExportBytes, ensureWritableDirectory } from '../../src/main/services/disk.js'
import { serializeError, Errors, AppError } from '../../src/shared/errors.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vodclip-log-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('log redaction', () => {
  it('never writes credentials to disk', () => {
    const redacted = redact({
      Authorization: 'Bearer secret-token',
      cookie: 'auth_token=abcdef',
      client_secret: 'hunter2',
      nested: { access_token: 'xyz', harmless: 'value' }
    }) as Record<string, unknown>

    expect(JSON.stringify(redacted)).not.toContain('secret-token')
    expect(JSON.stringify(redacted)).not.toContain('hunter2')
    expect(JSON.stringify(redacted)).not.toContain('abcdef')
    expect(JSON.stringify(redacted)).toContain('harmless')
  })

  it('strips signed query parameters from media URLs', () => {
    const url =
      'https://cdn.invalid/vod/index.m3u8?sig=deadbeefdeadbeef&token=%7B%22x%22%3A1%7D&quality=chunked'
    const safe = redactUrl(url)
    expect(safe).toContain('cdn.invalid/vod/index.m3u8')
    expect(safe).toContain('quality=chunked')
    expect(safe).not.toContain('deadbeefdeadbeef')
  })

  it('redacts URLs embedded in free text', async () => {
    const logger = new Logger(dir, 'redaction.log')
    logger.error('test', 'failed for https://cdn.invalid/x.ts?sig=supersecretvalue')
    await logger.close()
    // The tail is written synchronously enough for a small line; read via tail().
    const reader = new Logger(dir, 'redaction.log')
    expect(reader.tail(10)).not.toContain('supersecretvalue')
    await reader.close()
  })

  it('honours the log level', async () => {
    const logger = new Logger(dir, 'level.log')
    logger.setLevel('warn')
    logger.debug('scope', 'should not appear')
    logger.warn('scope', 'should appear')
    await logger.close()
    const reader = new Logger(dir, 'level.log')
    const text = reader.tail(50)
    expect(text).not.toContain('should not appear')
    expect(text).toContain('should appear')
    await reader.close()
  })
})

describe('error catalogue', () => {
  it('always produces a title and an actionable message', () => {
    const cases = [
      Errors.unsupportedUrl('https://vimeo.com/1'),
      Errors.vodUnavailable(),
      Errors.authRequired('Twitch'),
      Errors.qualityUnavailable('1440p'),
      Errors.downloadFailed(),
      Errors.ffmpegMissing(),
      Errors.resolverMissing(),
      Errors.insufficientSpace(10 ** 10, 10 ** 8, 'D:\\Videos')
    ]
    for (const err of cases) {
      const serialized = serializeError(err)
      expect(serialized.title.length).toBeGreaterThan(3)
      expect(serialized.message.length).toBeGreaterThan(20)
      expect(serialized.message).not.toMatch(/something went wrong/i)
    }
  })

  it('marks connection failures as retryable', () => {
    expect(serializeError(Errors.downloadFailed()).retryable).toBe(true)
    expect(serializeError(Errors.unsupportedUrl('x')).retryable).toBe(false)
  })

  it('wraps unknown throwables without losing the message', () => {
    const serialized = serializeError(new Error('kaboom'))
    expect(serialized.message).toBe('kaboom')
    expect(serialized.code).toBe('unexpected')
  })

  it('keeps AppError instances distinguishable by code', () => {
    const err = Errors.authRequired('Kick')
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe('auth-required')
  })
})

describe('CacheManager', () => {
  it('stores, reuses and reports entries', async () => {
    const log = new Logger(join(dir, 'logs'))
    const cache = new CacheManager(log, join(dir, 'cache'), 1024 * 1024)
    await cache.ensure()

    const key = cache.keyFor('https://cdn.invalid/seg1.ts')
    expect(await cache.has(key)).toBeNull()
    await cache.put(key, Buffer.alloc(2048, 7))
    expect(await cache.has(key)).toBe(2048)

    const stats = await cache.stats()
    expect(stats.entries).toBe(1)
    expect(stats.sizeBytes).toBe(2048)

    await cache.clear()
    expect((await cache.stats()).entries).toBe(0)
    await log.close()
  })

  it('prunes least-recently-used entries to stay within budget', async () => {
    const log = new Logger(join(dir, 'logs2'))
    const cache = new CacheManager(log, join(dir, 'cache2'), 4096)
    await cache.ensure()

    for (let i = 0; i < 6; i++) {
      await cache.put(cache.keyFor(`seg${i}`), Buffer.alloc(1024, i))
      // Ensure distinct mtimes so LRU ordering is deterministic.
      await new Promise((r) => setTimeout(r, 12))
    }
    await cache.prune()

    const stats = await cache.stats()
    expect(stats.sizeBytes).toBeLessThanOrEqual(4096)
    expect(stats.entries).toBeLessThan(6)
    // The newest entry survives.
    expect(await cache.has(cache.keyFor('seg5'))).toBe(1024)
    await log.close()
  })
})

describe('disk safety', () => {
  it('estimates a plausible export size', () => {
    const bytes = estimateExportBytes(160, 8_000_000, 160_000)
    expect(bytes).toBeGreaterThan(150 * 1024 * 1024)
    expect(bytes).toBeLessThan(600 * 1024 * 1024)
  })

  it('creates and verifies the output directory', async () => {
    const target = join(dir, 'nested', 'out')
    await expect(ensureWritableDirectory(target)).resolves.toBeUndefined()
  })

  it('reports a non-writable target clearly', async () => {
    const file = join(dir, 'a-file')
    await writeFile(file, 'x')
    await expect(ensureWritableDirectory(file)).rejects.toThrowError(/cannot write to/)
  })
})
