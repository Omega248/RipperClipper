import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, shell, Tray } from 'electron'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { Logger } from './services/logger.js'
import { SettingsStore } from './services/settings.js'
import { CacheManager } from './services/cache.js'
import { ProjectStore, PROJECT_EXTENSION, atomicWriteJson, normalizeProject } from './services/projects.js'
import { PACKAGE_EXTENSION, buildPackage, readPackage } from '../shared/packaging.js'
import type { PackageOptions } from '../shared/packaging.js'
import type { EditingProject } from '../shared/editingProject.js'
import type { EditorId } from '../shared/editorCapabilities.js'
import { FfmpegService } from './media/ffmpeg.js'
import { ResolverService } from './media/resolver.js'
import {
  DEFAULT_SEGMENT_PARALLELISM,
  RangeFetcher,
  segmentLimiter
} from './media/rangeFetcher.js'
import { Exporter } from './media/exporter.js'
import { AudioPeaksService } from './media/audioPeaks.js'
import { SceneDetectionService } from './media/sceneDetection.js'
import { ThumbnailService } from './media/thumbnails.js'
import { ConcurrencyLimiter } from './services/limiter.js'
import { PreviewMediaService } from './media/previewMedia.js'
import { ExportQueue } from './services/queue.js'
import type { QueueClipInput } from './services/queue.js'
import { AdapterRegistry } from './platforms/registry.js'
import { VodLibrary } from './services/vodLibrary.js'
import { ProjectExportService, freeDirectory } from './export/projectExporters.js'
import { VodCrawler } from './services/vodCrawler.js'
import { compareAcrossPlatforms } from './services/crossPlatform.js'
import { LiveService } from './services/live.js'
import type { BufferWindow } from '../shared/live.js'
import { mediaProxyToken } from './mediaProxy.js'
import { SourceService } from './services/sources.js'
import { channelVideosUrl, StreamerService } from './services/streamers.js'
import { DiscoveryService } from './services/discovery.js'
import { parseClipLink, momentOf } from '../shared/clipLink.js'
import { windowExtension } from './media/exporter.js'
import { WatermarkLibrary } from './services/watermarks.js'
import { ToolInstaller } from './services/deps.js'
import { UpdateService } from './services/updater.js'
import { setManagedToolsDir } from './services/locate.js'
import { rankVideo, selectStreams } from './media/formats.js'
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
import {
  startLocalServer,
  setLocalFileResolver,
  setMediaSegmentStore,
  setWatermarkDir
} from './localServer.js'
import type { LocalServer } from './localServer.js'

const __dirname_ = dirname(fileURLToPath(import.meta.url))

/*
 * The app was renamed from CookieClipper to RiptideClips, but `userData`
 * defaults to a folder named after `app.name` — which Electron reads from
 * package.json — so renaming that field would have silently pointed every
 * existing install at an empty new folder: projects, saved streamers,
 * installed tools (ffmpeg, yt-dlp), cached watermarks, all of it,
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

/**
 * Push to the window, if there is still a window to push to.
 *
 * `mainWindow` is null only before the first window exists. Between `close`
 * and that, it is non-null but *destroyed*, and `webContents.send` on a
 * destroyed window throws — so the optional chain these calls used was
 * guarding the wrong half of the lifetime.
 *
 * It matters because every push here is a notification about background work,
 * and background work does not stop the instant the window goes: aborting the
 * export queue during shutdown emits a job update per cancelled job, all of
 * them after the window has been destroyed.
 */
function toWindow(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
}
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
const sources = new SourceService(log, registry, resolver, () =>
  settings.current.advanced.cookiesFromBrowser ?? null
)
const streamers = new StreamerService(log, resolver, stateDir)
/*
 * Every saved streamer's back catalogue, and the slow crawl that fills it in.
 *
 * The crawl stands aside whenever the export queue has anything running: the
 * person is waiting on those, and nobody is waiting on this.
 */
const vodLibrary = new VodLibrary(log, stateDir)
const projectExport = new ProjectExportService(log)
const vodCrawler = new VodCrawler(
  log,
  streamers,
  vodLibrary,
  () => queue.busy,
  (progress) => toWindow(IPC.evtVodCrawl, progress)
)
// Where a channel's broadcasts come from, once the crawl has read them: the
// shelf, not a fresh listing per caller. See StreamerService.vods.
streamers.shelfFor = (id) => vodLibrary.shelf(id)
// Adding a channel goes looking for that person's other platforms.
streamers.autoDiscoverSiblings = true
const discovery = new DiscoveryService(log, streamers, resolver)
const updater = new UpdateService(log, __CHANNEL__)

let tempRoot = join(app.getPath('temp'), 'ripperclipper')
const fetcher = new RangeFetcher(log, ffmpeg, cache, tempRoot)
// Separated audio is cached beside the media cache: it is expensive to make
// and identical inputs must never be processed twice.
const exporter = new Exporter(log, ffmpeg, fetcher)
const queue = new ExportQueue(log, exporter, join(tempRoot, 'jobs'))
const peaks = new AudioPeaksService(log, ffmpeg, fetcher)

/*
 * Decoded frames for the native player.
 *
 * Constructed but not started: it binds no ports and runs no ffmpeg until
 * something actually asks to decode, so an install that never turns the
 * native engine on pays nothing for it.
 */

/**
 * Live sources.
 *
 * Every state change is pushed rather than polled: the renderer showing a
 * buffer strip must not be the reason a timer exists, and an app with nothing
 * live holds no timers here at all.
 */
