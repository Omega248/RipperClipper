import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc.js'
import type {
  InstallProgress,
  LiveSnapshot,
  RendererApi,
  ToastEvent,
  ToolId,
  UpdateStatus,
  VodCrawlProgress
} from '../shared/ipc.js'
import type { ExportJob, SerializedAppError } from '../shared/types.js'

/**
 * The only surface the renderer can reach. No filesystem, child-process or
 * network primitives are exposed — every capability is an explicit, typed call.
 */

/** Unwrap the structured error envelope thrown by the main process. */
function unwrap(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  const jsonStart = message.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as SerializedAppError
      if (parsed && typeof parsed.title === 'string') {
        const wrapped = new Error(parsed.message)
        Object.assign(wrapped, parsed)
        throw wrapped
      }
    } catch (parseErr) {
      if (parseErr instanceof Error && 'title' in parseErr) throw parseErr
    }
  }
  throw new Error(message)
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    return unwrap(err)
  }
}

const api: RendererApi = {
  env: () => invoke(IPC.envInfo),
  refreshEnv: () => invoke(IPC.envRefresh),

  getSettings: () => invoke(IPC.settingsGet),
  updateSettings: (patch) => invoke(IPC.settingsUpdate, patch),
  pickOutputDirectory: () => invoke(IPC.settingsPickOutputDir),
  pickFile: (kind) => invoke(IPC.settingsPickFile, kind),

  resolveSource: (url, event) => invoke(IPC.sourceResolve, url, event),
  inspectFormats: (source) => invoke(IPC.sourceInspectFormats, source),
  liveStatus: (source) => invoke(IPC.sourceLiveStatus, source),

  newProject: (name) => invoke(IPC.projectNew, name),
  saveProject: (project, path) => invoke(IPC.projectSave, project, path),
  saveProjectAs: (project) => invoke(IPC.projectSaveAs, project),
  openProject: () => invoke(IPC.projectOpen),
  openProjectPath: (path) => invoke(IPC.projectOpenPath, path),
  autosave: (project) => invoke(IPC.projectAutosave, project),
  checkRecovery: () => invoke(IPC.projectRecoveryCheck),
  discardRecovery: () => invoke(IPC.projectRecoveryDiscard),
  recentProjects: () => invoke(IPC.projectRecent),
  startupProjectPath: () => invoke(IPC.projectStartupPath),
  listBackups: (path) => invoke(IPC.projectBackupList, path),
  restoreBackup: (path) => invoke(IPC.projectBackupRestore, path),

  liveWatch: (source) => invoke(IPC.liveWatch, source),
  liveUnwatch: (sourceId) => invoke(IPC.liveUnwatch, sourceId),
  liveStates: () => invoke(IPC.liveStates),
  liveCovers: (req) => invoke(IPC.liveCovers, req),
  liveSetWindow: (seconds) => invoke(IPC.liveWindow, seconds),

  audioPeaks: (req) => invoke(IPC.audioPeaks, req),
  sceneChanges: (req) => invoke(IPC.sceneChanges, req),
  filmstrip: (req) => invoke(IPC.filmstrip, req),
  importWatermarkImage: () => invoke(IPC.watermarkImport),
  addWatermarkPng: (dataUrl, name) => invoke(IPC.watermarkAddPng, dataUrl, name),
  listWatermarkImages: () => invoke(IPC.watermarkList),
  removeWatermarkImage: (id: string) => invoke(IPC.watermarkRemove, id),

  toolStatus: () => invoke(IPC.depsStatus),
  installTools: (ids: ToolId[]) => invoke(IPC.depsInstall, ids),
  cancelToolInstall: () => invoke(IPC.depsCancel),
  onToolProgress: (cb: (progress: InstallProgress) => void) => {
    const listener = (_e: unknown, progress: InstallProgress): void => cb(progress)
    ipcRenderer.on(IPC.evtDeps, listener)
    return () => ipcRenderer.removeListener(IPC.evtDeps, listener)
  },

  previewMedia: (req) => invoke(IPC.previewMedia, req),

  listEditors: () => invoke(IPC.editorsList),
  validateEditingProject: (project, editor) => invoke(IPC.editingProjectValidate, project, editor),
  exportEditingProject: (req) => invoke(IPC.editingProjectExport, req),
  chooseEditingProjectFolder: () => invoke(IPC.editingProjectChooseFolder),
  listStreamers: () => invoke(IPC.streamersList),
  addStreamer: (input, platform) => invoke(IPC.streamersAdd, input, platform),
  removeStreamer: (id) => invoke(IPC.streamersRemove, id),
  streamerVods: (id) => invoke(IPC.streamersVods, id),
  streamerShelf: (id) => invoke(IPC.streamersShelf, id),
  streamersLive: () => invoke(IPC.streamersLive),
  streamersLiveCached: () => invoke(IPC.streamersLiveCached),
  compareStreamerPlatforms: (handle) => invoke(IPC.streamersCompare, handle),
  discoverStreamerSiblings: (id) => invoke(IPC.streamersDiscoverSiblings, id),
  vodCrawlProgress: () => invoke(IPC.streamersCrawlProgress),
  refreshStreamerVods: (id) => invoke(IPC.streamersCrawlNow, id),
  onVodCrawl: (listener) => {
    const handler = (_e: unknown, progress: VodCrawlProgress): void => listener(progress)
    ipcRenderer.on(IPC.evtVodCrawl, handler)
    return () => ipcRenderer.removeListener(IPC.evtVodCrawl, handler)
  },
  setStreamerWatermark: (id, watermark) => invoke(IPC.streamersWatermark, id, watermark),
  streamersCoveringEvent: (req) => invoke(IPC.streamersOverlap, req),
  packageExport: (req) => invoke(IPC.packageExport, req),
  packageImport: () => invoke(IPC.packageImport),
  resolveMoment: (url) => invoke(IPC.resolveMoment, url),
  archiveRange: (req) => invoke(IPC.archiveRange, req),
  discoverEvent: (req) => invoke(IPC.discoverEvent, req),
  setStreamerGroups: (id, groupIds) => invoke(IPC.streamersSetGroups, id, groupIds),
  setStreamerFavorite: (id, favorite) => invoke(IPC.streamersSetFavorite, id, favorite),
  restoreStreamer: (streamer) => invoke(IPC.streamersRestore, streamer),
  linkStreamerPerson: (idA, idB) => invoke(IPC.streamersLinkPerson, idA, idB),
  unlinkStreamerPerson: (id) => invoke(IPC.streamersUnlinkPerson, id),
  streamerVodQuality: (urls) => invoke(IPC.streamersVodQuality, urls),
  refreshStreamerProfile: (id, force) => invoke(IPC.streamersRefreshProfile, id, force),
  refreshStreamerProfiles: () => invoke(IPC.streamersRefreshProfiles),

  listStreamerGroups: () => invoke(IPC.streamerGroupsList),
  createStreamerGroup: (name, icon, color) => invoke(IPC.streamerGroupsCreate, name, icon, color),
  updateStreamerGroup: (id, patch) => invoke(IPC.streamerGroupsUpdate, id, patch),
  deleteStreamerGroup: (id) => invoke(IPC.streamerGroupsDelete, id),

  enqueueExports: (req) => invoke(IPC.exportEnqueue, req),
  enqueueCombined: (req) => invoke(IPC.exportCombine, req),
  exportTimeline: (req) => invoke(IPC.exportTimeline, req),
  cancelJob: (jobId) => invoke(IPC.exportCancel, jobId),
  pauseQueue: () => invoke(IPC.exportPause),
  resumeQueue: () => invoke(IPC.exportResume),
  retryJob: (jobId) => invoke(IPC.exportRetry, jobId),
  retryAllFailed: () => invoke(IPC.exportRetryAllFailed),
  clearFinished: () => invoke(IPC.exportClearFinished),
  reorderJob: (jobId, toIndex) => invoke(IPC.exportReorder, jobId, toIndex),
  listJobs: () => invoke(IPC.exportList),
  exportClipListCsv: (csv, suggestedName) => invoke(IPC.exportClipListCsv, csv, suggestedName),

  cacheStats: () => invoke(IPC.cacheStats),
  appMetrics: () => invoke(IPC.appMetrics),
  clearCache: () => invoke(IPC.cacheClear),
  diskSpace: (path) => invoke(IPC.diskSpace, path),

  revealPath: (path) => invoke(IPC.revealPath, path),
  openPath: (path) => invoke(IPC.openPath, path),

  queuePaused: () => invoke(IPC.queuePaused),
  logsPath: () => invoke(IPC.logsPath),
  logEvent: (level, scope, message, data) => invoke(IPC.logEvent, level, scope, message, data),
  tailLogs: (lines) => invoke(IPC.logsTail, lines),

  checkForUpdates: () => invoke(IPC.updateCheck),
  downloadUpdate: () => invoke(IPC.updateDownload),
  installUpdate: () => invoke(IPC.updateInstall),

  minimizeWindow: () => invoke(IPC.windowMinimize),
  toggleMaximizeWindow: () => invoke(IPC.windowToggleMaximize),
  closeWindow: () => invoke(IPC.windowClose),
  isWindowMaximized: () => invoke(IPC.windowIsMaximized),
  confirmClose: () => invoke(IPC.windowConfirmClose),

  onLive: (cb: (snapshot: LiveSnapshot) => void) => {
    const listener = (_e: unknown, snapshot: LiveSnapshot): void => cb(snapshot)
    ipcRenderer.on(IPC.evtLive, listener)
    return () => ipcRenderer.removeListener(IPC.evtLive, listener)
  },
  onJobs: (cb: (jobs: ExportJob[]) => void) => {
    const listener = (_e: unknown, jobs: ExportJob[]): void => cb(jobs)
    ipcRenderer.on(IPC.evtJobs, listener)
    return () => ipcRenderer.removeListener(IPC.evtJobs, listener)
  },
  onToast: (cb: (toast: ToastEvent) => void) => {
    const listener = (_e: unknown, toast: ToastEvent): void => cb(toast)
    ipcRenderer.on(IPC.evtToast, listener)
    return () => ipcRenderer.removeListener(IPC.evtToast, listener)
  },
  onOpenProject: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on(IPC.evtOpenProject, listener)
    return () => ipcRenderer.removeListener(IPC.evtOpenProject, listener)
  },
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on(IPC.evtWindowMaximized, listener)
    return () => ipcRenderer.removeListener(IPC.evtWindowMaximized, listener)
  },
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => {
    const listener = (_e: unknown, status: UpdateStatus): void => cb(status)
    ipcRenderer.on(IPC.evtUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.evtUpdate, listener)
  },
  onBeforeClose: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.evtBeforeClose, listener)
    return () => ipcRenderer.removeListener(IPC.evtBeforeClose, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
