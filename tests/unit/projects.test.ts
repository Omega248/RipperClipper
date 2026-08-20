import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, normalizeProject, parseProject } from '../../src/main/services/projects.js'
import { Logger } from '../../src/main/services/logger.js'
import { addClip, makeMarker } from '../../src/shared/clips.js'
import type { ProjectFile, VodSource } from '../../src/shared/types.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'

let dir: string
let store: ProjectStore
let log: Logger

const SOURCE: VodSource = {
  id: 'twitch:1',
  platform: 'twitch',
  vodId: '1',
  url: 'https://www.twitch.tv/videos/1',
  title: 'Test VOD',
  creator: 'Streamer',
  durationSeconds: 3600,
  playbackKind: 'hls',
  capabilities: {
    metadata: true,
    playback: true,
    rangeDownload: true,
    requiresAuth: false,
    notes: []
  },
  formatsInspected: false
}

function projectWithClips(): ProjectFile {
  const base = store.createProject('My Stream Highlights')
  let clips = addClip(
    [],
    { name: 'Funny Death', sourceId: SOURCE.id, startSeconds: 750, endSeconds: 910 },
    3600
  )
  clips = addClip(
    clips,
    { name: 'Insane Fight', sourceId: SOURCE.id, startSeconds: 1200, endSeconds: 1400 },
    3600
  )
  return {
    ...base,
    sources: [SOURCE],
    clips,
    markers: [makeMarker({ sourceId: SOURCE.id, timeSeconds: 742.42, label: 'Funny' })]
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cookieclip-proj-'))
  log = new Logger(join(dir, 'logs'))
  store = new ProjectStore(log, dir)
})

afterEach(async () => {
  log.close()
  await rm(dir, { recursive: true, force: true })
})

