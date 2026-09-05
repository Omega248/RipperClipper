import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildPackage, readPackage } from '../../src/shared/packaging.js'
import { normalizeProject } from '../../src/main/services/projects.js'
import type { ProjectFile } from '../../src/shared/types.js'

/**
 * Packages have to be openable, and validated on the way in.
 *
 * Both halves went wrong at once. `packageExport` was moved to the Project
 * menu when the Event page was removed, and the import beside it was not — so
 * `readPackage`, its IPC handler and its preload binding all existed, were
 * tested, and were reachable from nothing. The app could write a `.ripperpack`
 * it could never open again.
 *
 * And the import path skipped `normalizeProject`, which every `.cookieclip`
 * goes through. A package is the less trustworthy of the two — it arrives from
 * somebody else's machine — so it was the one entry point with no checks on
 * its contents.
 */

const src = (path: string): string => readFileSync(resolve(__dirname, '../../src', path), 'utf8')

describe('opening a package is reachable', () => {
  const app = src('renderer/src/App.tsx')

  it('calls the packageImport bridge', () => {
    expect(app).toContain('window.api.packageImport(')
  })

  it('offers it as a menu entry, not only as a handler', () => {
    expect(app).toMatch(/Open package/)
  })

  it('still offers the export it is the counterpart to', () => {
    expect(app).toContain('window.api.packageExport(')
    expect(app).toMatch(/Export package/)
  })
})

describe('an imported package is validated like a project file', () => {
  it('normalises the package project in the import handler', () => {
    // The check that actually matters is the behavioural one below; this one
    // pins the wiring, because the validation is only reachable if the
    // handler calls it.
    const main = src('main/index.ts')
    const handler = /IPC\.packageImport[\s\S]*?\n  \}\)/.exec(main)?.[0]
    expect(handler, 'could not find the packageImport handler').toBeDefined()
    expect(handler).toContain('readPackage')
    expect(handler).toContain('normalizeProject')
  })

  it('drops contents that cannot work and keeps the rest', () => {
    const project: ProjectFile = {
      schemaVersion: 5,
      id: 'proj-1',
      name: 'Bank job',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sources: [
        { id: 'v1', platform: 'twitch', url: 'https://twitch.tv/videos/1' }
      ] as ProjectFile['sources'],
      clips: [
        {
          id: 'c1',
          name: 'good clip',
          sourceId: 'v1',
          startSeconds: 10,
          endSeconds: 20
        }
      ] as ProjectFile['clips'],
      markers: [],
      syncAnchors: [],
      exportSettings: {} as ProjectFile['exportSettings'],
      outputDirectory: null
    }

    const pkg = buildPackage(project, { appVersion: 'test' })

    // What a hostile or corrupt package carries: a clip whose times are not
    // numbers, one that ends before it starts, a POV that is not an object.
    const hostile = JSON.parse(JSON.stringify(pkg))
    hostile.project.clips.push({
      id: 'c2',
      name: 'times as strings',
      sourceId: 'v1',
      startSeconds: '5',
      endSeconds: '9'
    })
    hostile.project.clips.push({
      id: 'c3',
      name: 'ends before it starts',
      sourceId: 'v1',
      startSeconds: 30,
      endSeconds: 20
    })
    hostile.project.clips.push({ id: 'c4', name: 'not much of a clip' })
    hostile.project.sources.push('not an object')
    hostile.project.sources.push({ id: 'v2' })

    const parsed = readPackage(hostile)
    const normalised = normalizeProject(
      { ...parsed.project, name: parsed.project.name },
      'package.ripperpack'
    )

    // The one real clip and the one real POV survive; nothing else does.
    expect(normalised.clips.map((c) => c.id)).toEqual(['c1'])
    expect(normalised.sources.map((s) => s.id)).toEqual(['v1'])
    // And the project is whole afterwards, not a husk.
    expect(normalised.name).toBe('Bank job')
    expect(normalised.exportSettings.filenameTemplate).toBeTruthy()
  })

  it('keeps a name that would break a generated project file, rather than the app', () => {
    /*
     * Names are not sanitised on import, by design — a name is the person's
     * to choose, and mangling it would be worse than carrying it. What must
     * hold is that the *generators* can take it; see
     * generatedProjectEscaping.test.ts, which is where that is enforced.
     */
    const project = normalizeProject(
      { name: 'Bank job\n"""', clips: [], sources: [] },
      'package.ripperpack'
    )
    expect(project.name).toBe('Bank job\n"""')
  })
})
