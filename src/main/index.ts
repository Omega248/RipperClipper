import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, shell, Tray } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { Logger } from './services/logger.js'
import { SettingsStore } from './services/settings.js'
import { CacheManager } from './services/cache.js'
import { ProjectStore, PROJECT_EXTENSION, atomicWriteJson } from './services/projects.js'
import { PACKAGE_EXTENSION, buildPackage, readPackage } from '../shared/packaging.js'
import type { PackageOptions } from '../shared/packaging.js'
import { FfmpegService } from './media/ffmpeg.js'
import { ResolverService } from './media/resolver.js'
import { RangeFetcher } from './media/rangeFetcher.js'
import { Exporter } from './media/exporter.js'
import { AudioPeaksService } from './media/audioPeaks.js'
import { SceneDetectionService } from './media/sceneDetection.js'
import { ThumbnailService } from './media/thumbnails.js'
import { ConcurrencyLimiter } from './services/limiter.js'
import { PreviewMediaService } from './media/previewMedia.js'
import { ExportQueue } from './services/queue.js'
import type { QueueClipInput } from './services/queue.js'
import { AdapterRegistry } from './platforms/registry.js'
import { SourceService } from './services/sources.js'
import { StreamerService } from './services/streamers.js'
import { DiscoveryService } from './services/discovery.js'
import { TranscriptService } from './services/transcripts.js'
import { StorageService } from './services/storage.js'
import { WatermarkLibrary } from './services/watermarks.js'
import { ToolInstaller } from './services/deps.js'
import { UpdateService } from './services/updater.js'
import { setManagedToolsDir } from './services/locate.js'
import { selectStreams } from './media/formats.js'
import type { SelectedStreams } from './media/formats.js'
import { diskSpace } from './services/disk.js'
import { AppError, Errors, serializeError } from '../shared/errors.js'
import { IPC } from '../shared/ipc.js'
import type { WatermarkConfig } from '../shared/watermark.js'
import type {
  EventDiscoveryRequest,
  EventOverlapRequest,
  InstallProgress,
  ToolId,
  CombineRequest,
  EnqueueRequest,
  EnvInfo,
  PeaksQuery,
  PeaksReply,
  SceneChangesQuery,
  SceneChangesReply,
  FilmstripQuery,
  FilmstripReply,
  PreviewMediaRequest,
  SavedStreamer,
  StreamerGroup,
  TimelineExportRequest
} from '../shared/ipc.js'
import type { AppSettings, PlatformId, ProjectFile, VodSource } from '../shared/types.js'
import { startLocalServer, setLocalFileResolver, setWatermarkDir } from './localServer.js'
import type { LocalServer } from './localServer.js'

const __dirname_ = dirname(fileURLToPath(import.meta.url))

/*
 * The app was renamed from CookieClipper to RiptideClips, but `userData`
 * defaults to a folder named after `app.name` — which Electron reads from
 * package.json — so renaming that field would have silently pointed every
 * existing install at an empty new folder: projects, saved streamers,
 * installed tools (ffmpeg, yt-dlp, whisper), cached watermarks, all of it,
 * apparently gone. Pinning the name keeps the on-disk folder exactly where
 * it already is; nothing about the rename touches user data.
 */
app.setName('cookie-clipper')

/*
 * Every non-stable channel is for trying unstable things — it must never be
 * able to touch the same projects, cache or settings the real production
 * app uses. Each gets its own sibling folder rather than a different name,
 * so this can never collide with the pin above; the stable channel's own
 * path is completely untouched, since this block only runs otherwise.
 */
if (__CHANNEL__ !== 'stable') {
  app.setPath('userData', join(app.getPath('userData'), '..', `cookie-clipper-${__CHANNEL__}`))
}

let mainWindow: BrowserWindow | null = null
/** Set once the renderer has confirmed it's fine to lose whatever isn't saved. */
let allowClose = false
let localServer: LocalServer | null = null
let tray: Tray | null = null

const userData = app.getPath('userData')
const logsDir = join(userData, 'logs')
const stateDir = join(userData, 'state')
/** Where the save/open dialogs start when a project has no path of its own yet. */
const defaultProjectsDir = join(app.getPath('documents'), 'Ripper Clipper')

/**
 * The default projects folder, created on first use rather than at startup —
 * an editor who never saves a project should never see an empty folder they
 * did not ask for.
 */
async function ensureDefaultProjectsDir(): Promise<string> {
  await mkdir(defaultProjectsDir, { recursive: true }).catch(() => undefined)
  return defaultProjectsDir
}

