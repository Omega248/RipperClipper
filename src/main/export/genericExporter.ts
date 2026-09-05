import { writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { EditingProject } from '../../shared/editingProject.js'
import { EDITORS } from '../../shared/editorCapabilities.js'
import type { EditorCapabilities } from '../../shared/editorCapabilities.js'
import type {
  ExportDestination,
  ExportResult,
  ProjectExporter,
  ValidationIssue,
  ValidationResult
} from './exporterTypes.js'
import { makeLayout, placeMedia, placeWatermark, writeMetadata } from './packageLayout.js'
import { setupGuideHtml } from './setupGuide.js'

/**
 * The fallback, and the base every other adapter builds on.
 *
 * It generates the folder, the manifest and the guide — everything that is
 * true regardless of which editor is opening it. An adapter for a specific
 * editor runs this first and then adds its own file, so the portable copy is
 * never something you lose by choosing Resolve.
 */
export class GenericExporter implements ProjectExporter {
  capabilities(): EditorCapabilities {
    return EDITORS.generic
  }

  validate(project: EditingProject): ValidationResult {
    return { ok: baseIssues(project).every((i) => i.severity !== 'error'), issues: baseIssues(project) }
  }

  async export(project: EditingProject, destination: ExportDestination): Promise<ExportResult> {
    const started = Date.now()
    const { project: placed } = await preparePackage(project, destination)
    const files = await writeBasePackage(placed, destination, EDITORS.generic, [
      'Open your editor and create a new project at the resolution and frame rate listed above.',
      'Import everything in the Media folder.',
      'Put each angle on its own track, in the order listed under Angles.',
      'Shift each angle by its sync offset. An offset of +0.000s means it is already aligned.',
      'Add the watermark image on a track above the angles and set its position, size and opacity to the values under Watermark.'
    ])
    return {
      editor: 'generic',
      directory: destination.directory,
      projectFile: join(destination.directory, 'README.html'),
      files,
      notes: [
        'Nothing was generated for a specific editor, so the timeline is assembled by hand — every number needed is in README.html.'
      ],
      elapsedMs: Date.now() - started
    }
  }
}

/**
 * The manifest and the guide, for a project that has already been placed.
 *
 * Takes the *prepared* project — the one `preparePackage` handed back with its
 * paths rewritten — and never prepares it again. It used to do both, and every
 * adapter calls `preparePackage` itself before generating its own file, so the
 * media was copied twice and the numbered copies came out "02 - 02 - name.mp4".
 * One caller, one copy.
 */
export async function writeBasePackage(
  project: EditingProject,
  destination: ExportDestination,
  editor: EditorCapabilities,
  steps: string[]
): Promise<string[]> {
  const files = await writeMetadata(project, destination)
  const readme = join(destination.directory, 'README.html')
  await writeFile(readme, setupGuideHtml(project, editor, steps), 'utf8')
  return [...files, readme]
}

export async function preparePackage(
  project: EditingProject,
  destination: ExportDestination
): Promise<{ project: EditingProject }> {
  await makeLayout(destination)
  let placed = await placeMedia(project, destination)
  placed = await placeWatermark(placed, destination)
  return { project: placed }
}

/**
 * What is wrong with this project before anyone tries to open it.
 *
 * Checked here rather than in each adapter, because "the file moved" and "the
 * angles do not overlap" are true whoever is importing them. Every check is
 * cheap — a `stat`, a comparison — and none of them opens a media file.
 */
export function baseIssues(project: EditingProject): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (project.povs.length === 0) {
    issues.push({
      severity: 'error',
      message: 'This project has no angles in it.',
      fix: 'Export at least one POV of the clip first.'
    })
  }

  if (!(project.timeline.fps > 0)) {
    issues.push({ severity: 'error', message: 'The timeline has no frame rate.' })
  }
  if (!(project.timeline.width > 0 && project.timeline.height > 0)) {
    issues.push({ severity: 'error', message: 'The timeline has no resolution.' })
  }

  for (const pov of project.povs) {
    if (!project.media.some((m) => m.id === pov.mediaId)) {
      issues.push({
        severity: 'error',
        message: `${pov.streamerName} has no media file behind it.`,
        fix: 'Re-export that angle.'
      })
    }
  }

  const rates = new Set(project.media.map((m) => Math.round(m.fps)))
  if (rates.size > 1) {
    issues.push({
      severity: 'warning',
      message: `The angles are not all the same frame rate (${[...rates].join(', ')} fps).`,
      fix: 'The editor will conform them to the timeline rate. Nothing is re-encoded here.'
    })
  }

  if (project.watermark && project.watermark.config.enabled && !project.watermark.assetPath) {
    issues.push({
      severity: 'error',
      message: 'The watermark is switched on but has no image behind it.',
      fix: 'Pick an image in the watermark editor, or turn the watermark off.'
    })
  }

  return issues
}

/** Media that has moved or been deleted since it was exported. */
export async function missingMedia(project: EditingProject): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const media of project.media) {
    try {
      await access(media.path, constants.R_OK)
    } catch {
      issues.push({
        severity: 'error',
        message: `${media.name} is no longer where it was exported.`,
        fix: 'Export the clip again, or point the project at the moved folder.'
      })
    }
  }
  if (project.watermark?.config.enabled && project.watermark.assetPath) {
    try {
      await access(project.watermark.assetPath, constants.R_OK)
    } catch {
      issues.push({
        severity: 'error',
        message: 'The watermark image is missing.',
        fix: 'Choose the image again in the watermark editor.'
      })
    }
  }
  return issues
}
