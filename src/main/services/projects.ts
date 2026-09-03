import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../shared/defaults.js'
import { masterPlaylistFor } from '../../shared/mediaProxyUrl.js'
import { createId, normalizeOrder } from '../../shared/clips.js'
import {
  RENAME_ATTEMPTS,
  isTransientRenameError,
  renameRetryDelayMs
} from '../../shared/atomicWrite.js'
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
      sources: stripLive(project.sources),
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
  /** Monotonic within this process, so backup names sort in creation order. */
  private backupSequence = 0

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
    /*
     * Timestamp, then a counter, then a random id.
     *
     * `pruneBackups` drops the oldest by sorting these names, so the name has
     * to sort in creation order. The timestamp alone does not: two saves in the
     * same millisecond share it, and the random suffix that follows then
     * decides which is "oldest" — at random. The counter makes the order real
     * within a millisecond, and the random id still keeps two *processes* from
     * colliding on the same name.
     *
     * Padded so it sorts as a string rather than a number: `10` must not come
     * before `9`.
     */
    const sequence = String(this.backupSequence++).padStart(6, '0')
    await writeFile(
      join(dir, `${stamp}-${sequence}-${createId('bak')}.${PROJECT_EXTENSION}`),
      existing
    )
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
      project: { ...project, sources: stripLive(project.sources) }
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

/**
 * `VodSource.live` is transient runtime state — buffer fill, measured latency,
 * retry count. Persisting it writes facts that are false the moment the file is
 * reopened, so it is dropped on every write path.
 */
function stripLive(sources: VodSource[]): VodSource[] {
  return sources.map(({ live: _live, ...rest }) => rest)
}

/**
 * Counter for temp file names. See below for why the pid alone was not enough.
 */
let atomicWriteSeq = 0

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  /*
   * Unique per CALL, not per process.
   *
   * This used to be `${path}.${process.pid}.tmp`, which is one temp file
   * shared by every concurrent write to the same path inside one app. Two
   * writers then wrote into the same file at once and the rename published
   * whatever the overlap produced: a shorter document followed by the tail of
   * a longer one. That reads back as "Unexpected non-whitespace character
   * after JSON at position N" — a file that is valid JSON and then suddenly
   * is not, which is exactly how a streamer library got corrupted.
   *
   * A counter makes each write its own file, so the rename is the only thing
   * that can publish and it publishes one complete document. The rename
   * itself was always atomic; the staging was not.
   */
  const tmp = `${path}.${process.pid}.${atomicWriteSeq++}.tmp`
  /*
   * Flushed to the device before it is published.
   *
   * `writeFile` returns once the bytes are in the page cache, not once they
   * are on the disk, and NTFS journals metadata rather than file contents. So
   * a rename could become durable while the data behind it had not — losing
   * power in that window leaves a project, or the streamer library, as a
   * present but zero-length file. Temp-and-rename on its own only protects
   * against the process dying, which is the easier half.
   *
   * One fsync per save, on a file this app writes at human speed.
   */
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await publish(tmp, path)
}

/**
 * Replace `path` with `tmp`, retrying the way Windows requires.
 *
 * On POSIX, renaming over an existing file is atomic and simply succeeds. On
 * Windows it can fail with EPERM, EACCES or EBUSY when anything holds a handle
 * to the target for an instant — the indexer, a virus scanner, or another of
 * this app's own concurrent writes to the same path, since replacing a file
 * there is not the single indivisible operation it is on POSIX.
 *
 * The failure is transient and the fix is to ask again shortly. Not retrying
 * means a save that silently did not happen, and every durable thing the app
 * owns goes through here: projects, settings, the streamer library, the VOD
 * library. Losing one of those to a momentary lock is not acceptable, and it
 * is invisible until someone notices their work is missing.
 *
 * Bounded, and it gives up loudly rather than leaving a caller believing a
 * write succeeded. The staging file is cleaned up either way, so a failure
 * does not leave `.tmp` litter beside the real one.
 */
async function publish(tmp: string, path: string): Promise<void> {
  let lastError: unknown = null

  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      lastError = err
      if (!isTransientRenameError((err as NodeJS.ErrnoException).code)) break
      await new Promise((resolve) => setTimeout(resolve, renameRetryDelayMs(attempt)))
    }
  }

  // Give up loudly. A caller that believes a write succeeded when it did not
  // is worse than one that has to handle a failure.
  await rm(tmp, { force: true }).catch(() => undefined)
  throw lastError
}