const log = new Logger(logsDir)
const settings = new SettingsStore(log, userData, {
  outputDirectory: join(app.getPath('videos'), 'Ripper Clipper'),
  cacheDirectory: join(app.getPath('userData'), 'cache')
})
const cache = new CacheManager(log, join(userData, 'cache'), 8 * 1024 * 1024 * 1024)
const projects = new ProjectStore(log, stateDir)
const ffmpeg = new FfmpegService(log)
const resolver = new ResolverService(log)
const registry = new AdapterRegistry()
const sources = new SourceService(log, registry, resolver)
const streamers = new StreamerService(log, resolver, stateDir)
const discovery = new DiscoveryService(log, streamers, resolver)
const transcripts = new TranscriptService(log, resolver)
/**
 * Storage areas, resolved lazily so they follow the settings the editor has
 * actually chosen (cache and temp are both configurable) rather than the
 * defaults captured at startup. Projects and exports are listed so the total
 * is honest, but never marked clearable — they are the only things here that
 * cannot be rebuilt.
 */
const storage = new StorageService(log, () => [
  {
    id: 'temp',
    label: 'Temporary working files',
    consequence: 'Nothing — these are the scratch files of finished or abandoned exports.',
    path: tempRoot,
    clearable: true
  },
  {
    id: 'media-cache',
    label: 'Downloaded media segments',
    consequence: 'Clips you re-export will download their segments again.',
    path: cache.dir,
    clearable: true
  },
  {
    id: 'previews',
    label: 'Playable previews',
    consequence: 'Ranges made playable for sources the player cannot decode are rebuilt on demand.',
    path: join(userData, 'cache', 'previews'),
    clearable: true
  },
  {
    id: 'thumbnails',
    label: 'Filmstrips and thumbnails',
    consequence: 'Timeline filmstrips and clip thumbnails are regenerated as you scroll.',
    path: thumbCache.dir,
    clearable: true
  },
  {
    id: 'waveforms',
    label: 'Waveforms',
    consequence: 'Audio waveforms are recomputed when a clip is next opened.',
    path: waveCache.dir,
    clearable: true
  },
  {
    id: 'scenes',
    label: 'Scene detection',
    consequence: 'Detected cuts are found again the next time you snap a mark.',
    path: sceneCache.dir,
    clearable: true
  },
  {
    id: 'projects',
    label: 'Projects and their backups',
    consequence: 'Cannot be cleared here — these are your own files.',
    path: defaultProjectsDir,
    clearable: false
  }
])
const updater = new UpdateService(log, __CHANNEL__)

let tempRoot = join(app.getPath('temp'), 'ripperclipper')
const fetcher = new RangeFetcher(log, ffmpeg, cache, tempRoot)
// Separated audio is cached beside the media cache: it is expensive to make
// and identical inputs must never be processed twice.
const exporter = new Exporter(log, ffmpeg, fetcher)
const queue = new ExportQueue(log, exporter, join(tempRoot, 'jobs'))
const peaks = new AudioPeaksService(log, ffmpeg, fetcher)
const scenes = new SceneDetectionService(log, ffmpeg, fetcher)
const thumbs = new ThumbnailService(log, ffmpeg, fetcher)
// Filmstrips and waveforms survive a restart, keyed by source + range, so
// the Editor never re-runs ffmpeg for a clip it has already drawn once.
const thumbCache = new CacheManager(log, join(userData, 'cache', 'thumbnails'), 300 * 1024 * 1024)
const waveCache = new CacheManager(log, join(userData, 'cache', 'waveforms'), 100 * 1024 * 1024)
const sceneCache = new CacheManager(log, join(userData, 'cache', 'scenes'), 20 * 1024 * 1024)
// A burst of timeline items mounting at once must not spawn a burst of
// ffmpeg processes — two at a time keeps the Editor responsive without
// fighting the rest of the machine for CPU.
const mediaWorkLimiter = new ConcurrencyLimiter(2)
const watermarkDir = join(userData, 'watermarks')
const watermarks = new WatermarkLibrary(log, watermarkDir)
const previewMedia = new PreviewMediaService(log, ffmpeg, fetcher, join(userData, 'cache', 'preview'))
/** Tools Ripper Clipper installs for itself live here and nowhere else. */
const toolsDir = join(userData, 'tools')
// Chromium's network stack, so a system or corporate proxy, a PAC file and
// the machine's own certificate store all apply to these downloads.
const tools = new ToolInstaller(
  log,
  toolsDir,
  (input, init) => net.fetch(input as string, init),
  resourcesDir()
)
let installing: AbortController | null = null

/**
 * A project path passed on the command line — this is what Windows sends when
 * the user double-clicks a .cookieclip file, and it is also how a second instance
 * hands its file to the running one.
 */
