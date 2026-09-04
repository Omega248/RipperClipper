import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { ProjectStore, PROJECT_EXTENSION } from '../../src/main/services/projects.js'
import type { ProjectFile } from '../../src/shared/types.js'
import { defaultSettings, mergeSettings } from '../../src/shared/defaults.js'

/**
 * Where a project is allowed to land.
 *
 * `IPC.projectSave` takes an optional destination so the second and later
 * saves of an open project do not re-ask, and it used to take any string at
 * all. `ProjectStore.save` spreads the project object it is given, so the
 * renderer controlled both the bytes and the path: arbitrary file write.
 *
 * The reason it is a blocker rather than a nuisance is the second half, which
 * the test below demonstrates rather than describes — it reopens the hole the
 * 1.5.0 audit closed, by a door that audit did not cover.
 */

let dir: string
let log: Logger
let store: ProjectStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-save-'))
  log = new Logger(join(dir, 'logs'))
  store = new ProjectStore(log, join(dir, 'state'))
})
afterEach(async () => {
  await log.close()
  await rm(dir, { recursive: true, force: true })
})

const project = (extra: Record<string, unknown> = {}): ProjectFile =>
  ({
    id: 'p1',
    name: 'Bank job',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    sources: [],
    clips: [],
    ...extra
  }) as unknown as ProjectFile

describe('the destination of a project save', () => {
  it('writes a project where a project belongs', async () => {
    const target = join(dir, `Bank job.${PROJECT_EXTENSION}`)
    const saved = await store.save(project(), target)
    expect(saved.name).toBe('Bank job')
    expect(JSON.parse(await readFile(target, 'utf8')).name).toBe('Bank job')
  })

  it('refuses a destination that is not named like a project', async () => {
    await expect(store.save(project(), join(dir, 'settings.json'))).rejects.toThrow()
    await expect(store.save(project(), join(dir, 'evil.exe'))).rejects.toThrow()
    await expect(store.save(project(), join(dir, 'no-extension'))).rejects.toThrow()
  })

  it('leaves an existing file untouched when it refuses', async () => {
    const settings = join(dir, 'settings.json')
    await writeFile(settings, '{"advanced":{"ffmpegPath":null}}', 'utf8')
    await expect(store.save(project(), settings)).rejects.toThrow()
    expect(JSON.parse(await readFile(settings, 'utf8')).advanced.ffmpegPath).toBeNull()
  })

  it('is what stands between a renderer and an executable of its choosing', async () => {
    /*
     * The attack this guard exists for, spelled out.
     *
     * `save` spreads the object it is handed, so extra keys survive into the
     * written file. Written over settings.json, `mergeSettings` then reads
     * `advanced.ffmpegPath` straight back out on the next launch — and that
     * path is spawned by the next export. `keepToolPaths` guards the settings
     * IPC channel, so it never sees this.
     */
    const planted = project({ advanced: { ffmpegPath: 'C:/evil.exe' } })
    const settings = join(dir, 'settings.json')

    await expect(store.save(planted, settings)).rejects.toThrow()

    // And the proof that it would have mattered: had those bytes landed,
    // this is what the next launch would have loaded.
    const base = defaultSettings({ outputDirectory: dir, cacheDirectory: dir })
    const wouldHaveLoaded = mergeSettings(base, {
      ...planted,
      advanced: { ffmpegPath: 'C:/evil.exe' }
    })
    expect(wouldHaveLoaded.advanced.ffmpegPath).toBe('C:/evil.exe')
  })
})
