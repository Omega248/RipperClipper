import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * electron-updater's `autoUpdater` is a singleton that expects to run inside
 * a real Electron main process — it isn't something a plain vitest run can
 * construct. UpdateService only ever calls a handful of methods on it and
 * forwards its events, so a minimal EventEmitter stand-in exercises the
 * class's own logic (channel gating, state transitions, guard conditions)
 * without needing the real update machinery.
 */
const fakeAutoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  checkForUpdates: vi.fn(async () => undefined),
  downloadUpdate: vi.fn(async () => undefined),
  quitAndInstall: vi.fn()
})

vi.mock('electron-updater', () => ({ autoUpdater: fakeAutoUpdater }))

const { UpdateService } = await import('../../src/main/services/updater.js')
const { Logger } = await import('../../src/main/services/logger.js')

let dir: string
let log: InstanceType<typeof Logger>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cookieclip-updater-'))
  log = new Logger(join(dir, 'logs'))
  fakeAutoUpdater.checkForUpdates.mockClear()
  fakeAutoUpdater.downloadUpdate.mockClear()
  fakeAutoUpdater.quitAndInstall.mockClear()
  fakeAutoUpdater.removeAllListeners()
})

afterEach(async () => {
  log.close()
  await rm(dir, { recursive: true, force: true })
})

describe('channel gating', () => {
  it('never hits the real feed outside the stable channel', async () => {
    const updater = new UpdateService(log, 'dev')
    const status = await updater.check()
    expect(status).toEqual({ state: 'unsupported' })
    expect(fakeAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks the real feed on the stable channel', async () => {
    const updater = new UpdateService(log, 'stable')
    await updater.check()
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })
})

describe('status transitions', () => {
  it('turns library events into typed status and forwards them', async () => {
    const updater = new UpdateService(log, 'stable')
    const seen: unknown[] = []
    updater.on('status', (s) => seen.push(s))

    fakeAutoUpdater.emit('checking-for-update')
    fakeAutoUpdater.emit('update-available', { version: '1.2.3' })
    expect(updater.current()).toEqual({ state: 'available', version: '1.2.3' })
    expect(seen).toEqual([{ state: 'checking' }, { state: 'available', version: '1.2.3' }])
  })

  it('rounds download progress to a whole percent', () => {
    const updater = new UpdateService(log, 'stable')
    fakeAutoUpdater.emit('download-progress', { percent: 42.7 })
    expect(updater.current()).toEqual({ state: 'downloading', percent: 43 })
  })

  it('turns a library error into a typed error status instead of throwing', () => {
    const updater = new UpdateService(log, 'stable')
    expect(() => fakeAutoUpdater.emit('error', new Error('feed unreachable'))).not.toThrow()
    expect(updater.current()).toEqual({ state: 'error', message: 'feed unreachable' })
  })
})

describe('guarded actions', () => {
  it('refuses to download before an update is known to be available', async () => {
    const updater = new UpdateService(log, 'stable')
    await updater.download()
    expect(fakeAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('downloads once an update is available', async () => {
    const updater = new UpdateService(log, 'stable')
    fakeAutoUpdater.emit('update-available', { version: '1.2.3' })
    await updater.download()
    expect(fakeAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('refuses to install before a download has finished', () => {
    const updater = new UpdateService(log, 'stable')
    updater.install()
    expect(fakeAutoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('installs once a download has finished', () => {
    const updater = new UpdateService(log, 'stable')
    fakeAutoUpdater.emit('update-downloaded', { version: '1.2.3' })
    updater.install()
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })
})