const live = new LiveService(
  log,
  (sourceId, state) => {
    // A recording that has just been located, or one that has grown since it
    // was last read. Fire-and-forget: the push below must not wait on a
    // resolve, and the next state change carries whatever it finds.
    if (state.recordingVodId && !state.archivedVodId) {
      void keepRecordingCurrent(sourceId, state.recordingVodId)
    }
    toWindow(IPC.evtLive, {
      sources: live.states(),
      windowNotice: live.windowNotice,
      recordings: Object.fromEntries(liveRecordings)
    })
  },
  (source) => findArchiveFor(source)
)

/**
 * VOD ids each watched channel already had when we started watching it.
 *
 * This is what makes the archive identifiable at all. Dates cannot do it:
 * platforms date an archive from when the broadcast *began*, which is before
 * this app started holding media, so "published since we started" excludes
 * the very VOD being looked for. Titles cannot do it either — broadcasters
 * rename archives, and two sessions in a day look identical.
 *
 * What is reliable is that the archive is the one that was not there before.
 */
const archiveBaseline = new Map<string, Set<string>>()

/** Every recording a channel currently lists, newest first, id and link. */
async function channelVodEntries(source: VodSource): Promise<Array<{ id: string; url: string }>> {
  const handle = source.channelHandle ?? source.vodId
  if (!handle) return []
  /*
   * The cheap listing, deliberately.
   *
   * This function reads nothing but each entry's url and id, and
   * `channelVods` would date every broadcast on the channel first — one
   * yt-dlp process each on Twitch and YouTube. It runs once a minute per live
   * POV, so with nine angles that was hundreds of processes a minute for
   * fields that are thrown away on the next line.
   */
  const vods = await streamers.listChannelVods(source.platform, handle, { priority: 'idle' })
  return vods
    .map((vod) => {
      const id = registry.tryDetect(vod.url)?.match.vodId
      return typeof id === 'string' && id.length > 0 ? { id, url: vod.url } : null
    })
    .filter((entry): entry is { id: string; url: string } => entry !== null)
}

async function channelVodIds(source: VodSource): Promise<string[]> {
  return (await channelVodEntries(source)).map((entry) => entry.id)
}

/**
 * The platform's own recording of a broadcast, resolved so it can be played
 * and cut like any other VOD.
 *
 * This is what turns "the last sixty seconds" into "the whole session from the
 * moment they went live". Twitch, Kick and YouTube each start publishing a
 * recording while the broadcast runs, and it is the same growing HLS playlist
 * the VOD path already knows how to seek and export — so nothing downstream
 * needs to learn anything about live.
 *
 * Re-resolved on every check, because its end moves: a recording found twenty
 * minutes in reports twenty minutes, and the same one an hour later reports an
 * hour. The `id` is what makes it the same recording; the duration is what
 * makes it worth asking again.
 */
const liveRecordings = new Map<string, VodSource>()

/** When each source's recording was last re-read, so growth is picked up but not hammered. */
const recordingReadAt = new Map<string, number>()

/**
 * Keep a live source's recording current, on its own slow clock.
 *
 * The buffer changes state every second or so; re-resolving a VOD that often
 * would be a yt-dlp process per second per POV. Once a minute is enough — the
 * recording lags the live edge by more than that anyway, and the rolling
 * buffer covers the gap.
 */
const RECORDING_REFRESH_MS = 60_000

async function keepRecordingCurrent(sourceId: string, vodId: string): Promise<void> {
  const last = recordingReadAt.get(sourceId) ?? 0
  if (Date.now() - last < RECORDING_REFRESH_MS) return
  recordingReadAt.set(sourceId, Date.now())

  const source = live.sourceFor(sourceId)
  if (!source) return
  await resolveRecording(source, vodId).catch((err) => {
    log.debug('live', 'Could not read the in-progress recording', { source: sourceId, err })
  })
}

async function resolveRecording(source: VodSource, vodId: string): Promise<void> {
  const known = liveRecordings.get(source.id)
  const entries = await channelVodEntries(source)
  const entry = entries.find((e) => e.id === vodId)
  if (!entry) return

  const resolved = await sources.resolve(entry.url)
  // The live source keeps its own identity and its sync mapping — this only
  // supplies the media. Replacing the id would orphan every clip already
  // marked against it.
  liveRecordings.set(source.id, resolved)
  if (!known) {
    log.info('live', 'Clipping the whole broadcast from its recording', {
      source: source.id,
      vodId,
      seconds: Math.round(resolved.durationSeconds)
    })
  }
}

/**
 * Remember what a channel had already published, before this broadcast can
 * add to it.
 *
 * Best-effort and deliberately not awaited by the caller: a channel listing
 * that is slow, rate-limited or broken must not stop the app holding media,
 * which is the part that cannot be done later.
 */
function noteArchiveBaseline(source: VodSource): void {
  if (archiveBaseline.has(source.id)) return
  void channelVodIds(source)
    .then((ids) => {
      if (!archiveBaseline.has(source.id)) archiveBaseline.set(source.id, new Set(ids))
    })
    .catch(() => undefined)
}

/**
 * The VOD a finished broadcast became, or null while the platform is still
 * publishing it.
 */
