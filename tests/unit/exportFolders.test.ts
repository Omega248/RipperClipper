import { describe, expect, it } from 'vitest'
import { buildFolderSegments } from '../../src/shared/filenames.js'
import { exportFolder } from '../../src/main/services/queue.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { VodSource } from '../../src/shared/types.js'

/**
 * Folder templates decide where a file lands. They take the editor's own text,
 * so they are also the most direct path from a clip name to somewhere outside
 * the output directory — the traversal cases below are the point of this file.
 */

const SOURCE: VodSource = {
  id: 'src1',
  platform: 'twitch',
  vodId: 'v1',
  url: 'https://example.invalid/v1',
  title: 'Ranked Session',
  creator: 'SomeStreamer',
  durationSeconds: 3600,
  createdAt: '2026-08-16T20:00:00Z',
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: false
}

const clip = { id: 'c1', name: 'MRPD Shootout', startSeconds: 10, endSeconds: 40 }

function folderFor(template: string, project = 'Bank Robbery'): string[] {
  return exportFolder(clip, SOURCE, { ...DEFAULT_EXPORT_SETTINGS, folderTemplate: template }, project)
}

describe('export folder structures', () => {
  it('gives each project its own folder by default', () => {
    expect(DEFAULT_EXPORT_SETTINGS.folderTemplate).toBe('{Project}')
    expect(folderFor(DEFAULT_EXPORT_SETTINGS.folderTemplate)).toEqual(['Bank Robbery'])
  })

  it('makes a folder per POV', () => {
    expect(folderFor('{Project}/{Creator}')).toEqual(['Bank Robbery', 'SomeStreamer'])
  })

  it('makes a folder per clip, so its POVs sit together', () => {
    expect(folderFor('{Project}/{Name}')).toEqual(['Bank Robbery', 'MRPD Shootout'])
  })

  it('nests clip then POV when asked', () => {
    expect(folderFor('{Project}/{Name}/{Creator}')).toEqual([
      'Bank Robbery',
      'MRPD Shootout',
      'SomeStreamer'
    ])
  })

  it('puts everything in the output directory when the template is empty', () => {
    expect(folderFor('')).toEqual([])
  })

  it('drops a level whose token has no value, rather than making a blank folder', () => {
    expect(folderFor('{Project}/{Creator}', '')).toEqual(['SomeStreamer'])
  })
})

describe('folder templates cannot escape the output directory', () => {
  it('refuses parent-directory hops', () => {
    expect(buildFolderSegments('{Project}/../../secret', { name: 'x', project: 'Event' })).toEqual([
      'Event',
      'secret'
    ])
  })

  it('strips traversal that arrives through a clip name', () => {
    const segments = buildFolderSegments('{Project}/{Name}', {
      name: '../../../Windows/System32',
      project: 'Event'
    })
    // It flattens to one harmless folder name: no separators, no dot-only
    // segment, so it cannot climb anywhere.
    expect(segments.some((p) => p.includes('/') || p.includes('\\'))).toBe(false)
    expect(segments.some((p) => /^\.+$/.test(p))).toBe(false)
    expect(segments.some((p) => p.startsWith('.'))).toBe(false)
  })

  it('never yields an absolute path or a drive letter', () => {
    expect(buildFolderSegments('/etc', { name: 'x' })).toEqual(['etc'])
    const drive = buildFolderSegments('{Name}', { name: 'C:' })
    expect(drive.every((p) => !p.includes(':'))).toBe(true)
  })

  it('sanitises characters Windows forbids in a folder name', () => {
    const segments = buildFolderSegments('{Name}', { name: 'Dean: shot? <yes>' })
    expect(segments[0]).not.toMatch(/[\\/:*?"<>|]/)
  })
})
