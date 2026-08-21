import { describe, expect, it } from 'vitest'
import {
  PACKAGE_VERSION,
  PackageFormatError,
  buildPackage,
  describePackage,
  readPackage
} from '../../src/shared/packaging.js'
import type { ClipSegment, ProjectFile, VodSource } from '../../src/shared/types.js'

/**
 * Making a project portable.
 *
 * The contract: everything needed to reconstruct the *work*, none of the
 * media. A package must survive a round trip without losing an edit, and must
 * refuse a file that is not a package rather than importing it as an empty
 * project.
 */

const source = (id: string): VodSource => ({
  id,
  platform: 'twitch',
  vodId: id,
  url: `https://twitch.tv/videos/${id}`,
  title: id,
  creator: id,
  durationSeconds: 3600,
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: false
})

const clip = (id: string, sourceId: string, over: Partial<ClipSegment> = {}): ClipSegment => ({
  id,
  name: id,
  sourceId,
  startSeconds: 0,
  endSeconds: 10,
  durationSeconds: 10,
  order: 0,
  status: 'idle',
  ...over
})

const project = (over: Partial<ProjectFile> = {}): ProjectFile => ({
  schemaVersion: 5,
  id: 'proj',
  name: 'Bank Robbery',
  createdAt: '',
  updatedAt: '',
  sources: [source('a'), source('b'), source('c')],
  clips: [clip('c1', 'a'), clip('c2', 'b')],
  markers: [],
  exportSettings: { container: 'mp4' } as ProjectFile['exportSettings'],
  outputDirectory: null,
  ...over
})

describe('building a package', () => {
  it('carries the whole project when no subset is chosen', () => {
    const pkg = buildPackage(project(), { appVersion: '1.5.0' })
    expect(pkg.project.clips).toHaveLength(2)
    expect(pkg.project.sources).toHaveLength(3)
  })

  it('narrows POVs to exactly those the chosen clips reference', () => {
    // Sending three POVs for a one-clip package is noise the recipient has to
    // sift through.
    const pkg = buildPackage(project(), { clipIds: ['c1'], appVersion: '1.5.0' })
    expect(pkg.project.clips.map((c) => c.id)).toEqual(['c1'])
    expect(pkg.project.sources.map((s) => s.id)).toEqual(['a'])
  })

  it('keeps a POV that only supplies the sound', () => {
    const p = project({ clips: [clip('c1', 'a', { audioSourceId: 'c' })] })
    const pkg = buildPackage(p, { clipIds: ['c1'], appVersion: '1.5.0' })
    expect(pkg.project.sources.map((s) => s.id).sort()).toEqual(['a', 'c'])
  })

  it('never carries media, only the URLs the POVs came from', () => {
    const json = JSON.stringify(buildPackage(project(), { appVersion: '1.5.0' }))
    expect(json).toContain('https://twitch.tv/videos/a')
    // A package is kilobytes: nothing here should be remotely large.
    expect(json.length).toBeLessThan(50_000)
  })

  it('notes export paths only when asked', () => {
    const p = project({ clips: [clip('c1', 'a', { exportedPath: 'C:/out/c1.mp4' })] })
    expect(buildPackage(p, { appVersion: '1.5.0' }).exportedFiles).toBeUndefined()
    expect(buildPackage(p, { appVersion: '1.5.0', includeExportPaths: true }).exportedFiles).toEqual([
      'C:/out/c1.mp4'
    ])
  })
})

describe('reading a package', () => {
  it('round-trips a project without losing the edits', () => {
    const p = project({
      clips: [
        clip('c1', 'a', {
          eventStartTime: 1000,
          audioEdits: [{ id: 'e1', kind: 'mute', startSeconds: 1, endSeconds: 2 }] as ClipSegment['audioEdits']
        })
      ],
      event: {
        name: 'Heist',
        startSeconds: 1000,
        endSeconds: 2000,
        collections: [{ id: 'col1', name: 'Entry', order: 0 }],
        moments: []
      }
    })
    const round = readPackage(JSON.parse(JSON.stringify(buildPackage(p, { appVersion: '1.5.0' }))))
    expect(round.project.clips[0].audioEdits).toHaveLength(1)
    expect(round.project.clips[0].eventStartTime).toBe(1000)
    expect(round.project.event?.collections[0].name).toBe('Entry')
  })

  it('refuses a JSON file that is not a package, rather than importing an empty project', () => {
    expect(() => readPackage({ some: 'other file' })).toThrow(PackageFormatError)
    expect(() => readPackage(null)).toThrow(PackageFormatError)
    expect(() => readPackage('a string')).toThrow(PackageFormatError)
  })

  it('refuses a package from a newer build, and says so', () => {
    expect(() =>
      readPackage({ format: 'ripper-clipper-package', version: PACKAGE_VERSION + 1, project: {} })
    ).toThrow(/newer version/)
  })

  it('refuses a package whose contents are missing', () => {
    expect(() => readPackage({ format: 'ripper-clipper-package', version: 1 })).toThrow(/clips or POVs/)
  })

  it('opens a package missing a field added since it was written', () => {
    // Forgiving about contents, strict about the envelope.
    const round = readPackage({
      format: 'ripper-clipper-package',
      version: 1,
      project: { clips: [], sources: [] }
    })
    expect(round.project.syncAnchors).toEqual([])
    expect(round.project.name).toBe('Imported package')
  })
})

describe('describing a package', () => {
  it('summarises what is inside', () => {
    const text = describePackage(buildPackage(project(), { appVersion: '1.5.0' }))
    expect(text).toContain('Bank Robbery')
    expect(text).toContain('2 clips')
    expect(text).toContain('3 POVs')
  })

  it('says "1 clip", not "1 clips"', () => {
    const p = project({ clips: [clip('c1', 'a')], sources: [source('a')] })
    const text = describePackage(buildPackage(p, { appVersion: '1.5.0' }))
    expect(text).toContain('1 clip,')
    expect(text).toContain('1 POV,')
  })
})