async function findArchiveFor(source: VodSource): Promise<string | null> {
  const ids = await channelVodIds(source)
  if (ids.length === 0) return null

  const before = archiveBaseline.get(source.id)
  if (!before) {
    // The baseline never landed while the broadcast was running. Everything
    // listed now might predate it, so claiming any of them would be a guess;
    // take the baseline instead and let the next poll find what appears after.
    archiveBaseline.set(source.id, new Set(ids))
    return null
  }
  // Newest first, so the first unfamiliar id is the most recent one — which
  // for a channel that has published nothing else since is this broadcast.
  return ids.find((id) => !before.has(id)) ?? null
}

// The player and the exporter now share one segment store: the seconds an
// editor watches are the seconds they cut, so watching warms exactly what the
// export needs instead of paying for the same bytes twice.
setMediaSegmentStore(cache)

/**
 * Rebuild the streamer list from the VOD library, if the list is empty and the
 * library is not.
 *
 * The two files are written independently, and a streamer library that has
 * been emptied while a back catalogue of thousands of dated broadcasts still
 * sits beside it — every shelf carrying the platform, the handle and the
 * streamer id it belongs to — is not a person who deleted their streamers. It
 * is a lost file, and the answer to it is right there.
 *
 * Only ever *adds*: `restore` refuses an id that already exists, so this can
 * run on every launch and does nothing on all of them but the bad one.
 */
async function recoverStreamersFromLibrary(): Promise<void> {
  const shelves = vodLibrary.all().filter((shelf) => shelf.vods.length > 0)

  /*
   * Collapse duplicates first, every launch.
   *
   * The ids that already have a crawled back catalogue are named as the ones
   * to keep, so a channel saved twice keeps the copy whose broadcasts have
   * been dated — that is the expensive half and the only part not cheaply
   * re-fetched.
   */
  const shelved = new Set(shelves.map((shelf) => shelf.streamerId))
  const { removed } = await streamers.dedupe(shelved).catch(() => ({ removed: [] as string[] }))
  for (const id of removed) vodLibrary.forget(id)

  if (shelves.length === 0) return

  const current = await streamers.list().catch(() => null)
  if (current === null || current.length > 0) return

  log.warn('streamers', 'Streamer library was empty; rebuilding it from the VOD shelves', {
    streamers: shelves.length
  })

  for (const shelf of shelves) {
    await streamers
      .restore({
        id: shelf.streamerId,
        platform: shelf.platform,
        handle: shelf.handle,
        // The real display name and picture come back on the next profile
        // refresh; the handle is what makes the row usable in the meantime.
        displayName: shelf.handle,
        channelUrl: channelVideosUrl(shelf.platform, shelf.handle),
        addedAt: shelf.listedAt ?? new Date().toISOString(),
        lastUsedAt: null
      })
      .catch((err) => log.warn('streamers', 'Could not restore a streamer', err))
  }

  // Names and avatars, once, in the background.
  void streamers.refreshStaleProfiles().catch(() => undefined)
}

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

/**
 * Where the tools are and what they can do.
 *
 * Cheap to call: both services remember their answer against the paths it
 * came from, so this only does real work when a path changed or `force` says
 * to look again. Forcing is for the moments when the answer can genuinely
 * have changed underneath us — startup, after installing a tool, or when the
 * person asks.
 */
