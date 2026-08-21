/**
 * Making a project portable (§20).
 *
 * A package is everything needed to reconstruct the *work* — the clips, where
 * every POV sits on the event clock, the audio edits, the watermarks, the
 * collections — and deliberately none of the media. The VODs are not ours to
 * move, they are enormous, and every POV already carries the URL it came
 * from, so a package that names them re-resolves on the receiving machine and
 * arrives at exactly the same state for a few kilobytes.
 *
 * Exported clip *files* are the one thing a package can optionally carry a
 * reference to, and even then only a path: §20 says include media only when
 * explicitly requested, and a JSON document is the wrong place for gigabytes
 * regardless.
 *
 * The format is plain JSON with a version, so a package made today still
 * opens after the project schema moves on — `readPackage` fills in anything
 * a newer field expects rather than rejecting the file.
 */

import type { ClipSegment, EventInfo, ExportSettings, ProjectFile, VodSource } from './types.js'
import type { SyncAnchor } from './sync.js'

export const PACKAGE_VERSION = 1
export const PACKAGE_EXTENSION = 'ripperpack'

export interface ProjectPackage {
  format: 'ripper-clipper-package'
  version: number
  createdAt: string
  /** The application version that wrote it, for diagnosing an odd import. */
  createdBy: string
  project: {
    name: string
    event?: EventInfo
    exportSettings: ExportSettings
    sources: VodSource[]
    clips: ClipSegment[]
    syncAnchors: SyncAnchor[]
  }
  /** Absolute paths of already-exported files, when the editor asked to note them. */
  exportedFiles?: string[]
  note?: string
}

export interface PackageOptions {
  /** Only these clips. Absent packages every clip in the project. */
  clipIds?: string[]
  /** Note the paths of clips already exported, so the recipient knows what exists. */
  includeExportPaths?: boolean
  note?: string
  appVersion: string
}

/**
 * Build a package from a project.
 *
 * When a subset of clips is chosen, the POVs are narrowed to exactly those
 * the chosen clips actually reference — sending eleven POVs for a package of
 * two clips would be noise, and the receiving editor would have to work out
 * which of them mattered. Sync anchors are narrowed the same way, since an
 * anchor for a POV that is not in the package cannot be applied to anything.
 */
export function buildPackage(project: ProjectFile, opts: PackageOptions): ProjectPackage {
  const clips =
    opts.clipIds === undefined
      ? project.clips
      : project.clips.filter((c) => opts.clipIds!.includes(c.id))

  // Every POV any chosen clip could be cut from: the authoring one, the
  // picture, the sound, and anything with a mapping for it.
  const needed = new Set<string>()
  for (const clip of clips) {
    needed.add(clip.sourceId)
    if (clip.videoSourceId) needed.add(clip.videoSourceId)
    if (clip.audioSourceId) needed.add(clip.audioSourceId)
    for (const mapping of clip.povMappings ?? []) needed.add(mapping.sourceId)
  }
  const sources =
    opts.clipIds === undefined ? project.sources : project.sources.filter((s) => needed.has(s.id))
  const sourceIds = new Set(sources.map((s) => s.id))

  const exportedFiles = opts.includeExportPaths
    ? clips.map((c) => c.exportedPath).filter((p): p is string => typeof p === 'string')
    : undefined

  return {
    format: 'ripper-clipper-package',
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    createdBy: opts.appVersion,
    project: {
      name: project.name,
      event: project.event,
      exportSettings: project.exportSettings,
      sources,
      clips,
      syncAnchors: (project.syncAnchors ?? []).filter((a) => sourceIds.has(a.vodId) || sourceIds.size === 0)
    },
    ...(exportedFiles && exportedFiles.length > 0 ? { exportedFiles } : {}),
    ...(opts.note && opts.note.trim() !== '' ? { note: opts.note.trim() } : {})
  }
}

export class PackageFormatError extends Error {}

/**
 * Parse a package, or say clearly why it is not one.
 *
 * Deliberately strict about the envelope and forgiving about the contents: a
 * file that is not a package at all must be rejected loudly, while a package
 * from an older build missing a field added since should still open. Being
 * lenient about the envelope is how you end up importing an unrelated JSON
 * file as an empty project.
 */
export function readPackage(input: unknown): ProjectPackage {
  if (typeof input !== 'object' || input === null) {
    throw new PackageFormatError('That file is not a Ripper Clipper package.')
  }
  const p = input as Record<string, unknown>
  if (p.format !== 'ripper-clipper-package') {
    throw new PackageFormatError('That file is not a Ripper Clipper package.')
  }
  if (typeof p.version !== 'number' || p.version > PACKAGE_VERSION) {
    throw new PackageFormatError(
      `That package was made by a newer version of Ripper Clipper (format ${String(p.version)}). Update and try again.`
    )
  }
  const project = p.project as Record<string, unknown> | undefined
  if (!project || !Array.isArray(project.clips) || !Array.isArray(project.sources)) {
    throw new PackageFormatError('That package is missing its clips or POVs.')
  }

  return {
    format: 'ripper-clipper-package',
    version: p.version,
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    createdBy: typeof p.createdBy === 'string' ? p.createdBy : 'unknown',
    project: {
      name: typeof project.name === 'string' && project.name !== '' ? project.name : 'Imported package',
      event: project.event as EventInfo | undefined,
      exportSettings: project.exportSettings as ExportSettings,
      sources: project.sources as VodSource[],
      clips: project.clips as ClipSegment[],
      syncAnchors: Array.isArray(project.syncAnchors) ? (project.syncAnchors as SyncAnchor[]) : []
    },
    ...(Array.isArray(p.exportedFiles)
      ? { exportedFiles: (p.exportedFiles as unknown[]).filter((f): f is string => typeof f === 'string') }
      : {}),
    ...(typeof p.note === 'string' ? { note: p.note } : {})
  }
}

/** A short human description of what is inside, for the import confirmation. */
export function describePackage(pkg: ProjectPackage): string {
  const clips = pkg.project.clips.length
  const povs = pkg.project.sources.length
  const made = new Date(pkg.createdAt).toLocaleDateString()
  return `${pkg.project.name} — ${clips} clip${clips === 1 ? '' : 's'}, ${povs} POV${povs === 1 ? '' : 's'}, packaged ${made}`
}
