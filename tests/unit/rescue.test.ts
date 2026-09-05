import { describe, expect, it, vi } from 'vitest'
import { rescueProject } from '../../src/shared/rescue.js'
import type { ProjectFile } from '../../src/shared/types.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'

/**
 * The last thing that runs before the UI is gone.
 *
 * Autosave is a timer inside the React tree, so a render throw stopped it — and
 * every clip cut since the last tick went with it, because the window that was
 * left had no menu and no Ctrl+S. The error boundary now saves before it draws
 * anything, and this is that save.
 */

const project = (): ProjectFile => ({
  schemaVersion: 5,
  id: 'p',
  name: 'Session',
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T00:00:00Z',
  sources: [],
  clips: [],
  markers: [],
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
  outputDirectory: null
})

describe('rescueProject', () => {
  it('writes back to the file the project came from', async () => {
    const saveProject = vi.fn().mockResolvedValue(undefined)
    const saveProjectAs = vi.fn()
    const out = await rescueProject({ saveProject, saveProjectAs }, project(), 'C:\\a\\b.cookieclip')

    expect(out).toEqual({ kind: 'saved', path: 'C:\\a\\b.cookieclip' })
    expect(saveProject).toHaveBeenCalledOnce()
    // Not somewhere new: afterwards people look where they last saved.
    expect(saveProjectAs).not.toHaveBeenCalled()
  })

  it('asks where to put an unsaved project', async () => {
    const saveProjectAs = vi.fn().mockResolvedValue({ path: 'C:\\chosen.cookieclip' })
    const out = await rescueProject(
      { saveProject: vi.fn(), saveProjectAs },
      project(),
      null
    )
    expect(out).toEqual({ kind: 'saved', path: 'C:\\chosen.cookieclip' })
  })

  it('does not claim success when the location prompt is dismissed', async () => {
    // The autosave copy is then the only thing left, and saying "saved" would
    // send someone away from the one file that still has their work.
    const out = await rescueProject(
      { saveProject: vi.fn(), saveProjectAs: vi.fn().mockResolvedValue(null) },
      project(),
      null
    )
    expect(out).toEqual({ kind: 'failed' })
  })

  it('does not claim success when the write throws', async () => {
    const out = await rescueProject(
      {
        saveProject: vi.fn().mockRejectedValue(new Error('disk full')),
        saveProjectAs: vi.fn()
      },
      project(),
      'C:\\a\\b.cookieclip'
    )
    expect(out).toEqual({ kind: 'failed' })
  })

  it('says so plainly when there was nothing open', async () => {
    const saveProject = vi.fn()
    const out = await rescueProject({ saveProject, saveProjectAs: vi.fn() }, null, null)
    expect(out).toEqual({ kind: 'nothing' })
    expect(saveProject).not.toHaveBeenCalled()
  })
})