async function detectEnvironment(force = false): Promise<EnvInfo> {
  const s = settings.current
  const bin = resourcesDir()
  const [ffmpegInfo, resolverInfo] = await Promise.all([
    ffmpeg.detect(
      {
        ffmpegPath: s.advanced.ffmpegPath,
        ffprobePath: s.advanced.ffprobePath,
        bundledDir: bin
      },
      { force }
    ),
    resolver.detect(s.advanced.ytDlpPath, bin, { force })
  ])

  return {
    ffmpeg: ffmpegInfo,
    resolver: resolverInfo,
    platform: process.platform,
    appVersion: app.getVersion(),
    defaultOutputDirectory: s.outputDirectory,
    mediaProxyBase: localServer?.loopbackUrl ?? '',
    // The proxy will not serve a caller that cannot prove it is this app, and
    // the renderer builds its own player URLs, so it needs the same secret.
    mediaProxyToken: mediaProxyToken()
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
  /*
   * "Maximum cache size" means the whole of it.
   *
   * There are five caches on disk — segments, previews, filmstrips, waveforms
   * and scene marks — and the setting used to govern only the first. The
   * other four carried fixed budgets totalling about 2.4 GB that nothing in
   * Settings accounted for, so choosing 8 GB really meant up to 10.4 GB. Each
   * now takes a share of the number the user actually set, and the segment
   * cache keeps the bulk of it because it is the one holding source media.
   */
  const budget = s.cache.maxSizeBytes
  const share = (fraction: number, min: number): number =>
    Math.max(min, Math.floor(budget * fraction))

  cache.configure(s.cache.directory, share(0.6, 512 * 1024 * 1024))
  previewMedia.setMaxSizeBytes(share(0.25, 256 * 1024 * 1024))
  thumbCache.configure(join(s.cache.directory, 'thumbnails'), share(0.1, 64 * 1024 * 1024))
  waveCache.configure(join(s.cache.directory, 'waveforms'), share(0.04, 32 * 1024 * 1024))
  sceneCache.configure(join(s.cache.directory, 'scenes'), share(0.01, 16 * 1024 * 1024))
  tempRoot = s.advanced.tempDirectory ?? join(app.getPath('temp'), 'ripperclipper')
  fetcher.setTempDir(tempRoot)
  queue.setWorkRoot(join(tempRoot, 'jobs'))
  queue.setConcurrency(s.concurrency)
  /*
   * One "how many at once" setting, two budgets — because the two halves of
   * an export are limited by different things.
   *
   * Downloading is network-bound and idle most of the time, so the segment
   * budget scales *up* with the number of exports: that is what keeps the
   * connection busy. Encoding is CPU-bound, so the thread budget scales
   * *down* — the machine is a fixed size, and thirty ffmpegs each sizing
   * their pool to every core would oversubscribe it thirtyfold and spend the
   * difference on context switching rather than frames.
   *
   * Both are ceilings, not reservations. An export that stream-copies (the
   * normal case, and the whole point of fetching only the range asked for)
   * never encodes anything and so never spends a thread from the second one.
   *
   * The thread budget is the machine minus one core, not the whole machine.
   * Exports already run below the foreground (see ProcessPriority), which
   * hands cycles back the moment anything else asks for them — but "the
   * moment anything else asks" is still a scheduling round trip, and on a
   * fully claimed CPU the person feels it as the interface hesitating. One
   * core left unclaimed means the window, the compositor and this process
   * always have somewhere to run without waiting for a preemption. It costs
   * a fraction of the encode and buys back the thing that made the machine
   * feel stuck.
   */
  const cores = cpus().length || 4
  const encodeBudget = Math.max(1, cores - 1)
  segmentLimiter.setMax(Math.min(64, Math.max(16, s.concurrency * DEFAULT_SEGMENT_PARALLELISM)))
  exporter.setEncodeThreads(Math.max(1, Math.floor(encodeBudget / s.concurrency)))
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
    toWindow(IPC.evtDeps, progress)
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
        toWindow(IPC.evtToast, {
          kind: 'error',
          title: serialized.title,
          message: serialized.message
        })
      }
    }
  } finally {
    installing = null
    await detectEnvironment(true)
    toWindow(IPC.evtDeps, {
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
  toWindow(IPC.evtToast, {
    kind: 'info',
    title: 'Setting up',
    message:
      "Ripper Clipper is downloading what it needs from the publishers' own releases. You can keep working — progress is in Settings → Setup."
  })

  await installTools(wanted)
}

function wireQueue(): void {
  queue.on('jobs', (jobs) => {
    toWindow(IPC.evtJobs, jobs)
  })
}

function wireUpdater(): void {
  updater.on('status', (status) => {
    toWindow(IPC.evtUpdate, status)
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
    /*
     * Nobody left to ask.
     *
     * The veto hands the decision to the renderer and waits for it to call
     * back. If the render process has died — an out-of-memory on a long
     * timeline, a decoder crash — the BrowserWindow object survives and is
     * not `isDestroyed()`, so the message is sent into a dead frame and no
     * answer ever comes. The window then could not be closed by the titlebar,
     * Alt+F4 or the tray, and the only way out was Task Manager: the abrupt
     * kill that orphans ffmpeg and leaves scratch behind, which is precisely
     * what the shutdown path exists to prevent.
     *
     * There is also nothing to lose by going: an unsaved project lives in the
     * renderer that just died. The React error boundary covers a throw inside
     * a live renderer, not the process itself dying.
     */
    if (mainWindow?.webContents.isCrashed()) {
      log.warn('app', 'Closing without the usual check: the window process is not responding')
      return
    }
    event.preventDefault()
    toWindow(IPC.evtBeforeClose)
  })

  // The renderer draws its own maximize/restore icon; it has to be told
  // when the real state changes, including from a source that isn't its own
  // button — double-clicking the drag region, Aero Snap, the Windows key
  // shortcuts.
  const sendMaximized = (): void => {
    if (!mainWindow) return
    toWindow(IPC.evtWindowMaximized, mainWindow.isMaximized())
  }
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  /*
   * The window never leaves its own origin.
   *
   * The preload is attached to the webContents, not to a page, so anything the
   * window navigates to inherits the entire `window.api` surface — every IPC
   * handler, including the ones that spawn processes and write files. Popups
   * were already denied above; top-level navigation was not, and a single
   * `location = …` from injected script was enough to hand all of that to a
   * remote page. A link the user actually meant still opens, in their browser,
   * where it has none of this.
   */
  const appOrigin = (): string | null => {
    try {
      return new URL(mainWindow?.webContents.getURL() ?? '').origin
    } catch {
      return null
    }
  }
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      event.preventDefault()
      return
    }
    if (target.origin === appOrigin()) return
    event.preventDefault()
    log.warn('security', 'Blocked navigation away from the app', { to: target.origin })
    if (target.protocol === 'http:' || target.protocol === 'https:') void shell.openExternal(url)
  })
  // A webview or a devtools-extension page would get its own contents; neither
  // is used here, and this makes sure neither quietly starts being.
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

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
    /*
     * `audio` is separated from everything else the clip carries, because it
     * is the one field that does not travel: it is resolved into
     * `audioOverride` below. Everything else travels by spreading `carried`.
     *
     * Both pushes used to hand-list the four fields they passed on, so any
     * other field was dropped exactly when a clip had an audio POV — and the
     * field that mattered was `audioEdits`, in the case the feature is most
     * useful in: you mute the POV whose mic caught the thing that cannot go
     * out. A field added to the request type now travels by default instead
     * of having to be remembered here.
     */
    const { audio, ...carried } = clip
    if (!audio) {
      out.push(carried)
      continue
    }
    const formats = audio.source.formats?.length
      ? audio.source.formats
      : await sources.inspectFormats(audio.source)
    const selected = selectStreams(formats, req.settings.quality)
    const stream = selected.audio ?? (selected.muxed ? selected.video : null)
    if (!stream) {
      log.warn('export', 'Audio POV has no usable audio stream; keeping the video POV sound', {
        clip: clip.name,
        source: audio.source.title
      })
      out.push(carried)
      continue
    }
    out.push({
      ...carried,
      audioOverride: {
        stream,
        startSeconds: audio.startSeconds,
        endSeconds: audio.endSeconds
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
    mediaProxyBase: localServer?.loopbackUrl ?? '',
    mediaProxyToken: mediaProxyToken()
  }))
  handle(IPC.envRefresh, () => detectEnvironment(true))

  handle(IPC.settingsGet, () => settings.current)

  /*
   * Executable paths the person actually chose, this session.
   *
   * `advanced.ffmpegPath` and its siblings are spawned. The settings patch
   * arrives from the renderer as plain strings, so a compromised renderer
   * could point any of them at any file on disk and have the app run it on the
   * next export — no dialog, no prompt. The only legitimate way to set one is
   * the file picker below, so that is the only source accepted: anything else
   * keeps whatever is already saved.
   *
   * Paths chosen in an earlier session are unaffected — they load from
   * settings.json, not over IPC.
   */
  const pickedToolPaths = new Set<string>()

  const keepToolPaths = (patch: Partial<AppSettings>): Partial<AppSettings> => {
    if (!patch.advanced) return patch
    const current = settings.current.advanced
    const advanced = { ...patch.advanced }
    for (const key of ['ffmpegPath', 'ffprobePath', 'ytDlpPath'] as const) {
      const value = advanced[key]
      // Null is always allowed: clearing an override falls back to the
      // bundled tool, which is a safe direction to move in.
      if (value === null || value === undefined) continue
      if (value === current[key] || pickedToolPaths.has(value)) continue
      log.warn('security', `Refused a ${key} that did not come from the file picker`)
      advanced[key] = current[key]
    }
    return { ...patch, advanced }
  }

  handle(IPC.settingsUpdate, async (patch: Partial<AppSettings>) => {
    const next = await settings.update(keepToolPaths(patch))
    applySettings(next)
    // Unforced: this returns immediately unless the patch moved a tool path,
    // which is the only way a settings change can alter what is installed.
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
    const chosen = result.canceled ? null : (result.filePaths[0] ?? null)
    if (chosen) pickedToolPaths.add(chosen)
    return chosen
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
  handle(IPC.sourceLiveStatus, (source: VodSource) => sources.liveStatus(source))

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
    const pkg = readPackage(parsed)
    /*
     * Then the same validation a project file gets.
     *
     * `readPackage` is deliberately strict about the envelope and forgiving
     * about the contents, so that a package written by an older build still
     * opens. But forgiving had become unchecked: `clips` and `sources` were
     * cast straight through, while the identical data arriving as a
     * `.cookieclip` goes through `normalizeProject`, which drops what cannot
     * work, fills what is merely missing, and migrates old schemas. A package
     * is the *less* trustworthy of the two — it came from somebody else's
     * machine — so it was the one entry point without the checks.
     *
     * Normalising here also gives the renderer a real ProjectFile rather than
     * the package's narrower project shape, which is what it needs to open it.
     */
    const project = normalizeProject(
      { ...pkg.project, name: pkg.project.name },
      result.filePaths[0]
    )
    log.info('packaging', 'Imported a package', {
      clips: project.clips.length,
      povs: project.sources.length,
      // What validation actually threw away, so a package that arrives
      // half-empty is diagnosable rather than mysterious.
      droppedClips: pkg.project.clips.length - project.clips.length,
      droppedPovs: pkg.project.sources.length - project.sources.length,
      createdBy: pkg.createdBy
    })
    return { project, createdAt: pkg.createdAt, createdBy: pkg.createdBy, note: pkg.note }
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

  handle(IPC.liveWatch, async (source: VodSource) => {
    const formats = await sources.inspectFormats(source)
    const stream = formats.filter((f) => f.protocol === 'hls' && f.hasVideo && f.url).sort(rankVideo)[0]
    // A live source that is not HLS is not a live source this app can hold:
    // there is no segment timeline to roll a buffer over. Saying so is better
    // than presenting a buffer strip that will never fill.
    if (!stream) throw Errors.liveUnsupported(source.platform)
    // Before any of this broadcast can reach the channel's VOD list.
    noteArchiveBaseline(source)
    return live.watch(source, stream)
  })
  handle(IPC.liveUnwatch, (sourceId: string) => {
    archiveBaseline.delete(sourceId)
    /*
     * The recording goes with the source it belongs to.
     *
     * These two were left behind on unwatch, and neither is inert. The
     * resolved recording keeps being pushed to the renderer in every
     * subsequent `evtLive` payload, and its media URLs are signed and
     * short-lived — so watching the same channel again picked up a stale
     * recording whose links had expired, and `recordingReadAt` then held the
     * refresh off for up to a minute, because as far as it was concerned this
     * source had just been read. A clip cut in that window failed on a dead
     * URL rather than on anything the person did.
     */
    liveRecordings.delete(sourceId)
    recordingReadAt.delete(sourceId)
    live.unwatch(sourceId)
  })
  // The same shape the push sends: a renderer that reloads mid-broadcast must
  // not lose the recording (and with it the ability to cut the whole session)
  // until the next state change happens to arrive.
  handle(IPC.liveStates, () => ({
    sources: live.states(),
    windowNotice: live.windowNotice,
    recordings: Object.fromEntries(liveRecordings)
  }))
  handle(IPC.liveCovers, (req: { sourceId: string; startEpoch: number; endEpoch: number }) =>
    live.covers(req.sourceId, req.startEpoch, req.endEpoch)
  )
  handle(IPC.liveWindow, (seconds: BufferWindow) => {
    live.setWindow(seconds)
    return { sources: live.states(), windowNotice: live.windowNotice }
  })

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
  handle(IPC.watermarkAddPng, async (dataUrl: string, name: string) => {
    await watermarks.load()
    return watermarks.addPng(dataUrl, name)
  })
  handle(IPC.watermarkRemove, async (id: string) => {
    await watermarks.load()
    return watermarks.remove(id)
  })

  handle(IPC.streamersWatermark, async (id: string, watermark: WatermarkConfig | null) =>
    streamers.setWatermark(id, watermark)
  )
  /*
   * The editing-project export.
   *
   * The universal project is built in the renderer — `buildEditingProject` is
   * a pure function in `shared/`, and the renderer is where the clip, the
   * angles and the watermark already live. This side validates it, writes the
   * package, and never touches the media it points at.
   */
  handle(IPC.editorsList, () => projectExport.capabilities())
  handle(IPC.editingProjectValidate, (project: EditingProject, editor: EditorId) =>
    projectExport.validate(project, editor)
  )
  handle(
    IPC.editingProjectExport,
    async (req: {
      project: EditingProject
      editor: EditorId
      parentDirectory: string
      copyMedia: boolean
    }) => {
      // A folder that already exists is never written into: "Bank job (2)"
      // beside it, rather than somebody's last export quietly replaced.
      const directory = await freeDirectory(req.parentDirectory, req.project.name)
      return projectExport.export(req.project, req.editor, {
        directory,
        copyMedia: req.copyMedia === true
      })
    }
  )
  handle(IPC.editingProjectChooseFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Where should the editing project be written?',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(IPC.streamersOverlap, (req: EventOverlapRequest) => streamers.coveringEvent(req))
  handle(IPC.discoverEvent, (req: EventDiscoveryRequest) => discovery.discover(req))

  /**
   * Turn a shared link into the real-world instant it points at.
   *
   * A clip names its parent broadcast and when it was taken; a VOD link
   * carries its offset in the URL. Anything that cannot be placed on the
   * clock comes back with a null moment and a reason, never a guess — a
   * wrong time would quietly seed the search with the wrong POVs.
   */
  handle(IPC.resolveMoment, async (url: string) => {
    const link = parseClipLink(url)
    if (!link) {
      return {
        momentSeconds: null,
        source: null,
        offsetSeconds: null,
        note: 'That is not a clip or VOD link this app recognises.'
      }
    }

    const raw = await resolver.resolve(link.url)
    const startedAt =
      typeof raw.timestamp === 'number'
        ? new Date(raw.timestamp * 1000).toISOString()
        : typeof raw.release_timestamp === 'number'
          ? new Date(raw.release_timestamp * 1000).toISOString()
          : null

    if (link.kind === 'clip') {
      // A clip's own timestamp IS the moment — it was cut from the broadcast
      // at that instant, so there is no offset arithmetic to do.
      const at = startedAt ? Date.parse(startedAt) / 1000 : null
      return {
        momentSeconds: at,
        source: null,
        offsetSeconds: null,
        note: at
          ? 'Found the moment this clip was taken from.'
          : 'That clip did not report when it was taken.'
      }
    }

    const source = await sources.resolve(link.url).catch(() => null)
    const offset = link.offsetSeconds ?? null
    const moment = momentOf(startedAt ?? source?.createdAt ?? null, offset)
    return {
      momentSeconds: moment,
      source,
      offsetSeconds: offset,
      note: moment
        ? 'Found the moment this link points at.'
        : offset === null
          ? 'That link has no timestamp in it — add one, or paste a clip link.'
          : 'That broadcast did not report when it started.'
    }
  })

  /**
   * Keep a POV's range on disk before the platform deletes it.
   *
   * Twitch drops VODs after a couple of weeks, so for an older scene this is
   * the difference between editing later and losing the footage entirely.
   */
  handle(
    IPC.archiveRange,
    async (req: { source: VodSource; startSeconds: number; endSeconds: number }) => {
      const source = req.source.formatsInspected
        ? req.source
        : {
            ...req.source,
            formats: await sources.inspectFormats(req.source),
            formatsInspected: true
          }
      const streams = selectStreams(source.formats ?? [], settings.current.export.quality)
      const stream = streams.video ?? streams.audio
      if (!stream) {
        throw Errors.qualityUnavailable('any stream', 'nothing downloadable for this POV')
      }

      const dir = join(userData, 'archive')
      await mkdir(dir, { recursive: true })
      const name = `${source.id}-${Math.round(req.startSeconds)}-${Math.round(req.endSeconds)}`
      const window = await fetcher.fetchWindow({
        stream,
        startSeconds: req.startSeconds,
        endSeconds: req.endSeconds,
        destination: join(dir, `${name}.${windowExtension(stream.container)}`),
        onProgress: () => undefined
      })
      const info = await stat(window.file)
      log.info('archive', 'Kept a range locally', { sourceId: source.id, bytes: info.size })
      return { path: window.file, bytes: info.size }
    }
  )


  handle(IPC.streamersSetGroups, (id: string, groupIds: string[]) => streamers.setGroups(id, groupIds))
  handle(IPC.streamersSetFavorite, (id: string, favorite: boolean) => streamers.setFavorite(id, favorite))
  handle(IPC.streamersRestore, (streamer: SavedStreamer) => streamers.restore(streamer))
  handle(IPC.streamersLinkPerson, (idA: string, idB: string) => streamers.linkPerson(idA, idB))
  handle(IPC.streamersUnlinkPerson, (id: string) => streamers.unlinkPerson(id))
  handle(IPC.streamersVodQuality, (urls: string[]) => streamers.probeQuality(urls))
  handle(IPC.streamersRefreshProfile, (id: string, force?: boolean) =>
    streamers.refreshProfile(id, force)
  )
  handle(IPC.streamersRefreshProfiles, () => streamers.refreshStaleProfiles())

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
    return detectEnvironment(true)
  })

  handle(IPC.streamersList, () => streamers.list())
  handle(IPC.streamersAdd, (input: string, platform?: PlatformId) => streamers.add(input, platform))
  handle(IPC.streamersRemove, (id: string) => {
    // Their back catalogue goes with them, rather than lingering as an
    // orphaned shelf nothing can reach.
    vodLibrary.forget(id)
    return streamers.remove(id)
  })
  handle(IPC.streamersVods, async (id: string) => {
    const vods = await streamers.vods(id)
    await streamers.touch(id)
    return vods
  })
  handle(IPC.streamersShelf, (id: string) => {
    // Opening someone's page says what matters now, so it jumps the queue.
    vodCrawler.prioritise(id)
    return vodLibrary.shelf(id)
  })
  handle(IPC.streamersLive, () => streamers.liveNow())
  handle(IPC.streamersLiveCached, () => streamers.liveCached())
  handle(IPC.streamersDiscoverSiblings, (id: string) => streamers.discoverSiblings(id))
  handle(IPC.streamersCompare, (handle: string) =>
    compareAcrossPlatforms(handle, {
      log,
      resolver,
      listChannelVods: (platform, name) =>
        streamers.listChannelVods(platform, name, { priority: 'idle' }),
      resolveSource: (url) => sources.resolve(url)
    })
  )
  handle(IPC.streamersCrawlProgress, () => vodCrawler.progress())
  handle(IPC.streamersCrawlNow, (id: string) => {
    // An explicit refresh also reopens anything the platform previously
    // refused to date — otherwise a channel blocked once stays undated for
    // good, with no way for the person to ask again.
    const reopened = vodLibrary.forgetUnanswered(id)
    if (reopened > 0) log.info('vods', 'Reopened undated broadcasts on request', { id, reopened })
    vodCrawler.prioritise(id)
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

  /*
   * `app.getAppMetrics()` reports each process's CPU as a percentage of one
   * core, so nine decoding renderers legitimately sum past 100. Summed rather
   * than averaged for exactly that reason — "how much of this machine is the
   * wall using" is the question, and the answer can be 400%.
   */
  handle(IPC.appMetrics, () => {
    const processes = app.getAppMetrics().map((m) => ({
      type: m.type,
      cpuPercent: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
      memoryMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024)
    }))
    return {
      cpuPercent: Math.round(processes.reduce((sum, p) => sum + p.cpuPercent, 0) * 10) / 10,
      memoryMB: processes.reduce((sum, p) => sum + p.memoryMB, 0),
      processes
    }
  })
  handle(IPC.cacheClear, async () => {
    await cache.clear()
    await thumbCache.clear()
    await waveCache.clear()
    await previewMedia.clear()
    return cache.stats()
  })
  handle(IPC.diskSpace, (path: string) => diskSpace(path))

  /*
   * Only paths this app produced.
   *
   * `shell.openPath` hands a path to the OS, which on Windows *runs* an .exe,
   * .cmd or .lnk. The renderer used to pass any string straight through, so a
   * renderer compromise was arbitrary program launch with no dialog. Every
   * legitimate caller opens an export, the output folder, the log, or the
   * cache, all of which live under directories this process chose.
   */
  const openableRoots = (): string[] =>
    [
      settings.current.outputDirectory,
      settings.current.cache.directory,
      defaultProjectsDir,
      dirname(log.path),
      tempRoot
    ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)

  const openablePath = (candidate: string): string | null => {
    if (typeof candidate !== 'string' || candidate.length === 0) return null
    const full = resolve(candidate)
    const ok = openableRoots().some((root) => {
      const base = resolve(root)
      return full === base || full.startsWith(base + sep)
    })
    if (!ok) log.warn('security', 'Refused to open a path outside the app’s own folders')
    return ok ? full : null
  }

  handle(IPC.revealPath, (path: string) => {
    const safe = openablePath(path)
    if (safe) shell.showItemInFolder(safe)
  })
  handle(IPC.openPath, async (path: string) => {
    const safe = openablePath(path)
    if (safe) await shell.openPath(safe)
  })

  handle(IPC.queuePaused, () => queue.isPaused())
  handle(IPC.logsPath, () => log.path)
  handle(
    IPC.logEvent,
    (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string, data?: unknown) => {
      // Scope is prefixed rather than trusted as-is, so a renderer line is
      // always distinguishable from a main-process one in the log.
      const where = `ui:${String(scope).slice(0, 24)}`
      const write = level === 'error' ? log.error : level === 'warn' ? log.warn : level === 'debug' ? log.debug : log.info
      write.call(log, where, String(message).slice(0, 500), data)
    }
  )
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
    if (path) toWindow(IPC.evtOpenProject, path)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  /*
   * A throw outside an IPC handler must not take the window with it.
   *
   * Every IPC call is individually wrapped, which covers the request path. It
   * does not cover the queue worker, the live-buffer timers, the VOD crawler
   * or an ffmpeg child's event handlers — and on Node 15+ an unhandled
   * rejection is fatal by default. Today that means the window vanishes
   * mid-export with no message, no log line, and no `will-quit` cleanup, so
   * the job's scratch files leak too.
   *
   * Logged and survived instead. A background failure that leaves the app
   * usable is worth a log entry; it is not worth throwing away an unsaved
   * project and a running export.
   */
  process.on('uncaughtException', (err) => {
    log.error('app', 'Uncaught exception in the main process', err)
  })
  process.on('unhandledRejection', (reason) => {
    log.error('app', 'Unhandled promise rejection in the main process', reason)
  })
  app.on('render-process-gone', (_event, _contents, details) => {
    log.error('app', 'The window process died', { reason: details.reason, exitCode: details.exitCode })
  })
  app.on('child-process-gone', (_event, details) => {
    // ffmpeg and yt-dlp live here. A crash is not fatal to the app, but a
    // silent one is the difference between a diagnosable bug and a mystery.
    if (details.reason !== 'clean-exit') {
      log.warn('app', 'A helper process died', { type: details.type, reason: details.reason })
    }
  })

  app.whenReady().then(async () => {
    await mkdir(stateDir, { recursive: true })
    await mkdir(tempRoot, { recursive: true })
    await projects.cleanupTemp()

    // Started in every mode: the preview player needs the media proxy even
    // when Vite is serving the renderer.
    localServer = await startLocalServer(
      app.isPackaged || !process.env.ELECTRON_RENDERER_URL
        ? join(__dirname_, '../renderer')
        : null,
      log
    )

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
    await detectEnvironment(true)

    registerIpc()
    await createWindow()
    createTray()

    // After the window exists, so the user can see it happening.
    void autoInstallMissing().catch((err) => log.error('deps', 'Automatic setup failed', err))
    // The library is read from disk before the crawl starts, so a session
    // that has already learned a channel's history does not re-learn it.
    void vodLibrary
      .load()
      .then(() => recoverStreamersFromLibrary())
      .then(() => vodCrawler.start())
      .catch((err) => log.error('vods', 'Could not start the VOD crawl', err))
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

  /**
   * Shutdown, in an order that matters, awaited.
   *
   * This used to be two synchronous listeners that started asynchronous work
   * and did not wait for it — `void rm(…)`, `void vodLibrary.flush()` — which
   * on a fast exit is the same as not doing it. Three things went wrong as a
   * result:
   *
   * - **Exports outlived the app.** A running job's ffmpeg is a spawned child,
   *   and on Windows a child is not killed when its parent exits. It carried
   *   on encoding into a scratch directory the app was deleting at that exact
   *   moment, and left a half-written file in the person's output folder that
   *   nothing ever marked as failed. The abort path is also where the exporter
   *   deletes its partial output and work directory, and none of that can run
   *   after the process is gone.
   * - **The crawl's work was thrown away.** `flush()` writes what the VOD
   *   crawl learned this session; unawaited, it lost the race with exit. That
   *   is minutes of channel listings to re-learn.
   * - **Scratch space leaked**, for the same reason.
   *
   * So: stop taking on new work, abort what is in flight and wait for it to
   * unwind, flush state, then sweep. Every step is bounded — a shutdown that
   * hangs is worse than one that leaves a temp file — and `finally` guarantees
   * the second `app.quit()` regardless of what failed.
   */
  let shuttingDown = false

  async function shutdown(): Promise<void> {
    log.info('app', 'Shutting down')
    // Live buffers hold media in memory and a poll timer each. Nothing about
    // them should outlive the window.
    live.stopAll()
    // Whatever the crawl learned since its last settle would otherwise be
    // thrown away, and it is expensive to learn again.
    vodCrawler.stop()

    // Exports first: this is the one that owns child processes.
    await queue.stopAll().catch((err) => log.warn('app', 'Exports did not stop cleanly', err))
    await vodLibrary.flush().catch((err) => log.warn('app', 'Could not flush the VOD library', err))
    await localServer?.close().catch(() => undefined)

    // Job scratch and preview work only; cached segments are deliberately kept.
    await Promise.allSettled([
      rm(join(tempRoot, 'jobs'), { recursive: true, force: true }),
      rm(join(tempRoot, 'previews'), { recursive: true, force: true }),
      rm(join(tempRoot, 'previews-work'), { recursive: true, force: true })
    ])
  }

  /*
   * `will-quit`, not `before-quit` — the difference is the whole point.
   *
   * Electron emits `before-quit` *before* it starts closing windows, and the
   * window's own `close` handler is what asks the renderer whether there is
   * unsaved work. Doing the teardown there meant every irreversible step ran
   * before the person had been asked anything: the export they were told they
   * could keep was already aborted and its part-written file already deleted
   * when the dialog finally appeared, saying it was about to do exactly that.
   *
   * And answering "Cancel" then left the app running but gutted — the queue's
   * `stopping` flag is one-way, the crawler is never restarted, the local
   * server the renderer is *served from* was closed, and the log stream was
   * shut. None of it recovers without a restart.
   *
   * `will-quit` fires only once every window has actually closed, which is
   * after the veto point, so by the time this runs quitting is settled.
   */
  app.on('will-quit', (event) => {
    if (shuttingDown) return
    shuttingDown = true
    event.preventDefault()
    void shutdown()
      .catch((err) => log.error('app', 'Shutdown failed', err))
      .finally(() => {
        log.close()
        app.quit()
      })
  })
}
