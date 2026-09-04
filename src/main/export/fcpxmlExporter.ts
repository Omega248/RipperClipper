import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditingProject, ProjectTransform } from '../../shared/editingProject.js'
import { frameDuration, rationalTime } from '../../shared/editingProject.js'
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
import { sanitizeFilename } from '../../shared/filenames.js'

/**
 * Final Cut Pro, through FCPXML.
 *
 * FCPXML is Apple's documented interchange format, and it is what an
 * application is supposed to use to hand Final Cut a project. It is not a
 * native library, and Apple says so — the guide this adapter writes says so
 * too, because "import this" and "here is your library" are different promises.
 *
 * Two things about the format shape this file. Time is rational: every offset
 * and duration is `numerator/denominator s`, and the denominator has to be the
 * timeline's own timebase or the value is quietly reinterpreted — which is why
 * `rationalTime` exists rather than a `toFixed(3)`. And layering is done with
 * lanes: a clip inside another clip with `lane="1"` sits above it, which is
 * how the watermark ends up over the picture instead of after it.
 */
const FCPXML_VERSION = '1.9'

export class FcpxmlExporter implements ProjectExporter {
  capabilities(): EditorCapabilities {
    return EDITORS['final-cut']
  }

  validate(project: EditingProject): ValidationResult {
    const issues = baseIssues(project)
    if (project.timeline.fps > 0 && project.media.some((m) => Math.abs(m.fps - project.timeline.fps) > 0.01)) {
      issues.push({
        severity: 'warning',
        message: 'Some angles were shot at a different rate from the timeline.',
        fix: 'Final Cut conforms them on import. Nothing is re-encoded here.'
      })
    }
    return { ok: issues.every((i) => i.severity !== 'error'), issues }
  }

  async export(project: EditingProject, destination: ExportDestination): Promise<ExportResult> {
    const started = Date.now()
    const { project: placed } = await preparePackage(project, destination)

    const xmlPath = join(destination.directory, EDITOR_DIR, `${safeName(placed.name)}.fcpxml`)
    await writeFile(xmlPath, fcpxml(placed), 'utf8')

    const files = await writeBasePackage(placed, destination, EDITORS['final-cut'], [
      'Open Final Cut Pro.',
      'File → Import → XML…, and choose the .fcpxml in the Editor folder.',
      'Pick the library to import into when Final Cut asks.',
      'The project appears with every angle on its own lane, already synchronised, and the watermark on the lane above them.'
    ])

    return {
      editor: 'final-cut',
      directory: destination.directory,
      projectFile: xmlPath,
      files: [...files, xmlPath],
      notes: [
        'FCPXML describes a project for import. It is not a native Final Cut library — Apple’s own documentation is explicit about that.',
        `Written as FCPXML ${FCPXML_VERSION}.`
      ],
      elapsedMs: Date.now() - started
    }
  }
}

/**
 * A universal transform in Final Cut's coordinates.
 *
 * Final Cut positions by the item's centre, offset from the frame's centre, in
 * *percent of frame size*, with Y positive upwards. Scale is a multiplier on
 * the item's native size, exactly as in Resolve — so the same trap applies: a
 * logo that should be 12% of the frame is not `scale 0.12`.
 */
