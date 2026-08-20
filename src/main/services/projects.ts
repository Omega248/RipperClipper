import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../shared/defaults.js'
import { createId, normalizeOrder } from '../../shared/clips.js'
import { refreshClipMappings } from '../../shared/povMapping.js'
import type { ClipSegment, ExportSettings, Marker, ProjectFile, VodSource } from '../../shared/types.js'
import type { SyncAnchor } from '../../shared/sync.js'
import type { Logger } from './logger.js'
import type { RecoveryInfo } from '../../shared/ipc.js'

export const PROJECT_EXTENSION = 'cookieclip'

/**
 * Project persistence.
 *
 * Every write is atomic (temp file + rename), so a crash or power loss can
 * never leave a half-written project behind. Autosaves go to a separate
 * recovery file that is offered on the next launch.
 */
export class ProjectStore {
  private readonly recoveryFile: string
  private readonly recentFile: string

  constructor(
    private readonly log: Logger,
    private readonly stateDir: string
  ) {
    this.recoveryFile = join(stateDir, 'autosave.recovery.json')
    this.recentFile = join(stateDir, 'recent.json')
  }

  createProject(name: string): ProjectFile {
    const now = new Date().toISOString()
    return {
      schemaVersion: 4,
      id: createId('proj'),
      name: name.trim() === '' ? 'Untitled project' : name.trim(),
      createdAt: now,
      updatedAt: now,
      sources: [],
      clips: [],
      markers: [],
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
      outputDirectory: null
    }
  }

  async save(project: ProjectFile, path: string): Promise<ProjectFile> {
    const next: ProjectFile = {
      ...project,
      clips: normalizeOrder(project.clips),
      updatedAt: new Date().toISOString()
    }
    await atomicWriteJson(path, next)
    await this.rememberRecent(path)
    this.log.info('project', 'Project saved', { path, clips: next.clips.length })
    return next
  }

  async open(path: string): Promise<ProjectFile> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      throw Errors.projectCorrupt(path, err instanceof Error ? err.message : String(err))
    }
    const project = parseProject(raw, path)
    await this.rememberRecent(path)
    this.log.info('project', 'Project opened', { path, clips: project.clips.length })
    return project
  }

  /** Autosave to the recovery slot. Never touches the user's own file. */
  async autosave(project: ProjectFile): Promise<void> {
    await atomicWriteJson(this.recoveryFile, {
      savedAt: new Date().toISOString(),
      project
    })
  }

  async recoveryInfo(): Promise<RecoveryInfo> {
    try {
      const raw = await readFile(this.recoveryFile, 'utf8')
      const parsed = JSON.parse(raw) as { savedAt?: string; project?: ProjectFile }
      if (!parsed.project) return emptyRecovery()
      return {
        available: true,
        path: this.recoveryFile,
        savedAt: parsed.savedAt ?? null,
        projectName: parsed.project.name ?? null
      }
    } catch {
      return emptyRecovery()
    }
  }

  async loadRecovery(): Promise<ProjectFile> {
    const raw = await readFile(this.recoveryFile, 'utf8')
    const parsed = JSON.parse(raw) as { project?: unknown }
    if (!parsed.project) throw Errors.projectCorrupt(this.recoveryFile)
    return normalizeProject(parsed.project, this.recoveryFile)
  }

  async discardRecovery(): Promise<void> {
    await rm(this.recoveryFile, { force: true }).catch(() => undefined)
  }

  async recent(): Promise<string[]> {
    try {
      const raw = await readFile(this.recentFile, 'utf8')
      const list = JSON.parse(raw) as unknown
      if (!Array.isArray(list)) return []
      const existing: string[] = []
      for (const entry of list.slice(0, 12)) {
        if (typeof entry !== 'string') continue
        try {
          await stat(entry)
          existing.push(entry)
        } catch {
          // dropped: file no longer exists
        }
      }
      return existing
    } catch {
      return []
    }
  }

  private async rememberRecent(path: string): Promise<void> {
    const list = await this.recent()
    const next = [path, ...list.filter((p) => p !== path)].slice(0, 12)
    await atomicWriteJson(this.recentFile, next).catch(() => undefined)
  }

  /** Clean up stray temp files left by an interrupted write. */
  async cleanupTemp(): Promise<void> {
    try {
      const names = await readdir(this.stateDir)
      await Promise.all(
        names
          .filter((n) => n.endsWith('.tmp'))
          .map((n) => rm(join(this.stateDir, n), { force: true }).catch(() => undefined))
      )
    } catch {
      // nothing to clean
    }
  }

  defaultFileName(project: ProjectFile): string {
    return `${project.name}.${PROJECT_EXTENSION}`
  }
}

