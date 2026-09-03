import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { EditingProject } from '../../shared/editingProject.js'
import type { EditorId } from '../../shared/editorCapabilities.js'
import { EDITORS } from '../../shared/editorCapabilities.js'
import type { Logger } from '../services/logger.js'
import { GenericExporter, missingMedia } from './genericExporter.js'
import { ResolveExporter } from './resolveExporter.js'
import { FcpxmlExporter } from './fcpxmlExporter.js'
import { MovaviExporter } from './movaviExporter.js'
import type {
  ExportDestination,
  ExportResult,
  ProjectExporter,
  ValidationResult
} from './exporterTypes.js'

/**
 * Which adapter handles which editor.
 *
 * Everything without a real adapter falls to the generic one, which is not a
 * failure state: a portable folder with the media, the watermark and every
 * number written down is a genuinely useful answer for an editor that
 * publishes no way to be automated. What matters is that the app says which
 * one it gave you — `EDITORS[id].projectGeneration` is that answer, and the UI
 * shows it before the export rather than after.
 */
const ADAPTERS: Partial<Record<EditorId, () => ProjectExporter>> = {
  resolve: () => new ResolveExporter(),
  'final-cut': () => new FcpxmlExporter(),
  // No project file — Movavi publishes no format — but a real adapter all the
  // same: the angles arrive already aligned, and it says so instead of asking
  // for twenty manual nudges. See movaviExporter.ts.
  movavi: () => new MovaviExporter()
}

export function exporterFor(editor: EditorId): ProjectExporter {
  const make = ADAPTERS[editor]
  return make ? make() : new GenericExporter()
}

/** A folder name that does not already exist: `Name`, then `Name (2)`. */
export async function freeDirectory(parent: string, name: string): Promise<string> {
  const base = name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Project'
  for (let n = 1; n < 500; n++) {
    const candidate = join(parent, n === 1 ? base : `${base} (${n})`)
    try {
      await access(candidate, constants.F_OK)
    } catch {
      return candidate
    }
  }
  return join(parent, `${base} ${Date.now()}`)
}

export class ProjectExportService {
  constructor(private readonly log: Logger) {}

  capabilities(): typeof EDITORS {
    return EDITORS
  }

  async validate(project: EditingProject, editor: EditorId): Promise<ValidationResult> {
    const exporter = exporterFor(editor)
    const result = exporter.validate(project)
    const missing = await missingMedia(project)
    const issues = [...result.issues, ...missing]
    return { ok: issues.every((i) => i.severity !== 'error'), issues }
  }

  /**
   * Build the package.
   *
   * The timing is logged deliberately. The promise this whole subsystem makes
   * is that generating a project does not scale with how much video it points
   * at — twenty four-hour angles cost the same as two ten-minute ones, because
   * neither reads a frame. A number here that grows with duration is the
   * symptom of that promise having been broken somewhere.
   */
  async export(
    project: EditingProject,
    editor: EditorId,
    destination: ExportDestination
  ): Promise<ExportResult> {
    const exporter = exporterFor(editor)
    const capability = exporter.capabilities()

    this.log.info('export', 'Editing project export started', {
      editor,
      adapter: capability.id,
      povs: project.povs.length,
      media: project.media.length,
      timelineSeconds: project.timeline.durationSeconds,
      copyMedia: destination.copyMedia
    })

    const validation = await this.validate(project, editor)
    for (const issue of validation.issues) {
      this.log[issue.severity === 'error' ? 'warn' : 'debug']('export', issue.message, {
        fix: issue.fix
      })
    }
    if (!validation.ok) {
      throw new Error(
        validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join(' ')
      )
    }

    await mkdir(destination.directory, { recursive: true })
    const result = await exporter.export(project, destination)

    this.log.info('export', 'Editing project export finished', {
      editor,
      directory: result.directory,
      files: result.files.length,
      elapsedMs: result.elapsedMs,
      // Not decorative: this is the ratio that says whether the export read
      // video. It should stay near zero however long the angles are.
      msPerHourOfMedia:
        project.timeline.durationSeconds > 0
          ? Math.round((result.elapsedMs / (project.timeline.durationSeconds / 3600)) * 10) / 10
          : 0
    })

    return result
  }
}