function startupProjectPath(argv: string[] = process.argv): string | null {
  const match = argv
    .slice(1)
    .find((arg) => !arg.startsWith('-') && arg.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`))
  return match ?? null
}

function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin') : join(__dirname_, '../../resources/bin')
}

function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname_, '../../resources/icon.png')
}

async function detectEnvironment(): Promise<EnvInfo> {
  const s = settings.current
  const bin = resourcesDir()
  const [ffmpegInfo, resolverInfo] = await Promise.all([
    ffmpeg.detect({
      ffmpegPath: s.advanced.ffmpegPath,
      ffprobePath: s.advanced.ffprobePath,
      bundledDir: bin
    }),
    resolver.detect(s.advanced.ytDlpPath, bin)
  ])
  return {
    ffmpeg: ffmpegInfo,
    resolver: resolverInfo,
    platform: process.platform,
    appVersion: app.getVersion(),
    defaultOutputDirectory: s.outputDirectory,
    mediaProxyBase: localServer?.loopbackUrl ?? ''
  }
}

/**
 * Settings changes are applied in place. The queue instance is never replaced,
 * so in-flight jobs keep running and their progress keeps reaching the UI.
 */
function applySettings(s: AppSettings): void {
  // Window chrome — title bar, native menus, scrollbars — follows the same
  // choice as the interface, so the frame never disagrees with its contents.
  nativeTheme.themeSource = s.ui.theme
  cache.configure(s.cache.directory, s.cache.maxSizeBytes)
  thumbCache.configure(join(s.cache.directory, 'thumbnails'), 300 * 1024 * 1024)
  waveCache.configure(join(s.cache.directory, 'waveforms'), 100 * 1024 * 1024)
  tempRoot = s.advanced.tempDirectory ?? join(app.getPath('temp'), 'ripperclipper')
  fetcher.setTempDir(tempRoot)
  queue.setWorkRoot(join(tempRoot, 'jobs'))
  queue.setConcurrency(s.concurrency)
  previewMedia.setCacheDir(join(s.cache.directory, 'preview'))
}

/**
 * Install the named tools one at a time, reporting to the window as it goes.
 * Failures are reported per tool and do not stop the rest — a missing speech
 * model should not cost the user FFmpeg.
 */
async function installTools(ids: ToolId[]): Promise<void> {
  if (installing) {
    throw new AppError({
      code: 'install-busy',
      title: 'Setup is already running',
      message: 'Ripper Clipper is already downloading tools. Wait for it to finish, or cancel it first.'
    })
  }
  installing = new AbortController()
  const send = (progress: InstallProgress): void => {
    mainWindow?.webContents.send(IPC.evtDeps, progress)
  }
  try {
    for (const id of ids) {
      try {
        await tools.install(id, send, installing.signal)
      } catch (err) {
        log.error('deps', `Could not install ${id}`, err)
        const serialized = serializeError(err)
        send({
          id,
          label: id,
          stage: 'failed',
          fraction: 1,
          receivedBytes: 0,
          totalBytes: null,
          message: serialized.message
        })
        mainWindow?.webContents.send(IPC.evtToast, {
          kind: 'error',
          title: serialized.title,
          message: serialized.message
        })
      }
    }
  } finally {
    installing = null
    await detectEnvironment()
    mainWindow?.webContents.send(IPC.evtDeps, {
      id: 'ffmpeg',
      label: 'Setup',
      stage: 'done',
      fraction: 1,
      receivedBytes: 0,
      totalBytes: null,
      message: 'Setup finished.'
    })
  }
}

/**
 * First run: set the whole thing up, without asking.
 *
 * The editor's job is to open the app. Everything it needs — FFmpeg and
 * yt-dlp — is fetched from its publisher, verified and installed here, in
 * order of how much the app is crippled without it. Progress shows in the
 * window; the whole run can be cancelled, and a failure of one tool never
 * stops the others.
 *
 * Settings → Tools has a switch to turn this off for anyone who would rather
 * manage it themselves.
 */
async function autoInstallMissing(): Promise<void> {
  if (!settings.current.advanced.autoInstallTools) return

  const env = await detectEnvironment()
  const status = await tools.status()
  const missing = (id: ToolId): boolean =>
    !status.find((t) => t.id === id)?.installed && !status.find((t) => t.id === id)?.unsupported

  // Something already working on the machine counts: nothing is fetched twice.
  const wanted: ToolId[] = []
  if (!env.ffmpeg.available && missing('ffmpeg')) wanted.push('ffmpeg')
  if (!env.resolver.available && missing('ytdlp')) wanted.push('ytdlp')
  if (wanted.length === 0) return

  log.info('deps', 'Setting up automatically', { tools: wanted })
  mainWindow?.webContents.send(IPC.evtToast, {
    kind: 'info',
    title: 'Setting up',
    message:
      "Ripper Clipper is downloading what it needs from the publishers' own releases. You can keep working — progress is in Settings → Setup."
  })

  await installTools(wanted)
}

function wireQueue(): void {
  queue.on('jobs', (jobs) => {
    mainWindow?.webContents.send(IPC.evtJobs, jobs)
  })
}

function wireUpdater(): void {
  updater.on('status', (status) => {
    mainWindow?.webContents.send(IPC.evtUpdate, status)
  })
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    // Small enough to park in a corner of the screen. The layout is designed
    // for 1280×720 and up, but below that it keeps narrowing rather than
    // clipping — the picture letterboxes and the panels give up width in a
    // fixed order — so there is no reason to stop the editor making the window
    // as small as they want.
    minWidth: 560,
    minHeight: 380,
    // Matches --surface, so the first paint is not a white flash.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161b' : '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    title: 'Ripper Clipper',
    icon: iconPath(),
    // No OS-drawn titlebar: the app's own topbar is the drag region and
    // draws its own minimize/maximize/close, in its own theme.
    frame: false,
    webPreferences: {
      preload: join(__dirname_, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Every close path — the titlebar button, Alt+F4, the taskbar — ends up
  // here. The renderer gets one chance to check for unsaved work before the
  // window actually goes; windowConfirmClose is how it says "go ahead".
  mainWindow.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    mainWindow?.webContents.send(IPC.evtBeforeClose)
  })

  // The renderer draws its own maximize/restore icon; it has to be told
  // when the real state changes, including from a source that isn't its own
  // button — double-clicking the drag region, Aero Snap, the Windows key
  // shortcuts.
  const sendMaximized = (): void =>
    mainWindow?.webContents.send(IPC.evtWindowMaximized, mainWindow.isMaximized())
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    await mainWindow.loadURL(devUrl)
    return
  }

  // `localhost` is preferred over the raw loopback address because embedded
  // platform players validate the parent hostname; fall back if it will not
  // resolve on this machine.
  try {
    await mainWindow.loadURL(localServer!.url)
  } catch {
    await mainWindow.loadURL(localServer!.loopbackUrl)
  }
}

/**
 * The tray icon. Purely additive — it never changes what closing or
 * minimizing the window does, it just gives a way back to the window (and
 * to quitting) when it's out of sight, which matters for a long export
 * batch running in the background.
 */
function createTray(): void {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Ripper Clipper')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Ripper Clipper',
        click: () => {
          if (!mainWindow) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

// ------------------------------------------------------------------ IPC ----

function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as never[]))
    } catch (err) {
      log.error('ipc', `${channel} failed`, err)
      // Rethrow a serialisable, user-readable error across the bridge.
      const serialized = serializeError(err)
      const error = new Error(JSON.stringify(serialized))
      error.name = 'AppErrorEnvelope'
      throw error
    }
  })
}

/**
 * Resolve the audio POV of every clip that has one. The picture and the sound
 * come from different recordings, so each is fetched from its own source with
 * its own local range.
 */
async function withAudioPovStreams(req: EnqueueRequest): Promise<QueueClipInput[]> {
  const out: QueueClipInput[] = []
  for (const clip of req.clips) {
    if (!clip.audio) {
      out.push(clip)
      continue
    }
    const formats = clip.audio.source.formats?.length
      ? clip.audio.source.formats
      : await sources.inspectFormats(clip.audio.source)
    const selected = selectStreams(formats, req.settings.quality)
    const stream = selected.audio ?? (selected.muxed ? selected.video : null)
    if (!stream) {
      log.warn('export', 'Audio POV has no usable audio stream; keeping the video POV sound', {
        clip: clip.name,
        source: clip.audio.source.title
      })
      out.push({
        id: clip.id,
        name: clip.name,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds
      })
      continue
    }
    out.push({
      id: clip.id,
      name: clip.name,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      audioOverride: {
        stream,
        startSeconds: clip.audio.startSeconds,
        endSeconds: clip.audio.endSeconds
      }
    })
  }
  return out
}

function registerIpc(): void {
  handle(IPC.envInfo, () => ({
    ffmpeg: ffmpeg.current(),
    resolver: resolver.current(),
    platform: process.platform,
    appVersion: app.getVersion(),
    defaultOutputDirectory: settings.current.outputDirectory,
    mediaProxyBase: localServer?.loopbackUrl ?? ''
  }))
  handle(IPC.envRefresh, () => detectEnvironment())

  handle(IPC.settingsGet, () => settings.current)
  handle(IPC.settingsUpdate, async (patch: Partial<AppSettings>) => {
    const next = await settings.update(patch)
    applySettings(next)
    await detectEnvironment()
    return next
  })
  handle(IPC.settingsPickOutputDir, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose an output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(IPC.settingsPickFile, async (kind: 'ffmpeg' | 'ffprobe' | 'ytdlp') => {
    const result = await dialog.showOpenDialog({
      title: `Locate ${kind}`,
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Executable', extensions: ['exe'] }]
          : [{ name: 'All files', extensions: ['*'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(
    IPC.sourceResolve,
    async (url: string, event?: { projectId: string; projectName: string; eventName?: string }) => {
    const source = await sources.resolve(url)
    // Loading a POV is how a streamer earns a place in the library — and, when
    // the caller says which event it was for, what they have worked on (§13).
    await streamers.remember({ ...source, event }).catch((err) =>
      log.warn('streamers', 'Could not save this streamer automatically', err)
    )
      return source
    }
  )
  handle(IPC.sourceInspectFormats, (source: VodSource) => sources.inspectFormats(source))

  handle(IPC.projectNew, (name: string) => projects.createProject(name))
  handle(IPC.projectSave, async (project: ProjectFile, path?: string) => {
    let target = path
    if (!target) {
      const result = await dialog.showSaveDialog({
        title: 'Save project',
        defaultPath: join(await ensureDefaultProjectsDir(), projects.defaultFileName(project)),
        filters: [{ name: 'Ripper Clipper project', extensions: [PROJECT_EXTENSION] }]
      })
      if (result.canceled || !result.filePath) throw new Error('Save cancelled')
      target = result.filePath
    }
    const saved = await projects.save(project, target)
    return { path: target, project: saved }
  })
  handle(IPC.projectSaveAs, async (project: ProjectFile) => {
    const result = await dialog.showSaveDialog({
      title: 'Save project as',
      defaultPath: join(await ensureDefaultProjectsDir(), projects.defaultFileName(project)),
      filters: [{ name: 'Ripper Clipper project', extensions: [PROJECT_EXTENSION] }]
    })
    if (result.canceled || !result.filePath) return null
    const saved = await projects.save(project, result.filePath)
    return { path: result.filePath, project: saved }
  })
  /**
   * §20 — a portable package: the work, never the media. See
   * shared/packaging.ts for why the VODs are named rather than carried.
   */
  handle(IPC.packageExport, async (req: { project: ProjectFile; options: PackageOptions }) => {
    const result = await dialog.showSaveDialog({
      title: 'Export package',
      defaultPath: join(
        await ensureDefaultProjectsDir(),
        `${req.project.name.replace(/[\\/:*?"<>|]/g, '_')}.${PACKAGE_EXTENSION}`
      ),
      filters: [{ name: 'Ripper Clipper package', extensions: [PACKAGE_EXTENSION] }]
    })
    if (result.canceled || !result.filePath) return null
    const pkg = buildPackage(req.project, { ...req.options, appVersion: app.getVersion() })
    await atomicWriteJson(result.filePath, pkg)
    log.info('packaging', 'Exported a package', {
      path: result.filePath,
      clips: pkg.project.clips.length
    })
    return { path: result.filePath, clips: pkg.project.clips.length, povs: pkg.project.sources.length }
  })

  handle(IPC.packageImport, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open package',
      defaultPath: await ensureDefaultProjectsDir(),
      properties: ['openFile'],
      filters: [{ name: 'Ripper Clipper package', extensions: [PACKAGE_EXTENSION] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const raw = await readFile(result.filePaths[0], 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw Errors.projectCorrupt(result.filePaths[0], 'not valid JSON')
    }
    // readPackage refuses anything that is not actually a package, so an
    // unrelated JSON file can never arrive as an empty project.
    return readPackage(parsed)
  })

  handle(IPC.projectOpen, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open project',
      defaultPath: await ensureDefaultProjectsDir(),
      properties: ['openFile'],
      filters: [{ name: 'Ripper Clipper project', extensions: [PROJECT_EXTENSION] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    return { path, project: await projects.open(path) }
  })
  handle(IPC.projectOpenPath, async (path: string) => ({
    path,
    project:
      path === (await projects.recoveryInfo()).path
        ? await projects.loadRecovery()
        : await projects.open(path)
  }))
  handle(IPC.projectAutosave, (project: ProjectFile) => projects.autosave(project))
  handle(IPC.projectRecoveryCheck, () => projects.recoveryInfo())
  handle(IPC.projectRecoveryDiscard, () => projects.discardRecovery())
  handle(IPC.projectRecent, () => projects.recent())
  handle(IPC.projectBackupList, (path: string) => projects.listBackups(path))
  handle(IPC.projectBackupRestore, (path: string) => projects.restoreBackup(path))
  handle(IPC.projectStartupPath, () => startupProjectPath())

  handle(IPC.audioPeaks, async (req: PeaksQuery) => {
    const startSeconds = Math.max(0, req.startSeconds)
    const endSeconds = Math.min(req.source.durationSeconds, req.endSeconds)
    const buckets = Math.max(50, Math.min(4000, req.buckets))
    const key = waveCache.keyFor(
      `${req.source.id}:${startSeconds.toFixed(2)}:${endSeconds.toFixed(2)}:${buckets}`
    )
    const cached = await waveCache.getJson<PeaksReply>(key)
    if (cached) return cached

    const formats = req.source.formats?.length
      ? req.source.formats
      : await sources.inspectFormats(req.source)
    const selected = selectStreams(formats, 'best')
    const stream = selected.audio ?? selected.video
    if (!stream) {
      throw Errors.qualityUnavailable('any audio stream', `${req.source.title} exposes no audio`)
    }
    const result = await mediaWorkLimiter.run(() =>
      peaks.peaks({ stream, startSeconds, endSeconds, buckets, workDir: join(tempRoot, 'waveform') })
    )
    await waveCache.putJson(key, result)
    return result
  })

  handle(IPC.sceneChanges, async (req: SceneChangesQuery) => {
    const startSeconds = Math.max(0, req.startSeconds)
    const endSeconds = Math.min(req.source.durationSeconds, req.endSeconds)
    const threshold = Math.max(0.05, Math.min(1, req.threshold ?? 0.35))
    const key = sceneCache.keyFor(
      `${req.source.id}:${startSeconds.toFixed(2)}:${endSeconds.toFixed(2)}:${threshold}`
    )
    const cached = await sceneCache.getJson<SceneChangesReply>(key)
    if (cached) return cached

    const formats = req.source.formats?.length
      ? req.source.formats
      : await sources.inspectFormats(req.source)
    const selected = selectStreams(formats, 'best')
    const stream = selected.video
    if (!stream) {
      throw Errors.qualityUnavailable('any video stream', `${req.source.title} exposes no video`)
    }
    const result = await mediaWorkLimiter.run(() =>
      scenes.detect({ stream, startSeconds, endSeconds, threshold, workDir: join(tempRoot, 'scenes') })
    )
    await sceneCache.putJson(key, result)
    return result
  })

  handle(IPC.filmstrip, async (req: FilmstripQuery) => {
    const startSeconds = Math.max(0, req.startSeconds)
    const endSeconds = Math.min(req.source.durationSeconds, req.endSeconds)
    const frameCount = Math.max(1, Math.min(60, req.frameCount))
    const width = Math.max(16, Math.min(480, req.width))
    const key = thumbCache.keyFor(
      `${req.source.id}:${startSeconds.toFixed(2)}:${endSeconds.toFixed(2)}:${frameCount}:${width}`
    )
    const cached = await thumbCache.getJson<FilmstripReply>(key)
    if (cached) return cached

    const formats = req.source.formats?.length
      ? req.source.formats
      : await sources.inspectFormats(req.source)
    const selected = selectStreams(formats, 'best')
    const stream = selected.video
    if (!stream) {
      throw Errors.qualityUnavailable('any video stream', `${req.source.title} exposes no video`)
    }
    const result = await mediaWorkLimiter.run(() =>
      thumbs.thumbnails({
        stream,
        startSeconds,
        endSeconds,
        frameCount,
        width,
        workDir: join(tempRoot, 'filmstrip')
      })
    )
    await thumbCache.putJson(key, result)
    return result
  })

  handle(IPC.previewMedia, async (req: PreviewMediaRequest) => {
    const formats = req.source.formats?.length
      ? req.source.formats
      : await sources.inspectFormats(req.source)
    // Preview wants something small and playable, not the best available:
    // a 4K AV1 stream is a poor thing to re-encode for scrubbing.
    const selected = selectStreams(formats, '720')
    const stream = selected.muxed ? selected.video : (selected.video ?? selected.audio)
    if (!stream) {
      throw Errors.qualityUnavailable('a previewable stream', `${req.source.title} exposes none`)
    }
    const asset = await previewMedia.ensure({
      source: req.source,
      stream,
      startSeconds: Math.max(0, req.startSeconds),
      endSeconds: Math.min(req.source.durationSeconds, req.endSeconds),
      workDir: join(tempRoot, 'preview-media'),
      hwAccel: settings.current.export.hwAccel,
      height: req.height
    })
    return {
      url: `${localServer?.loopbackUrl ?? ''}/local?id=${asset.id}`,
      plan: asset.plan,
      reason: asset.reason,
      startSeconds: asset.startSeconds,
      endSeconds: asset.endSeconds,
      cached: asset.cached
    }
  })

  setWatermarkDir(watermarkDir)

  handle(IPC.watermarkList, async () => {
    if (watermarks.list().length === 0) await watermarks.load()
    return watermarks.list()
  })
  handle(IPC.watermarkImport, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a watermark image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    await watermarks.load()
    return watermarks.add(result.filePaths[0])
  })
  handle(IPC.watermarkRemove, async (id: string) => {
    await watermarks.load()
    return watermarks.remove(id)
  })

  handle(IPC.streamersWatermark, async (id: string, watermark: WatermarkConfig | null) =>
    streamers.setWatermark(id, watermark)
  )
  handle(IPC.streamersOverlap, (req: EventOverlapRequest) => streamers.coveringEvent(req))
  handle(IPC.discoverEvent, (req: EventDiscoveryRequest) => discovery.discover(req))
  handle(IPC.transcriptsFor, (sources: VodSource[]) => transcripts.forSources(sources))
  handle(IPC.storageReport, () => storage.report())
  handle(IPC.storageClear, (areaId: string) => storage.clear(areaId))
  handle(IPC.streamersSetGroups, (id: string, groupIds: string[]) => streamers.setGroups(id, groupIds))
  handle(IPC.streamersSetFavorite, (id: string, favorite: boolean) => streamers.setFavorite(id, favorite))
  handle(IPC.streamersRestore, (streamer: SavedStreamer) => streamers.restore(streamer))
  handle(IPC.streamersLinkPerson, (idA: string, idB: string) => streamers.linkPerson(idA, idB))
  handle(IPC.streamersUnlinkPerson, (id: string) => streamers.unlinkPerson(id))
  handle(IPC.streamersVodQuality, (urls: string[]) => streamers.probeQuality(urls))

  handle(IPC.streamerGroupsList, () => streamers.listGroups())
  handle(IPC.streamerGroupsCreate, (name: string, icon?: string, color?: string) =>
    streamers.createGroup(name, icon, color)
  )
  handle(IPC.streamerGroupsUpdate, (id: string, patch: Partial<Pick<StreamerGroup, 'name' | 'icon' | 'color'>>) =>
    streamers.updateGroup(id, patch)
  )
  handle(IPC.streamerGroupsDelete, (id: string) => streamers.deleteGroup(id))

  handle(IPC.depsStatus, () => tools.status())
  handle(IPC.depsCancel, () => {
    installing?.abort()
    installing = null
  })
  handle(IPC.depsInstall, async (ids: ToolId[]) => {
    await installTools(ids)
    return detectEnvironment()
  })

  handle(IPC.streamersList, () => streamers.list())
  handle(IPC.streamersAdd, (input: string, platform?: PlatformId) => streamers.add(input, platform))
  handle(IPC.streamersRemove, (id: string) => streamers.remove(id))
  handle(IPC.streamersVods, async (id: string) => {
    const vods = await streamers.vods(id)
    await streamers.touch(id)
    return vods
  })

  handle(IPC.exportEnqueue, async (req: EnqueueRequest) => {
    const formats = req.source.formats?.length
      ? req.source.formats
      : await sources.inspectFormats(req.source)
    const streams = selectStreams(formats, req.settings.quality)
    return queue.enqueue({
      source: req.source,
      projectName: req.projectName,
      clips: await withAudioPovStreams(req),
      streams,
      settings: req.settings,
      // The renderer resolves which watermark applies (VOD override over
      // streamer default) and hands over the image; the queue just carries it.
      watermark: req.watermark,
      outputDirectory: req.outputDirectory
    })
  })
  handle(IPC.exportCombine, async (req: CombineRequest) => {
    const formats = req.source.formats?.length
      ? req.source.formats
      : await sources.inspectFormats(req.source)
    const streams = selectStreams(formats, req.settings.quality)
    return queue.enqueueCombined({
      source: req.source,
      projectName: req.projectName,
      clips: req.clips,
      streams,
      settings: req.settings,
      // A combined file is cut from one POV, so it takes that POV's watermark
      // exactly as a single clip would.
      watermark: req.watermark,
      outputDirectory: req.outputDirectory,
      outputName: req.outputName
    })
  })
  handle(IPC.exportTimeline, async (req: TimelineExportRequest) => {
    if (req.segments.length === 0) throw Errors.invalidRange('The sequence is empty — nothing to export.')

    // Every distinct POV used anywhere in the sequence needs its formats
    // resolved exactly once, however many segments it appears in.
    const povs = new Map<string, VodSource>()
    for (const seg of req.segments) {
      povs.set(seg.videoSource.id, seg.videoSource)
      if (seg.audioSource) povs.set(seg.audioSource.id, seg.audioSource)
      if (seg.pip) povs.set(seg.pip.source.id, seg.pip.source)
    }
    const streamsByPov = new Map<string, SelectedStreams>()
    for (const pov of povs.values()) {
      const formats = pov.formats?.length ? pov.formats : await sources.inspectFormats(pov)
      streamsByPov.set(pov.id, selectStreams(formats, req.settings.quality))
    }

    const clips: QueueClipInput[] = req.segments.map((seg, i) => {
      const videoStreams = streamsByPov.get(seg.videoSource.id)!
      let audioOverride: QueueClipInput['audioOverride']
      if (seg.audioSource && seg.audioStartSeconds !== null && seg.audioEndSeconds !== null) {
        const audioStreams = streamsByPov.get(seg.audioSource.id)!
        const stream = audioStreams.audio ?? (audioStreams.muxed ? audioStreams.video : null)
        if (stream) {
          audioOverride = { stream, startSeconds: seg.audioStartSeconds, endSeconds: seg.audioEndSeconds }
        } else {
          log.warn('export', 'Audio POV has no usable audio stream; keeping the video POV sound', {
            source: seg.audioSource.title
          })
        }
      }
      let pip: QueueClipInput['pip']
      if (seg.pip) {
        const pipStreams = streamsByPov.get(seg.pip.source.id)!
        const stream = pipStreams.video
        if (stream) {
          pip = { stream, startSeconds: seg.pip.startSeconds, endSeconds: seg.pip.endSeconds, transform: seg.pip.transform }
        } else {
          log.warn('export', 'Pip POV has no usable video stream; exporting without the inset', {
            source: seg.pip.source.title
          })
        }
      }

      return {
        id: `seg-${i}`,
        name: `Segment ${i + 1}`,
        startSeconds: seg.videoStartSeconds,
        endSeconds: seg.videoEndSeconds,
        audioOverride,
        audioEdits: seg.audioEdits,
        source: seg.videoSource,
        streams: videoStreams,
        watermark: seg.watermark,
        transform: seg.transform,
        opacity: seg.opacity,
        audioGain: seg.audioGain,
        pip
      }
    })

    const primary = req.segments[0].videoSource
    return queue.enqueueCombined({
      source: primary,
      streams: streamsByPov.get(primary.id)!,
      projectName: req.projectName,
      clips,
      bleep: req.bleep,
      settings: req.settings,
      watermark: req.segments[0].watermark,
      outputDirectory: req.outputDirectory,
      outputName: req.outputName
    })
  })
  handle(IPC.exportCancel, (jobId: string) => queue.cancel(jobId))
  handle(IPC.exportPause, () => queue.pause())
  handle(IPC.exportResume, () => queue.resume())
  handle(IPC.exportRetry, (jobId: string) => queue.retry(jobId))
  handle(IPC.exportRetryAllFailed, () => queue.retryAllFailed())
  handle(IPC.exportClearFinished, () => queue.clearFinished())
  handle(IPC.exportReorder, (jobId: string, toIndex: number) => queue.reorder(jobId, toIndex))
  handle(IPC.exportList, () => queue.list())
  handle(IPC.exportClipListCsv, async (csv: string, suggestedName: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Export clip list',
      defaultPath: join(await ensureDefaultProjectsDir(), suggestedName),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, csv, 'utf8')
    return result.filePath
  })

  handle(IPC.cacheStats, () => cache.stats())
  handle(IPC.cacheClear, async () => {
    await cache.clear()
    await thumbCache.clear()
    await waveCache.clear()
    await previewMedia.clear()
    return cache.stats()
  })
  handle(IPC.diskSpace, (path: string) => diskSpace(path))

  handle(IPC.revealPath, (path: string) => {
    shell.showItemInFolder(path)
  })
  handle(IPC.openPath, async (path: string) => {
    await shell.openPath(path)
  })

  handle(IPC.logsPath, () => log.path)
  handle(IPC.logsTail, (lines: number) => log.tail(lines))

  handle(IPC.updateCheck, () => updater.check())
  handle(IPC.updateDownload, () => updater.download())
  handle(IPC.updateInstall, () => updater.install())

  handle(IPC.windowMinimize, () => mainWindow?.minimize())
  handle(IPC.windowToggleMaximize, () =>
    mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()
  )
  handle(IPC.windowClose, () => mainWindow?.close())
  handle(IPC.windowConfirmClose, () => {
    allowClose = true
    mainWindow?.close()
  })
  handle(IPC.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)
}