export function fcpTransform(
  transform: ProjectTransform,
  frame: { width: number; height: number },
  item: { width: number; height: number }
): { positionX: number; positionY: number; scaleX: number; scaleY: number; rotation: number } {
  return {
    positionX: round((transform.x - 0.5) * 100),
    positionY: round((0.5 - transform.y) * 100),
    scaleX: item.width > 0 ? round((transform.width * frame.width) / item.width) : 1,
    scaleY: item.height > 0 ? round((transform.height * frame.height) / item.height) : 1,
    rotation: -transform.rotation
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function safeName(name: string): string {
  return sanitizeFilename(name, 'project')
}

/**
 * A string as XML character data.
 *
 * The five entities are the obvious half. The other half is that XML 1.0
 * cannot carry most control characters *at all* — `&#x1;` is exactly as
 * illegal as the raw byte, so there is nothing to escape them into and the
 * only correct thing is to drop them. Left in, Final Cut rejects the whole
 * document with a parse error, which reads to the person as Ripper Clipper
 * having produced a broken export. Tab, newline and carriage return are the
 * three that are legal and are kept.
 *
 * Reachable because names are not this app's own: a `.rcpkg` package is
 * shape-checked rather than sanitised, so any byte can arrive in a project or
 * clip name.
 */
export function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFE-\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** `file:///…` — FCPXML wants a URL, not a path, and Windows paths are not URLs. */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href
}

export function fcpxml(project: EditingProject): string {
  const { timeline } = project
  const fps = timeline.fps
  const out: string[] = []
  const emit = (line: string): void => void out.push(line)

  const videoTracks = timeline.tracks.filter((t) => t.type === 'video')
  const overlay = timeline.tracks.find((t) => t.type === 'overlay')
  const overlayClip = overlay?.clips[0]

  emit('<?xml version="1.0" encoding="UTF-8"?>')
  emit(`<!DOCTYPE fcpxml>`)
  emit(`<fcpxml version="${FCPXML_VERSION}">`)
  emit('  <resources>')
  emit(
    `    <format id="r0" name="FFVideoFormat" frameDuration="${frameDuration(fps)}" width="${
      timeline.width
    }" height="${timeline.height}"/>`
  )

  project.media.forEach((media, index) => {
    const id = `r${index + 1}`
    emit(
      `    <asset id="${id}" name="${xmlEscape(media.name)}" start="0s" duration="${rationalTime(
        media.durationSeconds,
        fps
      )}" hasVideo="1" hasAudio="1" format="r0" audioSources="1" audioChannels="2">`
    )
    emit(`      <media-rep kind="original-media" src="${xmlEscape(fileUrl(media.path))}"/>`)
    emit('    </asset>')
  })

  if (project.watermark && overlayClip) {
    emit(
      `    <asset id="rw" name="${xmlEscape(
        basename(project.watermark.assetPath)
      )}" start="0s" duration="${rationalTime(
        overlayClip.timelineEndSeconds,
        fps
      )}" hasVideo="1" format="r0"/>`
    )
    emit(`    <media-rep kind="original-media" src="${xmlEscape(fileUrl(project.watermark.assetPath))}"/>`)
  }

  emit('  </resources>')
  emit(`  <library>`)
  emit(`    <event name="${xmlEscape(project.name)}">`)
  emit(`      <project name="${xmlEscape(project.name)}">`)
  emit(
    `        <sequence format="r0" duration="${rationalTime(
      timeline.durationSeconds,
      fps
    )}" tcStart="0s" tcFormat="NDF">`
  )
  emit('          <spine>')

  /*
   * The first angle is the spine; every other angle is a connected clip on its
   * own lane above it. That is how Final Cut represents "these all play at
   * once" — a spine is a single sequence of shots, so twenty angles laid end
   * to end on it would be twenty consecutive cuts rather than twenty
   * simultaneous views.
   */
  const [primary, ...connected] = videoTracks
  const assetIdFor = (mediaId?: string): string | null => {
    const index = project.media.findIndex((m) => m.id === mediaId)
    return index === -1 ? null : `r${index + 1}`
  }

  if (primary) {
    const clip = primary.clips[0]
    const ref = assetIdFor(clip?.mediaId)
    if (clip && ref) {
      emit(
        `            <asset-clip name="${xmlEscape(primary.name)}" ref="${ref}" lane="0" offset="${rationalTime(
          clip.timelineStartSeconds,
          fps
        )}" start="${rationalTime(clip.sourceInSeconds, fps)}" duration="${rationalTime(
          clip.timelineEndSeconds - clip.timelineStartSeconds,
          fps
        )}" format="r0">`
      )

      connected.forEach((track, index) => {
        const inner = track.clips[0]
        const innerRef = assetIdFor(inner?.mediaId)
        if (!inner || !innerRef) return
        emit(
          `              <asset-clip name="${xmlEscape(track.name)}" ref="${innerRef}" lane="${
            index + 1
          }" offset="${rationalTime(inner.timelineStartSeconds, fps)}" start="${rationalTime(
            inner.sourceInSeconds,
            fps
          )}" duration="${rationalTime(
            inner.timelineEndSeconds - inner.timelineStartSeconds,
            fps
          )}" format="r0"/>`
        )
      })

      if (project.watermark && overlayClip && project.watermark.config.enabled) {
        const t = fcpTransform(
          overlayClip.transform ?? project.watermark.transform,
          { width: timeline.width, height: timeline.height },
          {
            width: Math.max(1, Math.round(project.watermark.transform.width * timeline.width)),
            height: Math.max(1, Math.round(project.watermark.transform.height * timeline.height))
          }
        )
        emit(
          `              <video name="Watermark" ref="rw" lane="${
            connected.length + 1
          }" offset="${rationalTime(overlayClip.timelineStartSeconds, fps)}" start="0s" duration="${rationalTime(
            overlayClip.timelineEndSeconds - overlayClip.timelineStartSeconds,
            fps
          )}">`
        )
        emit(
          `                <adjust-transform position="${t.positionX} ${t.positionY}" scale="${t.scaleX} ${t.scaleY}" rotation="${t.rotation}"/>`
        )
        // Opacity is a compositing property in FCPXML, not a transform one.
        emit(
          `                <adjust-blend amount="${round(
            (overlayClip.transform ?? project.watermark.transform).opacity
          )}"/>`
        )
        emit('              </video>')
      }

      for (const marker of project.markers) {
        emit(
          `              <marker start="${rationalTime(marker.seconds, fps)}" duration="${frameDuration(
            fps
          )}" value="${xmlEscape(marker.name)}"/>`
        )
      }

      emit('            </asset-clip>')
    }
  }

  emit('          </spine>')
  emit('        </sequence>')
  emit('      </project>')
  emit('    </event>')
  emit('  </library>')
  emit('</fcpxml>')
  return out.join('\n') + '\n'
}
