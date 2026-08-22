import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageReport, StorageArea } from '../../shared/ipc.js'
import type { Logger } from './logger.js'

/**
 * Where the disk went, and what is safe to reclaim (§17).
 *
 * The one rule that matters: **nothing currently required is ever deleted.**
 * Cleaning is offered per area, and the areas are chosen so that the
 * destructive answer is always obviously safe — temporary working files and
 * regenerable caches. A project file, an exported clip, or anything under the
 * user's own output directory is reported but never touched, because those
 * are the only things here that cannot be rebuilt.
 *
 * A cache is not "waste": deleting it costs a re-download next time. So sizes
 * are reported honestly with what each area actually buys, rather than
 * everything being lumped into one "clean up" button that quietly makes the
 * next session slow.
 */

/** Areas the editor is allowed to clear. Everything else is report-only. */
const CLEARABLE = new Set(['temp', 'media-cache', 'thumbnails', 'waveforms', 'scenes', 'previews', 'models'])

export interface StorageAreaSpec {
  id: string
  label: string
  /** What is lost by clearing it, in one line. */
  consequence: string
  path: string
  clearable: boolean
}

export class StorageService {
  constructor(
    private readonly log: Logger,
    private readonly areas: () => StorageAreaSpec[]
  ) {}

  /** Sizes for every known area. Missing directories report zero rather than failing. */
  async report(): Promise<StorageReport> {
    const specs = this.areas()
    const areas = await Promise.all(
      specs.map(async (spec): Promise<StorageArea> => ({
        id: spec.id,
        label: spec.label,
        consequence: spec.consequence,
        path: spec.path,
        clearable: spec.clearable && CLEARABLE.has(spec.id),
        sizeBytes: await directorySize(spec.path)
      }))
    )
    return { areas, totalBytes: areas.reduce((sum, a) => sum + a.sizeBytes, 0) }
  }

  /**
   * Empties one area's directory, keeping the directory itself.
   *
   * Refuses anything not explicitly clearable rather than trusting the
   * renderer's word for it — a bug or a stale UI must not be able to talk
   * this into deleting a projects folder.
   */
  async clear(areaId: string): Promise<StorageReport> {
    const spec = this.areas().find((a) => a.id === areaId)
    if (!spec || !spec.clearable || !CLEARABLE.has(areaId)) {
      this.log.warn('storage', 'Refused to clear a protected area', { areaId })
      return this.report()
    }

    let names: string[]
    try {
      names = await readdir(spec.path)
    } catch {
      return this.report() // nothing there to clear
    }

    let removed = 0
    for (const name of names) {
      try {
        await rm(join(spec.path, name), { recursive: true, force: true })
        removed++
      } catch (err) {
        // A file held open by a running export is exactly the case this must
        // survive: skip it and keep going rather than aborting half way.
        this.log.warn('storage', 'Could not remove a cached item', { name, error: err })
      }
    }

    this.log.info('storage', 'Cleared a storage area', { areaId, removed })
    return this.report()
  }
}

/**
 * Recursive size of a directory, in bytes.
 *
 * Errors are swallowed per entry rather than per call: a cache directory
 * being written to while it is measured is normal, and one vanished temp file
 * must not turn the whole report into a failure.
 */
export async function directorySize(path: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(path, entry)
    try {
      const info = await stat(full)
      total += info.isDirectory() ? await directorySize(full) : info.size
    } catch {
      // gone between listing and measuring — normal for a live cache
    }
  }
  return total
}