/**
 * Read back a JSON document that may have a corrupted tail.
 *
 * Recovery for files written by the bug above: the good document is intact at
 * the front and the damage is everything after its closing bracket, so the
 * longest valid prefix is the real content. Returns null when there is nothing
 * salvageable, which the caller must treat as "could not read" rather than
 * "empty" — the two are not the same answer.
 */
export function parseJsonSalvagingTail(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    const end = firstDocumentEnd(text)
    if (end === -1) return null
    try {
      return JSON.parse(text.slice(0, end + 1))
    } catch {
      return null
    }
  }
}

/**
 * Index of the closing bracket of the FIRST complete value in the text.
 *
 * The first, not the last: the damage is a short document published over a
 * longer one, so what follows the first complete value is the longer one's
 * tail — including its own closing bracket, which is why taking the last one
 * finds nothing parseable. Strings and escapes are tracked because a bracket
 * inside a title would otherwise end the scan early, and broadcast titles are
 * full of them.
 */
function firstDocumentEnd(text: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  let started = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '[' || ch === '{') {
      depth++
      started = true
      continue
    }
    if (ch === ']' || ch === '}') {
      depth--
      if (started && depth === 0) return i
    }
  }
  return -1
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

  const sources = (p.sources as unknown[]).filter(isSource).map((s) => ({
    ...s,
    formatsInspected: Boolean(s.formatsInspected),
    /*
     * Repair a playback URL saved as a single rendition.
     *
     * Every project written before the resolver was fixed stored the highest
     * *variant* here instead of the master, which pinned every angle to
     * 1080p60 however small it was drawn — hls.js had one level to cap to and
     * the tile decoder's rendition picker never ran. Nothing re-resolves on
     * open, so without this those projects keep the bug forever.
     */
    ...(s.playbackUrl && masterPlaylistFor(s.playbackUrl)
      ? { playbackUrl: masterPlaylistFor(s.playbackUrl)! }
      : {})
  }))

  const clips = normalizeOrder(
    (p.clips as unknown[]).filter(isClip).map((c) => ({
      ...c,
      eventStartTime: typeof c.eventStartTime === 'number' ? c.eventStartTime : null,
      eventEndTime: typeof c.eventEndTime === 'number' ? c.eventEndTime : null,
      durationSeconds:
        typeof c.durationSeconds === 'number' && Number.isFinite(c.durationSeconds)
          ? c.durationSeconds
          : c.endSeconds - c.startSeconds,
      // Never restore a transient status from disk.
      status: c.status === 'complete' || c.status === 'failed' ? c.status : 'idle',
      // v5 additions. A v4 clip has none of these and reads as exactly what
      // it was: loose in the event, freshly found, no POV decided on yet.
      collectionId: typeof c.collectionId === 'string' ? c.collectionId : null,
      workflow: isWorkflowState(c.workflow) ? c.workflow : 'found',
      usedPovIds: Array.isArray(c.usedPovIds)
        ? c.usedPovIds.filter((id): id is string => typeof id === 'string')
        : []
    }))
  )

  const markers = Array.isArray(p.markers) ? (p.markers as unknown[]).filter(isMarker) : []
  const syncAnchors = Array.isArray(p.syncAnchors)
    ? (p.syncAnchors as unknown[]).filter(isAnchor)
    : []
  const mappedClips = refreshClipMappings(clips, sources, new Date().toISOString())
  const event = normalizeEvent(p.event)

  return {
    schemaVersion: 5,
    id: typeof p.id === 'string' ? p.id : createId('proj'),
    name:
      typeof p.name === 'string' && p.name !== ''
        ? p.name
        : basename(path).replace(/\.[^.]+$/, ''),
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
    sources,
    clips: mappedClips,
    markers,
    syncAnchors,
    exportSettings: upgradeFilenameTemplate({
      ...DEFAULT_EXPORT_SETTINGS,
      ...(typeof p.exportSettings === 'object' && p.exportSettings !== null
        ? (p.exportSettings as Partial<ExportSettings>)
        : {})
    }),
    outputDirectory: typeof p.outputDirectory === 'string' ? p.outputDirectory : null,
    ...(event ? { event } : {})
  }
}

function isWorkflowState(value: unknown): value is ClipWorkflowState {
  return typeof value === 'string' && (CLIP_WORKFLOW_ORDER as readonly string[]).includes(value)
}

function normalizeEvent(input: unknown): EventInfo | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const e = input as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null

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
    (c.endSeconds as number) > (c.startSeconds as number)
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
