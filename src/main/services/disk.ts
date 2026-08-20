import { access, constants, mkdir, statfs, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import type { DiskSpaceInfo } from '../../shared/types.js'

/** Free-space and writability checks performed before an export starts. */
export async function diskSpace(path: string): Promise<DiskSpaceInfo> {
  const stats = await statfs(path)
  return {
    path,
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize
  }
}

export async function ensureWritableDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
    await access(path, constants.W_OK)
  } catch (err) {
    throw Errors.outputNotWritable(path, err instanceof Error ? err.message : String(err))
  }

  // access() is advisory on Windows; prove it by actually writing.
  const probe = join(path, `.ripperclipper-write-test-${process.pid}`)
  try {
    await writeFile(probe, 'ok')
  } catch (err) {
    throw Errors.outputNotWritable(path, err instanceof Error ? err.message : String(err))
  } finally {
    await unlink(probe).catch(() => undefined)
  }
}

/**
 * Estimate the bytes an export will need: the clip payload plus the temporary
 * window files, with a safety margin.
 */
export function estimateExportBytes(
  durationSeconds: number,
  videoBitrate: number | undefined,
  audioBitrate: number | undefined
): number {
  const bits = (videoBitrate ?? 8_000_000) + (audioBitrate ?? 160_000)
  const payload = (bits / 8) * Math.max(1, durationSeconds)
  // Window files + output + headroom.
  return Math.ceil(payload * 2.5)
}

export async function assertEnoughSpace(
  path: string,
  requiredBytes: number
): Promise<void> {
  let info: DiskSpaceInfo
  try {
    info = await diskSpace(path)
  } catch {
    return // If the platform will not report free space, do not block the export.
  }
  if (info.freeBytes < requiredBytes) {
    throw Errors.insufficientSpace(requiredBytes, info.freeBytes, path)
  }
}
