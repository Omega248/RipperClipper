import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { EditingProject } from '../../shared/editingProject.js'
import { timecode } from '../../shared/editingProject.js'
import { EDITORS } from '../../shared/editorCapabilities.js'
import type { EditorCapabilities } from '../../shared/editorCapabilities.js'
import type {
  ExportDestination,
  ExportResult,
  ProjectExporter,
  ValidationResult
} from './exporterTypes.js'
import { baseIssues, preparePackage, writeBasePackage } from './genericExporter.js'
import { EDITOR_DIR } from './packageLayout.js'

/**
 * Movavi Video Editor.
 *
 * Movavi publishes no project format and imports no interchange format — no
 * XML, no AAF, no EDL. `.mepx` is proprietary and undocumented, and writing one
 * by guesswork produces a file that either refuses to open or opens having
 * quietly lost half the angles, which is worse than not producing one. So this
 * adapter generates no project, and says so.
 *
 * What it does instead is remove the work that a project file would have saved.
 * The expensive manual step in a multi-angle edit is not importing files, it is
 * *synchronising* them — twenty clips nudged frame by frame against each other.
 * That work is already done here, and it survives the lack of a project format,
 * because of how the app cuts:
 *
 *     every angle's range is mapped from the same real-world instant
 *                              ↓
 *     every exported file begins at that instant
 *                              ↓
 *     drop them all at 0 and they are in sync
 *
 * So the honest Movavi export is: files that are already aligned, named in
 * order, and a guide that says "put them all at the start" rather than
 * "shift each one by this many frames". Only an angle whose recording began
 * *after* the moment did cannot start there, and those are the only ones with
 * an offset to apply — usually none of them.
 */
export class MovaviExporter implements ProjectExporter {
  capabilities(): EditorCapabilities {
    return EDITORS.movavi
  }

  validate(project: EditingProject): ValidationResult {
    const issues = baseIssues(project)
    const late = lateAngles(project)
    if (late.length > 0) {
      issues.push({
        severity: 'warning',
        message: `${late.length} angle${late.length === 1 ? '' : 's'} started recording after this moment began, so ${
          late.length === 1 ? 'it does' : 'they do'
        } not line up at the start.`,
        fix: 'The guide lists exactly how far in each one belongs. Everything else can be dropped at zero.'
      })
    }
    return { ok: issues.every((i) => i.severity !== 'error'), issues }
  }

  async export(project: EditingProject, destination: ExportDestination): Promise<ExportResult> {
    const started = Date.now()
    const { project: placed } = await preparePackage(project, destination)

    const sheet = join(destination.directory, EDITOR_DIR, 'movavi-timeline.csv')
    await writeFile(sheet, timelineSheet(placed), 'utf8')

    const late = lateAngles(placed)
    const aligned = placed.povs.length - late.length

    const files = await writeBasePackage(placed, destination, EDITORS.movavi, [
      'Open Movavi Video Editor and start a new project.',
      'Drag every file from the Media folder into the media bin — they are numbered in track order.',
      aligned === placed.povs.length
        ? 'Drop each angle at the very start of its own track. They are already in sync: every file was cut from the same instant, so nothing needs nudging.'
        : `Drop the ${aligned} aligned angle${aligned === 1 ? '' : 's'} at the very start of their own tracks — those are already in sync. The ${late.length} listed under "Starts late" in movavi-timeline.csv go that many seconds in.`,
      'Add the watermark image on the top track and stretch it across the whole timeline.',
      'Set its size and position from the Watermark section below — the percentages are of the frame, so they hold whatever resolution you export at.'
    ])

    return {
      editor: 'movavi',
      directory: destination.directory,
      projectFile: join(destination.directory, 'README.html'),
      files: [...files, sheet],
      notes: [
        'Movavi publishes no project format and imports no interchange format, so no project file was generated — one written by guesswork would open wrong or silently drop angles.',
        aligned === placed.povs.length
          ? 'Every angle was cut from the same instant, so dropping them all at the start of the timeline puts them in sync with no manual alignment.'
          : `${aligned} of ${placed.povs.length} angles line up at the start; the rest began recording later and movavi-timeline.csv says how far in each belongs.`,
        'movavi-timeline.csv lists the track order, the offsets and the watermark numbers.'
      ],
      elapsedMs: Date.now() - started
    }
  }
}

/** Angles whose recording began after the moment did — the only ones to nudge. */
export function lateAngles(project: EditingProject): Array<{ name: string; seconds: number }> {
  const out: Array<{ name: string; seconds: number }> = []
  for (const track of project.timeline.tracks) {
    if (track.type !== 'video') continue
    const clip = track.clips[0]
    if (!clip || clip.timelineStartSeconds <= 0.001) continue
    out.push({ name: track.name, seconds: clip.timelineStartSeconds })
  }
  return out
}

/**
 * The timeline as a spreadsheet.
 *
 * A CSV rather than prose because this is a list to work down while dragging
 * clips, and because it is the one artefact here that a future Movavi adapter —
 * or a person with a macro — could read back.
 */
export function timelineSheet(project: EditingProject): string {
  const rows: string[][] = [
    ['Track', 'Angle', 'Platform', 'File', 'Start at', 'Length', 'Source width', 'Source height', 'FPS']
  ]

  project.timeline.tracks
    .filter((t) => t.type === 'video')
    .forEach((track, index) => {
      const clip = track.clips[0]
      const media = project.media.find((m) => m.id === clip?.mediaId)
      const pov = project.povs.find((p) => p.mediaId === clip?.mediaId)
      if (!clip || !media) return
      rows.push([
        String(index + 1),
        pov?.streamerName ?? track.name,
        pov?.platform ?? '',
        basename(media.path),
        timecode(clip.timelineStartSeconds, project.timeline.fps),
        timecode(clip.timelineEndSeconds - clip.timelineStartSeconds, project.timeline.fps),
        String(media.width),
        String(media.height),
        String(media.fps)
      ])
    })

  if (project.watermark && project.watermark.config.enabled) {
    const t = project.watermark.transform
    rows.push([])
    rows.push(['Watermark', 'Value', 'Note'])
    rows.push(['Image', basename(project.watermark.assetPath), 'In the Assets folder'])
    rows.push([
      'Width',
      `${(t.width * 100).toFixed(1)}%`,
      `of frame width — ${Math.round(t.width * project.timeline.width)} px at ${project.timeline.width}×${project.timeline.height}`
    ])
    rows.push([
      'Centre',
      `${(t.x * 100).toFixed(1)}%, ${(t.y * 100).toFixed(1)}%`,
      'from the top-left of the frame'
    ])
    rows.push(['Opacity', `${(t.opacity * 100).toFixed(0)}%`, ''])
    rows.push(['Rotation', `${t.rotation}°`, ''])
    rows.push(['Duration', 'whole timeline', ''])
  }

  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** A cell Excel will not reinterpret: quoted, with quotes doubled. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