function emptyRecovery(): RecoveryInfo {
  return { available: false, path: null, savedAt: null, projectName: null }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

export function parseProject(raw: string, path: string): ProjectFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw Errors.projectCorrupt(path, err instanceof Error ? err.message : String(err))
  }
  return normalizeProject(parsed, path)
}

/**
 * Validate and upgrade a project document. Unknown/older schema versions are
 * migrated rather than rejected, so projects survive app updates.
 */
export function normalizeProject(input: unknown, path: string): ProjectFile {
  if (typeof input !== 'object' || input === null) throw Errors.projectCorrupt(path)
  const p = input as Record<string, unknown>

  if (!Array.isArray(p.clips) || !Array.isArray(p.sources)) {
    throw Errors.projectCorrupt(path, 'missing clips or sources array')
  }

  const sources: VodSource[] = (p.sources as unknown[]).filter(isSource).map((s) => ({
    ...s,
    formatsInspected: Boolean(s.formatsInspected)
  }))

  // v2 projects stored clips only in VOD time. They keep working: the event
  // range stays null until the POV's timing is known, and the authoring POV's
  // own numbers are never derived, so nothing shifts under the editor.
  const clips: ClipSegment[] = normalizeOrder(
    (p.clips as unknown[]).filter(isClip).map((c) => ({
      ...c,
      eventStartTime: typeof c.eventStartTime === 'number' ? c.eventStartTime : null,
      eventEndTime: typeof c.eventEndTime === 'number' ? c.eventEndTime : null,
      durationSeconds:
        typeof c.durationSeconds === 'number' && Number.isFinite(c.durationSeconds)
          ? c.durationSeconds
          : c.endSeconds - c.startSeconds,
      // Never restore a transient status from disk.
      status:
        c.status === 'complete' || c.status === 'failed' ? c.status : ('idle' as ClipSegment['status'])
    }))
  )

  const markers: Marker[] = Array.isArray(p.markers) ? (p.markers as unknown[]).filter(isMarker) : []

  // Anchors are what tie every POV to the real-world clock; losing them would
  // silently un-sync a project on reopen.
  const syncAnchors: SyncAnchor[] = Array.isArray(p.syncAnchors)
    ? (p.syncAnchors as unknown[]).filter(isAnchor)
    : []

  // Mappings are rebuilt from the event timeline on load: a project saved
  // before a POV was re-synced must not reopen with the old projections.
  const mappedClips = refreshClipMappings(clips, sources, new Date().toISOString())

  return {
    schemaVersion: 4,
    id: typeof p.id === 'string' ? p.id : createId('proj'),
    name: typeof p.name === 'string' && p.name !== '' ? p.name : basename(path).replace(/\.[^.]+$/, ''),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
    sources,
    clips: mappedClips,
    markers,
    syncAnchors,
    exportSettings: upgradeFilenameTemplate({
      ...DEFAULT_EXPORT_SETTINGS,
      ...(typeof p.exportSettings === 'object' && p.exportSettings !== null ? p.exportSettings : {})
    }),
    outputDirectory: typeof p.outputDirectory === 'string' ? p.outputDirectory : null
  }
}

/**
 * Projects saved before exports carried the streamer and date keep the bare
 * "{Name}", which collides the moment one clip is exported from two POVs.
 * A template the editor actually chose is left alone.
 */
function upgradeFilenameTemplate(settings: ExportSettings): ExportSettings {
  return settings.filenameTemplate === '{Name}'
    ? { ...settings, filenameTemplate: DEFAULT_EXPORT_SETTINGS.filenameTemplate }
    : settings
}

function isAnchor(value: unknown): value is SyncAnchor {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Record<string, unknown>
  return (
    typeof a.id === 'string' &&
    typeof a.vodId === 'string' &&
    typeof a.eventTime === 'number' &&
    Number.isFinite(a.eventTime) &&
    typeof a.localTime === 'number' &&
    Number.isFinite(a.localTime)
  )
}

function isSource(value: unknown): value is VodSource {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return typeof s.id === 'string' && typeof s.platform === 'string' && typeof s.url === 'string'
}

function isClip(value: unknown): value is ClipSegment {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.sourceId === 'string' &&
    typeof c.startSeconds === 'number' &&
    typeof c.endSeconds === 'number' &&
    Number.isFinite(c.startSeconds) &&
    Number.isFinite(c.endSeconds) &&
    c.endSeconds > c.startSeconds
  )
}

function isMarker(value: unknown): value is Marker {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return (
    typeof m.id === 'string' &&
    typeof m.sourceId === 'string' &&
    typeof m.timeSeconds === 'number' &&
    Number.isFinite(m.timeSeconds)
  )
}
