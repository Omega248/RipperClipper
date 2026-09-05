import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EditingProject, ProjectTransform } from '../../shared/editingProject.js'
import { secondsToFrames } from '../../shared/editingProject.js'
import { EDITORS } from '../../shared/editorCapabilities.js'
import type { EditorCapabilities } from '../../shared/editorCapabilities.js'
import { anchorPoint } from '../../shared/buildEditingProject.js'
import type {
  ExportDestination,
  ExportResult,
  ProjectExporter,
  ValidationResult
} from './exporterTypes.js'
import { baseIssues, preparePackage, writeBasePackage } from './genericExporter.js'
import { EDITOR_DIR } from './packageLayout.js'

/**
 * DaVinci Resolve, through its own scripting API.
 *
 * Resolve publishes no writable project format — a `.drp` is a database
 * export, not an interchange — but it does publish a scripting API that can
 * create the project, import the media, build the timeline, add the tracks and
 * set a timeline item's Pan/Tilt/Zoom/Opacity. So the adapter writes a Python
 * script that calls those methods, and the person runs it from Resolve's own
 * Scripts menu. Nothing is executed here; the app writes a file and says where
 * it is.
 *
 * The API's coordinate system is the reason most of this file exists. Resolve
 * positions an item by its *centre*, in pixels, measured from the centre of
 * the frame, and sizes it with a zoom factor relative to the item's own native
 * size. The universal model stores a fraction of the frame. Converting between
 * the two is the adapter's whole job, and getting it wrong moves somebody's
 * logo — which is why `resolveTransform` is pure and tested.
 */
export class ResolveExporter implements ProjectExporter {
  capabilities(): EditorCapabilities {
    return EDITORS.resolve
  }

  validate(project: EditingProject): ValidationResult {
    const issues = baseIssues(project)
    if (project.media.some((m) => m.path.includes("'"))) {
      issues.push({
        severity: 'warning',
        message: 'A media path contains an apostrophe.',
        fix: 'It is escaped in the generated script, but renaming the file is tidier.'
      })
    }
    return { ok: issues.every((i) => i.severity !== 'error'), issues }
  }

  async export(project: EditingProject, destination: ExportDestination): Promise<ExportResult> {
    const started = Date.now()
    const { project: placed } = await preparePackage(project, destination)

    const scriptPath = join(destination.directory, EDITOR_DIR, 'build_resolve_project.py')
    await writeFile(scriptPath, resolveScript(placed), 'utf8')

    const files = await writeBasePackage(placed, destination, EDITORS.resolve, [
      'Open DaVinci Resolve.',
      'Go to Workspace → Scripts → Edit… and put build_resolve_project.py from the Editor folder into the Utility folder that opens (or copy it there yourself).',
      'Run Workspace → Scripts → build_resolve_project.',
      `A project called "${placed.name}" is created with every angle in the Media Pool, one track each, already synchronised.`,
      'The watermark is on the top track, already positioned — select it and adjust in the Inspector if you want to move it.'
    ])

    return {
      editor: 'resolve',
      directory: destination.directory,
      projectFile: scriptPath,
      files: [...files, scriptPath],
      notes: [
        'Resolve is driven by its scripting API rather than a project file, so the export is a script you run from inside Resolve. This app never executes it.',
        'The script uses absolute paths, which is what Resolve’s API takes. Moving this folder means relinking in Resolve.'
      ],
      elapsedMs: Date.now() - started
    }
  }
}

/**
 * A universal transform in Resolve's coordinates.
 *
 * Pan and Tilt are pixel offsets of the item's centre from the frame's centre,
 * with Tilt positive *upwards* — the opposite of every screen coordinate
 * system, and the single easiest thing to get backwards here. ZoomX/ZoomY are
 * multipliers on the item's native size, so a 400px-wide logo that should
 * occupy 12% of a 1920px frame zooms to 0.576, not to 0.12.
 */
