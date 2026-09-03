import type { ProjectFile } from './types.js'

/**
 * Getting a project onto disk when the UI has already died.
 *
 * Split out of `ErrorBoundary` so it can be tested: the boundary itself needs a
 * React lifecycle and a DOM, but this is the part that decides whether someone
 * keeps an afternoon's clips, and it must not be the untested half.
 *
 * It writes to the project's own file when it has one and asks for a location
 * when it does not — the same two paths as a normal save, deliberately. A
 * crash is not the moment to invent a new file layout, and a person looking
 * for their work afterwards will look where they last saved it.
 */

export interface RescueApi {
  saveProject(project: ProjectFile, path: string): Promise<unknown>
  saveProjectAs(project: ProjectFile): Promise<{ path: string } | null>
}

export type RescueOutcome =
  | { kind: 'saved'; path: string | null }
  /** There was no project open, so nothing was lost. */
  | { kind: 'nothing' }
  /** The save itself failed, or the person dismissed the location prompt. */
  | { kind: 'failed' }

export async function rescueProject(
  api: RescueApi,
  project: ProjectFile | null,
  projectPath: string | null
): Promise<RescueOutcome> {
  if (!project) return { kind: 'nothing' }
  try {
    if (projectPath) {
      await api.saveProject(project, projectPath)
      return { kind: 'saved', path: projectPath }
    }
    const chosen = await api.saveProjectAs(project)
    // A cancelled Save As is a failure from here: the autosave copy is the only
    // thing left, and saying "saved" would send someone away from it.
    return chosen?.path ? { kind: 'saved', path: chosen.path } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}
