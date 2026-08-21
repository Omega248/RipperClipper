import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../shared/defaults.js'
import { createId, normalizeOrder } from '../../shared/clips.js'
import { refreshClipMappings } from '../../shared/povMapping.js'
import { CLIP_WORKFLOW_ORDER } from '../../shared/types.js'
import type {
  ClipCollection,
  ClipSegment,
  ClipWorkflowState,
  EventInfo,
  EventMoment,
  ExportSettings,
  Marker,
  ProjectFile,
  VodSource
} from '../../shared/types.js'
import type { SyncAnchor } from '../../shared/sync.js'
import type { Logger } from './logger.js'
import type { ProjectBackupInfo, RecoveryInfo } from '../../shared/ipc.js'

export const PROJECT_EXTENSION = 'cookieclip'

/** How many prior versions of a project are kept once it's saved repeatedly. */
const MAX_BACKUPS = 10

/**
 * Project persistence.
 *
 * Every write is atomic (temp file + rename), so a crash or power loss can
 * never leave a half-written project behind. Autosaves go to a separate
 * recovery file that is offered on the next launch. Every explicit save also
 * snapshots whatever was on disk beforehand into a rolling backup history, so
 * an editing mistake that gets saved over is still recoverable — the atomic
 * write and the recovery file both only ever protect the *latest* state.
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
      schemaVersion: 5,
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
    await this.backupExisting(path)
    await atomicWriteJson(path, next)
    await this.rememberRecent(path)
    this.log.info('project', 'Project saved', { path, clips: next.clips.length })
    return next
  }

  /** Rolling save-history for a project, newest first. Empty until it's been saved twice. */
  async listBackups(path: string): Promise<ProjectBackupInfo[]> {
    const dir = this.backupDir(path)
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(`.${PROJECT_EXTENSION}`))
    } catch {
      return []
    }
    const infos = await Promise.all(
      names.map(async (name) => {
        const full = join(dir, name)
        const info = await stat(full)
        return { path: full, savedAt: info.mtime.toISOString() }
      })
    )
    return infos.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }

  /** Load a backup snapshot without disturbing the recent-projects list or the file it came from. */
  async restoreBackup(backupPath: string): Promise<ProjectFile> {
    const raw = await readFile(backupPath, 'utf8')
    return parseProject(raw, backupPath)
  }

  /** Snapshot whatever is currently on disk before it gets overwritten. */
  private async backupExisting(path: string): Promise<void> {
    let existing: Buffer
    try {
      existing = await readFile(path)
    } catch {
      return // nothing on disk yet — first save of this file
    }
    const dir = this.backupDir(path)
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // The suffix guards against two saves landing in the same millisecond,
    // which would otherwise silently overwrite one backup with another.
    await writeFile(join(dir, `${stamp}-${createId('bak')}.${PROJECT_EXTENSION}`), existing)
    await this.pruneBackups(dir)
  }

  private backupDir(path: string): string {
    return join(dirname(path), `.${basename(path)}.backups`)
  }

  private async pruneBackups(dir: string): Promise<void> {
    const names = (await readdir(dir)).filter((n) => n.endsWith(`.${PROJECT_EXTENSION}`)).sort()
    const excess = names.length - MAX_BACKUPS
    if (excess <= 0) return
    await Promise.all(
      names.slice(0, excess).map((name) => rm(join(dir, name), { force: true }).catch(() => undefined))
    )
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
        c.status === 'complete' || c.status === 'failed' ? c.status : ('idle' as ClipSegment['status']),
      // v5 additions. A v4 clip has none of these and reads as exactly what
      // it was: loose in the event, freshly found, no POV decided on yet.
      collectionId: typeof c.collectionId === 'string' ? c.collectionId : null,
      workflow: isWorkflowState(c.workflow) ? c.workflow : 'found',
      usedPovIds: Array.isArray(c.usedPovIds)
        ? c.usedPovIds.filter((id): id is string => typeof id === 'string')
        : []
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
    schemaVersion: 5,
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
    outputDirectory: typeof p.outputDirectory === 'string' ? p.outputDirectory : null,
    ...(normalizeEvent(p.event) ? { event: normalizeEvent(p.event)! } : {})
  }
}

/**
 * The v5 event block, or undefined for a project that predates it.
 *
 * Every field is optional and independently defaulted: a project half-way
 * through gaining an event (named but with no window declared yet, say) must
 * load as exactly that rather than being rejected or silently blanked.
 */
function isWorkflowState(value: unknown): value is ClipWorkflowState {
  return typeof value === 'string' && (CLIP_WORKFLOW_ORDER as string[]).includes(value)
}

function normalizeEvent(input: unknown): EventInfo | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const e = input as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  return {
    name: typeof e.name === 'string' && e.name.trim() !== '' ? e.name : null,
    startSeconds: num(e.startSeconds),
    endSeconds: num(e.endSeconds),
    collections: Array.isArray(e.collections)
      ? (e.collections as unknown[])
          .filter(
            (c): c is ClipCollection =>
              typeof c === 'object' &&
              c !== null &&
              typeof (c as ClipCollection).id === 'string' &&
              typeof (c as ClipCollection).name === 'string'
          )
          .map((c, i) => ({ ...c, order: typeof c.order === 'number' ? c.order : i }))
      : [],
    moments: Array.isArray(e.moments)
      ? (e.moments as unknown[]).filter(
          (m): m is EventMoment =>
            typeof m === 'object' &&
            m !== null &&
            typeof (m as EventMoment).id === 'string' &&
            typeof (m as EventMoment).name === 'string' &&
            typeof (m as EventMoment).timeSeconds === 'number'
        )
      : [],
    ...(typeof e.note === 'string' ? { note: e.note } : {})
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