describe('save and load', () => {
  it('round-trips clips, markers and ordering', async () => {
    const project = projectWithClips()
    const path = join(dir, 'test.cookieclip')
    await store.save(project, path)

    const loaded = await store.open(path)
    expect(loaded.name).toBe('My Stream Highlights')
    expect(loaded.clips.map((c) => c.name)).toEqual(['Funny Death', 'Insane Fight'])
    expect(loaded.clips[0].startSeconds).toBe(750)
    expect(loaded.clips[0].durationSeconds).toBe(160)
    expect(loaded.markers[0].timeSeconds).toBe(742.42)
    expect(loaded.sources[0].url).toBe(SOURCE.url)
  })

  it('does not embed the source media', async () => {
    const path = join(dir, 'small.cookieclip')
    await store.save(projectWithClips(), path)
    const raw = await readFile(path, 'utf8')
    expect(raw.length).toBeLessThan(8000)
  })

  it('writes atomically, leaving no temp file behind', async () => {
    const path = join(dir, 'atomic.cookieclip')
    await store.save(projectWithClips(), path)
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('remembers recent projects and drops missing ones', async () => {
    const path = join(dir, 'recent.cookieclip')
    await store.save(projectWithClips(), path)
    expect(await store.recent()).toContain(path)
    await rm(path)
    expect(await store.recent()).not.toContain(path)
  })
})

describe('autosave and recovery', () => {
  it('reports no recovery on a clean install', async () => {
    expect(await store.recoveryInfo()).toMatchObject({ available: false })
  })

  it('offers the autosave after a simulated crash', async () => {
    const project = projectWithClips()
    await store.autosave(project)

    const info = await store.recoveryInfo()
    expect(info.available).toBe(true)
    expect(info.projectName).toBe('My Stream Highlights')

    const recovered = await store.loadRecovery()
    expect(recovered.clips).toHaveLength(2)
  })

  it('never overwrites the user file when autosaving', async () => {
    const path = join(dir, 'user.cookieclip')
    const project = projectWithClips()
    await store.save(project, path)
    const before = await readFile(path, 'utf8')

    await store.autosave({ ...project, name: 'Changed after save' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('discards the recovery copy on request', async () => {
    await store.autosave(projectWithClips())
    await store.discardRecovery()
    expect((await store.recoveryInfo()).available).toBe(false)
  })
})

describe('rolling backup history', () => {
  it('keeps no history until a project has been saved twice', async () => {
    const path = join(dir, 'once.cookieclip')
    await store.save(projectWithClips(), path)
    expect(await store.listBackups(path)).toEqual([])
  })

  it('snapshots the previous version on every subsequent save', async () => {
    const path = join(dir, 'history.cookieclip')
    await store.save({ ...projectWithClips(), name: 'v1' }, path)
    await store.save({ ...projectWithClips(), name: 'v2' }, path)
    await store.save({ ...projectWithClips(), name: 'v3' }, path)

    const backups = await store.listBackups(path)
    expect(backups).toHaveLength(2)

    const names = await Promise.all(backups.map((b) => store.restoreBackup(b.path).then((p) => p.name)))
    expect(new Set(names)).toEqual(new Set(['v1', 'v2']))
  })

  it('restoring a backup does not touch the live file or the recent-projects list', async () => {
    const path = join(dir, 'untouched.cookieclip')
    await store.save({ ...projectWithClips(), name: 'v1' }, path)
    await store.save({ ...projectWithClips(), name: 'v2' }, path)

    const before = await readFile(path, 'utf8')
    const backups = await store.listBackups(path)
    await store.restoreBackup(backups[0].path)

    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await store.recent()).not.toContain(backups[0].path)
  })

  it('caps history at 10 versions, dropping the oldest first', async () => {
    const path = join(dir, 'capped.cookieclip')
    for (let i = 0; i < 13; i++) {
      await store.save({ ...projectWithClips(), name: `v${i}` }, path)
    }
    const backups = await store.listBackups(path)
    expect(backups).toHaveLength(10)

    const names = await Promise.all(backups.map((b) => store.restoreBackup(b.path).then((p) => p.name)))
    // v0, v1 and v2 aged out; v3..v11 (the 10 saves before the final, unbacked-up v12) survive.
    expect(names).not.toContain('v0')
    expect(names).not.toContain('v1')
    expect(names).toContain('v11')
  })
})

describe('corruption handling', () => {
  it('raises an actionable error for unparseable files', async () => {
    const path = join(dir, 'broken.cookieclip')
    await writeFile(path, '{ this is not json', 'utf8')
    await expect(store.open(path)).rejects.toThrowError(/not a readable Ripper Clipper project/)
  })

  it('rejects structurally invalid documents', () => {
    expect(() => parseProject('{"name":"x"}', 'x.cookieclip')).toThrow()
  })

  it('drops clips whose timestamps are impossible instead of failing the whole project', () => {
    const normalized = normalizeProject(
      {
        sources: [SOURCE],
        clips: [
          { id: 'a', name: 'good', sourceId: SOURCE.id, startSeconds: 0, endSeconds: 10, order: 0 },
          { id: 'b', name: 'bad', sourceId: SOURCE.id, startSeconds: 20, endSeconds: 10, order: 1 },
          { id: 'c', name: 'worse', sourceId: SOURCE.id, startSeconds: 'x', endSeconds: 10, order: 2 }
        ],
        markers: []
      },
      'x.cookieclip'
    )
    expect(normalized.clips.map((c) => c.name)).toEqual(['good'])
  })

  it('resets transient statuses so an interrupted job is not shown as running', () => {
    const normalized = normalizeProject(
      {
        sources: [SOURCE],
        clips: [
          {
            id: 'a',
            name: 'was downloading',
            sourceId: SOURCE.id,
            startSeconds: 0,
            endSeconds: 10,
            order: 0,
            status: 'downloading'
          },
          {
            id: 'b',
            name: 'finished',
            sourceId: SOURCE.id,
            startSeconds: 10,
            endSeconds: 20,
            order: 1,
            status: 'complete'
          }
        ],
        markers: []
      },
      'x.cookieclip'
    )
    expect(normalized.clips[0].status).toBe('idle')
    expect(normalized.clips[1].status).toBe('complete')
  })

  it('supports clips from more than one VOD in a single project', () => {
    const other: VodSource = { ...SOURCE, id: 'youtube:abc', platform: 'youtube', vodId: 'abc' }
    const normalized = normalizeProject(
      {
        sources: [SOURCE, other],
        clips: [
          { id: 'a', name: 'A', sourceId: SOURCE.id, startSeconds: 0, endSeconds: 10, order: 0 },
          { id: 'b', name: 'B', sourceId: other.id, startSeconds: 0, endSeconds: 10, order: 1 }
        ],
        markers: []
      },
      'x.cookieclip'
    )
    expect(normalized.sources).toHaveLength(2)
    expect(new Set(normalized.clips.map((c) => c.sourceId)).size).toBe(2)
  })
})

describe('clip POV mappings survive a save and reopen', () => {
  it('reloads every mapping, and rebuilds them from the event timeline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vodclip-povmap-'))
    try {
      const now = new Date().toISOString()
      const sources = [
        {
          id: 'A',
          platform: 'twitch' as const,
          vodId: 'A',
          url: 'https://example.invalid/A',
          title: 'A',
          creator: 'A',
          durationSeconds: 7200,
          createdAt: '2026-08-17T20:00:00Z',
          playbackKind: 'progressive' as const,
          capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
          formatsInspected: false,
          syncMapping: {
            vodId: 'A',
            vodStartRealTime: Date.parse('2026-08-17T20:00:00Z') / 1000,
            offsetSeconds: 0,
            driftRate: 0,
            confidence: 0.95,
            method: 'platform_metadata' as const,
            anchorIds: [],
            lastValidatedAt: null,
            warnings: []
          }
        },
        {
          id: 'B',
          platform: 'kick' as const,
          vodId: 'B',
          url: 'https://example.invalid/B',
          title: 'B',
          creator: 'B',
          durationSeconds: 7200,
          createdAt: '2026-08-17T20:00:30Z',
          playbackKind: 'progressive' as const,
          capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
          formatsInspected: false,
          syncMapping: {
            vodId: 'B',
            vodStartRealTime: Date.parse('2026-08-17T20:00:30Z') / 1000,
            offsetSeconds: 0,
            driftRate: 0,
            confidence: 0.95,
            method: 'platform_metadata' as const,
            anchorIds: [],
            lastValidatedAt: null,
            warnings: []
          }
        }
      ]

      const project = {
        schemaVersion: 3 as const,
        id: 'p',
        name: 'Event',
        createdAt: now,
        updatedAt: now,
        sources,
        clips: [
          {
            id: 'clip_1',
            name: 'MRPD Shootout',
            sourceId: 'A',
            startSeconds: 600,
            endSeconds: 720,
            durationSeconds: 120,
            order: 0,
            status: 'idle' as const,
            eventStartTime: Date.parse('2026-08-17T20:10:00Z') / 1000,
            eventEndTime: Date.parse('2026-08-17T20:12:00Z') / 1000
          }
        ],
        markers: [],
        syncAnchors: [],
        exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
        outputDirectory: null
      }

      const file = join(dir, 'event.cookieclip')
      await writeFile(file, JSON.stringify(project), 'utf8')
      const reopened = parseProject(await readFile(file, 'utf8'), file)

      const mappings = reopened.clips[0].povMappings!
      expect(mappings).toHaveLength(2)
      const b = mappings.find((m) => m.sourceId === 'B')!
      expect(b.status).toBe('available')
      expect(b.vodStartSeconds).toBeCloseTo(570, 3)
      expect(reopened.clips[0].eventStartTime).toBe(project.clips[0].eventStartTime)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
