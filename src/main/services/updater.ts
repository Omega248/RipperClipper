import { EventEmitter } from 'node:events'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../../shared/ipc.js'
import type { Logger } from './logger.js'

/**
 * The GitHub-releases update feed. Only the `stable` channel is ever
 * published (see electron-builder.js's `publish` block and the release
 * process) — experimental and dev builds are packaged locally only, so a
 * check on those channels is short-circuited to `unsupported` rather than
 * hitting an endpoint that has nothing for them, or worse, offering a
 * cross-channel "update" that installs the wrong app identity.
 *
 * Downloads are never automatic: `checkForUpdates` only reports whether one
 * exists, `download` must be called separately once the user has seen that
 * and opted in, and `install` (quitAndInstall) only ever runs on an explicit
 * call — never as a side effect of a failed check or a stray event, since
 * that is exactly the kind of thing that leaves an installer half-applied.
 */
export class UpdateService extends EventEmitter {
  private status: UpdateStatus = { state: 'idle' }

  constructor(
    private readonly log: Logger,
    private readonly channel: 'stable' | 'experimental' | 'dev'
  ) {
    super()
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => this.set({ state: 'available', version: info.version }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'not-available' }))
    autoUpdater.on('download-progress', (p) =>
      this.set({ state: 'downloading', percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'downloaded', version: info.version }))
    autoUpdater.on('error', (err) => {
      this.log.error('updater', 'Update check failed', err)
      this.set({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }

  private set(status: UpdateStatus): void {
    this.status = status
    this.emit('status', status)
  }

  current(): UpdateStatus {
    return this.status
  }

  async check(): Promise<UpdateStatus> {
    if (this.channel !== 'stable') {
      this.set({ state: 'unsupported' })
      return this.status
    }
    // Any failure here already reached us through the 'error' listener above.
    await autoUpdater.checkForUpdates().catch(() => undefined)
    return this.status
  }

  async download(): Promise<void> {
    if (this.status.state !== 'available') return
    await autoUpdater.downloadUpdate().catch(() => undefined)
  }

  install(): void {
    if (this.status.state !== 'downloaded') return
    autoUpdater.quitAndInstall()
  }
}
