import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from './logger.js'

/**
 * Segment-level media cache.
 *
 * Caching at the HLS segment granularity is what makes overlapping selections
 * cheap: two clips that share media share the underlying segment files instead
 * of downloading the same bytes twice. The cache is bounded and pruned
 * least-recently-used, so it can never quietly eat the user's disk.
 */
export interface CacheEntryStat {
  path: string
  sizeBytes: number
  mtimeMs: number
}

export class CacheManager {
  private directory: string
  private maxSizeBytes: number
  private pruning: Promise<void> | null = null

  constructor(
    private readonly log: Logger,
    directory: string,
    maxSizeBytes: number
  ) {
    this.directory = directory
    this.maxSizeBytes = maxSizeBytes
  }

  configure(directory: string, maxSizeBytes: number): void {
    this.directory = directory
    this.maxSizeBytes = maxSizeBytes
  }

  get dir(): string {
    return this.directory
  }

  async ensure(): Promise<string> {
    await mkdir(this.segmentsDir, { recursive: true })
    return this.directory
  }

  private get segmentsDir(): string {
    return join(this.directory, 'segments')
  }

  keyFor(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 40)
  }

  pathFor(key: string): string {
    return join(this.segmentsDir, key)
  }

  async has(key: string): Promise<number | null> {
    try {
      const s = await stat(this.pathFor(key))
      return s.isFile() && s.size > 0 ? s.size : null
    } catch {
      return null
    }
  }

  /** Reads back a value stored with `putJson`, or null on a cache miss or a corrupt entry. */
  async getJson<T>(key: string): Promise<T | null> {
    const size = await this.has(key)
    if (!size) return null
    try {
      return JSON.parse(await readFile(this.pathFor(key), 'utf8')) as T
    } catch {
      return null
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, Buffer.from(JSON.stringify(value)))
  }

  /** Write atomically so a crash cannot leave a truncated entry behind. */
  async put(key: string, data: Buffer): Promise<string> {
    await this.ensure()
    const finalPath = this.pathFor(key)
    // Two fetches can want the same segment at once — POVs of the same event
    // share media, and the waveform reads while the player plays. A shared
    // ".part" name meant one writer renamed it and the other's rename hit
    // ENOENT, losing the segment and logging an error for a perfectly fine
    // download. Each writer gets its own scratch name instead.
    CacheManager.writes += 1
    const tmpPath = `${finalPath}.${process.pid}.${CacheManager.writes}.part`
    try {
      await writeFile(tmpPath, data)
      await this.renameOntoFinal(tmpPath, finalPath)
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
      throw err
    }
    void this.schedulePrune()
    return finalPath
  }

  /**
   * Move a finished write onto its shared destination, tolerating the same
   * segment landing from two writers at once.
   *
   * Every concurrent writer for one key is writing the same bytes — the same
   * cache key means the same URL range — so once *any* of them has renamed
   * its temp file onto `finalPath`, every other writer's own copy is
   * redundant, not wrong. Two things specifically go wrong under real
   * concurrency here, both observed under Windows CI, neither a sign the
   * write itself failed:
   *
   *   - `rename()` onto an existing destination can raise a transient
   *     EPERM/EBUSY/EACCES while another process briefly holds the file
   *     (Windows does not offer POSIX's unconditional atomic replace), even
   *     though the rename would succeed a moment later.
   *   - By the time this writer's rename lands, the destination may already
   *     hold another writer's identical bytes, which is success, not a
   *     collision to report.
   *
   * So a rename failure is only ever fatal here if the destination still
   * does not exist afterwards — meaning nobody else won the race either.
   */
  private async renameOntoFinal(tmpPath: string, finalPath: string): Promise<void> {
    const attempts = 5
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await rename(tmpPath, finalPath)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (transient && attempt < attempts) {
          await delay(attempt * 15)
          continue
        }
        // Either a non-transient error, or the retries ran out. Either way,
        // check whether another writer already landed the same bytes: if so
        // this writer's own copy at tmpPath was never consumed by a rename
        // and has to be cleaned up explicitly here, since returning
        // successfully skips `put()`'s own error-path cleanup.
        const landed = await stat(finalPath).catch(() => null)
        if (landed && landed.isFile() && landed.size > 0) {
          await rm(tmpPath, { force: true }).catch(() => undefined)
          return
        }
        throw err
      }
    }
  }

  private static writes = 0

  async stats(): Promise<{ directory: string; sizeBytes: number; maxSizeBytes: number; entries: number }> {
    const entries = await this.list()
    return {
      directory: this.directory,
      sizeBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0),
      maxSizeBytes: this.maxSizeBytes,
      entries: entries.length
    }
  }

  async clear(): Promise<void> {
    await rm(this.segmentsDir, { recursive: true, force: true })
    await this.ensure()
    this.log.info('cache', 'Cache cleared', { directory: this.directory })
  }

  async list(): Promise<CacheEntryStat[]> {
    try {
      const names = await readdir(this.segmentsDir)
      const out: CacheEntryStat[] = []
      for (const name of names) {
        const full = join(this.segmentsDir, name)
        try {
          const s = await stat(full)
          if (s.isFile()) out.push({ path: full, sizeBytes: s.size, mtimeMs: s.mtimeMs })
        } catch {
          // entry vanished between readdir and stat
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** Drop least-recently-used entries until the cache fits its budget. */
  async prune(): Promise<void> {
    const entries = await this.list()
    let total = entries.reduce((sum, e) => sum + e.sizeBytes, 0)
    if (total <= this.maxSizeBytes) return

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let removed = 0
    for (const entry of entries) {
      if (total <= this.maxSizeBytes * 0.9) break
      try {
        await rm(entry.path, { force: true })
        total -= entry.sizeBytes
        removed++
      } catch {
        // ignore
      }
    }
    if (removed > 0) {
      this.log.info('cache', 'Pruned cache', { removed, remainingBytes: total })
    }
  }

  private schedulePrune(): Promise<void> {
    if (this.pruning) return this.pruning
    this.pruning = (async () => {
      try {
        await this.prune()
      } finally {
        this.pruning = null
      }
    })()
    return this.pruning
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