export function resolveTransform(
  transform: ProjectTransform,
  frame: { width: number; height: number },
  item: { width: number; height: number }
): { pan: number; tilt: number; zoomX: number; zoomY: number; rotation: number; opacity: number } {
  const point = anchorPoint(transform)
  const centreX = transform.x
  const centreY = transform.y
  // The anchor is where the person pinned it; Resolve only knows centres, so
  // the box's own centre is what gets positioned. `point` is kept for adapters
  // whose editors pin by anchor instead.
  void point
  return {
    pan: Math.round((centreX - 0.5) * frame.width),
    tilt: Math.round((0.5 - centreY) * frame.height),
    zoomX: item.width > 0 ? round((transform.width * frame.width) / item.width) : 1,
    zoomY: item.height > 0 ? round((transform.height * frame.height) / item.height) : 1,
    rotation: -transform.rotation,
    opacity: round(transform.opacity * 100)
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * A Python literal for a string, safe for anything that can reach it.
 *
 * JSON's escape set is a subset of Python's, so a JSON string literal *is* a
 * valid Python one — and `JSON.stringify` covers the characters a hand-rolled
 * escape forgets. This was two `.replace()` calls handling backslashes and
 * apostrophes, which is right up until a string contains a line break: a
 * Python literal cannot span lines, so `'Bank job\nheist'` came out as an
 * unterminated string and the whole generated script failed to parse with a
 * SyntaxError pointing at a name.
 *
 * That is reachable rather than theoretical. Names arrive from a `.rcpkg`
 * package, which exists to be shared and is shape-checked rather than
 * sanitised, and marker labels are free text. A broken script is the mild
 * outcome; the sharp one is that this file is *executed* by the person inside
 * Resolve, so a name able to close its own literal could have appended
 * whatever it liked to it.
 */
export function py(value: string): string {
  return JSON.stringify(value)
}

/**
 * A user-supplied string as one line inside the script's `"""` header.
 *
 * The header is prose, not a literal, so `py()` cannot help: a name
 * containing `"""` would close the block and everything after it would be
 * read as code. Double quotes become single ones — a `"""` that cannot be
 * spelled cannot be closed — and every run of whitespace collapses, because a
 * name spanning lines breaks the block open just as effectively.
 */
function prose(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
}

/**
 * The script itself.
 *
 * Written to be readable by whoever runs it — it is going to be executed on
 * their machine by their editor, and "trust me" is not good enough for that.
 * Every call in it is one of the API methods Blackmagic documents.
 */
export function resolveScript(project: EditingProject): string {
  const fps = project.timeline.fps
  const videoTracks = project.timeline.tracks.filter((t) => t.type === 'video')
  const overlay = project.timeline.tracks.find((t) => t.type === 'overlay')
  const overlayClip = overlay?.clips[0]

  const clips = videoTracks.flatMap((track, index) =>
    track.clips.map((clip) => {
      const media = project.media.find((m) => m.id === clip.mediaId)
      if (!media) return null
      return {
        path: media.path,
        name: track.name,
        trackIndex: index + 1,
        recordFrame: secondsToFrames(clip.timelineStartSeconds, fps),
        startFrame: secondsToFrames(clip.sourceInSeconds, media.fps),
        endFrame: secondsToFrames(clip.sourceOutSeconds, media.fps)
      }
    })
  ).filter((c): c is NonNullable<typeof c> => c !== null)

  const wm =
    overlayClip && project.watermark
      ? {
          path: project.watermark.assetPath,
          trackIndex: videoTracks.length + 1,
          durationFrames: secondsToFrames(overlayClip.timelineEndSeconds, fps),
          ...resolveTransform(
            overlayClip.transform ?? project.watermark.transform,
            { width: project.timeline.width, height: project.timeline.height },
            // The image's own pixel size, recovered from the fraction the
            // model stores and the frame it was resolved against.
            {
              width: Math.max(1, Math.round(project.watermark.transform.width * project.timeline.width)),
              height: Math.max(1, Math.round(project.watermark.transform.height * project.timeline.height))
            }
          )
        }
      : null

  const lines: string[] = []
  const emit = (line = ''): void => void lines.push(line)

  emit('#!/usr/bin/env python')
  emit('# -*- coding: utf-8 -*-')
  emit('"""')
  emit(`Builds "${prose(project.name)}" in DaVinci Resolve.`)
  emit('')
  emit('Generated by Ripper Clipper. Run it from Resolve: Workspace -> Scripts.')
  emit('It creates a project, imports the angles, lays them out already')
  emit('synchronised, and puts the watermark on the top track at the position')
  emit('you set in the app. It does not modify any media.')
  emit('"""')
  emit('')
  emit('import sys')
  emit('')
  emit('resolve = globals().get("resolve") or globals().get("app")')
  emit('if resolve is None:')
  emit('    try:')
  emit('        import DaVinciResolveScript as dvr')
  emit('        resolve = dvr.scriptapp("Resolve")')
  emit('    except Exception:')
  emit('        resolve = None')
  emit('if resolve is None:')
  emit('    print("Run this from inside Resolve: Workspace -> Scripts.")')
  emit('    sys.exit(1)')
  emit('')
  emit('pm = resolve.GetProjectManager()')
  emit(`project = pm.CreateProject(${py(project.name)}) or pm.LoadProject(${py(project.name)})`)
  emit('if project is None:')
  emit('    print("Could not create or open the project. Is one already open with unsaved changes?")')
  emit('    sys.exit(1)')
  emit('')
  emit(`project.SetSetting('timelineResolutionWidth', '${project.timeline.width}')`)
  emit(`project.SetSetting('timelineResolutionHeight', '${project.timeline.height}')`)
  emit(`project.SetSetting('timelineFrameRate', '${fps}')`)
  emit('')
  emit('pool = project.GetMediaPool()')
  emit('root = pool.GetRootFolder()')
  emit("povs_bin = pool.AddSubFolder(root, 'POVs') or root")
  emit("assets_bin = pool.AddSubFolder(root, 'Assets') or root")
  emit('')
  emit('# --- import the angles ------------------------------------------------')
  emit('pool.SetCurrentFolder(povs_bin)')
  emit('paths = [')
  for (const clip of clips) emit(`    ${py(clip.path)},`)
  emit(']')
  emit('items = pool.ImportMedia(paths) or []')
  emit('by_path = {}')
  emit('for item in items:')
  emit("    by_path[item.GetClipProperty('File Path')] = item")
  emit('missing = [p for p in paths if p not in by_path]')
  emit('if missing:')
  emit('    print("Resolve would not import:")')
  emit('    for p in missing:')
  emit('        print("   ", p)')
  emit('')

  if (wm) {
    emit('# --- import the watermark --------------------------------------------')
    emit('pool.SetCurrentFolder(assets_bin)')
    emit(`wm_items = pool.ImportMedia([${py(wm.path)}]) or []`)
    emit('watermark = wm_items[0] if wm_items else None')
    emit('')
  }

  emit('# --- build the timeline ----------------------------------------------')
  emit(`timeline = pool.CreateEmptyTimeline(${py(`${project.name} — all angles`)})`)
  emit('if timeline is None:')
  emit('    print("Could not create the timeline.")')
  emit('    sys.exit(1)')
  emit('project.SetCurrentTimeline(timeline)')
  emit('')
  const wanted = clips.length + (wm ? 1 : 0)
  emit(`while timeline.GetTrackCount('video') < ${Math.max(1, wanted)}:`)
  emit("    timeline.AddTrack('video')")
  emit('')
  emit('appends = [')
  for (const clip of clips) {
    emit('    {')
    emit(`        'path': ${py(clip.path)},`)
    emit(`        'name': ${py(clip.name)},`)
    emit(`        'trackIndex': ${clip.trackIndex},`)
    emit(`        'recordFrame': ${clip.recordFrame},`)
    emit(`        'startFrame': ${clip.startFrame},`)
    emit(`        'endFrame': ${Math.max(clip.startFrame + 1, clip.endFrame)},`)
    emit('    },')
  }
  emit(']')
  emit('')
  emit('for spec in appends:')
  emit("    item = by_path.get(spec['path'])")
  emit('    if item is None:')
  emit('        continue')
  emit('    pool.AppendToTimeline([{')
  emit("        'mediaPoolItem': item,")
  emit("        'startFrame': spec['startFrame'],")
  emit("        'endFrame': spec['endFrame'],")
  emit("        'trackIndex': spec['trackIndex'],")
  emit("        'recordFrame': spec['recordFrame'],")
  emit('    }])')
  emit('')
  emit('# Track names say whose angle each one is, rather than "Video 1".')
  emit('names = [')
  for (const clip of clips) emit(`    (${clip.trackIndex}, ${py(clip.name)}),`)
  emit(']')
  emit('for index, name in names:')
  emit("    timeline.SetTrackName('video', index, name)")
  emit('')

  if (wm) {
    emit('# --- the watermark, already positioned --------------------------------')
    emit('if watermark is not None:')
    emit('    placed = pool.AppendToTimeline([{')
    emit("        'mediaPoolItem': watermark,")
    emit("        'startFrame': 0,")
    emit(`        'endFrame': ${Math.max(1, wm.durationFrames)},`)
    emit(`        'trackIndex': ${wm.trackIndex},`)
    emit("        'recordFrame': 0,")
    emit('    }])')
    emit(`    timeline.SetTrackName('video', ${wm.trackIndex}, 'Watermark')`)
    emit('    for item in (placed or []):')
    emit(`        item.SetProperty('Pan', ${wm.pan})`)
    emit(`        item.SetProperty('Tilt', ${wm.tilt})`)
    emit("        item.SetProperty('ZoomGang', False)")
    emit(`        item.SetProperty('ZoomX', ${wm.zoomX})`)
    emit(`        item.SetProperty('ZoomY', ${wm.zoomY})`)
    emit(`        item.SetProperty('RotationAngle', ${wm.rotation})`)
    emit(`        item.SetProperty('Opacity', ${wm.opacity})`)
    emit('')
  }

  if (project.markers.length > 0) {
    emit('# --- markers ----------------------------------------------------------')
    emit('markers = [')
    for (const marker of project.markers) {
      emit(
        `    (${secondsToFrames(marker.seconds, fps)}, ${py(marker.name)}, ${py(marker.note ?? '')}),`
      )
    }
    emit(']')
    emit('for frame, name, note in markers:')
    emit("    timeline.AddMarker(frame, 'Blue', name, note, 1)")
    emit('')
  }

  emit('print("Done. %d angles on the timeline." % len(appends))')
  emit('')
  return lines.join('\n')
}