// ------------------------------------------------------------ lifecycle ----

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,BlockInsecurePrivateNetworkRequests')

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const path = startupProjectPath(argv)
    if (path) mainWindow?.webContents.send(IPC.evtOpenProject, path)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    await mkdir(stateDir, { recursive: true })
    await mkdir(tempRoot, { recursive: true })
    await projects.cleanupTemp()

    // Started in every mode: the preview player needs the media proxy even
    // when Vite is serving the renderer.
    localServer = await startLocalServer(app.isPackaged || !process.env.ELECTRON_RENDERER_URL
      ? join(__dirname_, '../renderer')
      : null)

    await mkdir(toolsDir, { recursive: true })
    setManagedToolsDir(toolsDir)
    setLocalFileResolver((id) => previewMedia.resolve(id))

    const loaded = await settings.load()
    wireQueue()
    wireUpdater()
    applySettings(loaded)
    await cache.ensure()
    await cache.prune()
    await thumbCache.ensure()
    await waveCache.ensure()
    await detectEnvironment()

    registerIpc()
    await createWindow()
    createTray()

    // After the window exists, so the user can see it happening.
    void autoInstallMissing().catch((err) => log.error('deps', 'Automatic setup failed', err))
    // Silent unless something is actually found — see UpdateService for why
    // this is a no-op outside the stable channel.
    void updater.check().catch((err) => log.error('updater', 'Startup update check failed', err))

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    log.info('app', 'Shutting down')
  })

  app.on('will-quit', () => {
    void localServer?.close()
    // Best-effort cleanup of job scratch space; cached segments are kept.
    void rm(join(tempRoot, 'jobs'), { recursive: true, force: true }).catch(() => undefined)
    void rm(join(tempRoot, 'previews'), { recursive: true, force: true }).catch(() => undefined)
    void rm(join(tempRoot, 'previews-work'), { recursive: true, force: true }).catch(() => undefined)
    log.close()
  })
}
