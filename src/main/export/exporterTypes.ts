import type { EditingProject } from '../../shared/editingProject.js'
import type { EditorCapabilities, EditorId } from '../../shared/editorCapabilities.js'

export interface ExportDestination {
  /** The folder the package is written into. Created if it does not exist. */
  directory: string
  /**
   * Copy the media beside the project rather than pointing at where it is.
   *
   * Off by default and that is deliberate: the media is already on this disk,
   * and copying twenty angles to make a project readable is the one thing in
   * this whole path that would actually cost time and space.
   */
  copyMedia: boolean
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  message: string
  /** What the person can do about it, when there is something. */
  fix?: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

export interface ExportResult {
  editor: EditorId
  directory: string
  /** The file the person opens or imports. */
  projectFile: string | null
  files: string[]
  notes: string[]
  /**
   * Wall-clock milliseconds. Recorded because the promise this whole design
   * makes is that it does not scale with video length — a number that grows
   * with duration is the symptom of that promise being broken.
   */
  elapsedMs: number
}

/**
 * One editing application's view of a universal project.
 *
 * Adapters are the only place allowed to know an editor exists. Everything
 * above them works on `EditingProject`, which is what stops a `if (editor ===
 * 'resolve')` from appearing in the middle of the timeline code.
 */
export interface ProjectExporter {
  capabilities(): EditorCapabilities
  validate(project: EditingProject): ValidationResult
  export(project: EditingProject, destination: ExportDestination): Promise<ExportResult>
}
