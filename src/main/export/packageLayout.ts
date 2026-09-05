import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { EditingProject } from '../../shared/editingProject.js'
import type { ExportDestination } from './exporterTypes.js'

/**
 * The shape every export has, whichever editor it is for.
 *
 *     Export/
 *       Media/        the angles, or nothing when they are referenced in place
 *       Assets/       the watermark image
 *       Metadata/     project.json, povs.json, watermark.json
 *       Editor/       whatever the adapter generates
 *       README.html   what this is and what to do with it
 *
 * Media is *referenced* by default. Copying twenty four-hour angles to make a
 * folder self-contained is the only part of this process that would take real
 * time or real disk, and it is the one thing a person should have to ask for.
 */
export const MEDIA_DIR = 'Media'
export const ASSETS_DIR = 'Assets'
export const METADATA_DIR = 'Metadata'
export const EDITOR_DIR = 'Editor'

export async function makeLayout(destination: ExportDestination): Promise<void> {
  for (const dir of [ASSETS_DIR, METADATA_DIR, EDITOR_DIR]) {
    await mkdir(join(destination.directory, dir), { recursive: true })
  }
  if (destination.copyMedia) {
    await mkdir(join(destination.directory, MEDIA_DIR), { recursive: true })
  }
}

/**
 * Put the media where the project will look for it, and say where that is.
 *
 * Returns the project with `media[].path` rewritten, so an adapter never has
 * to know whether the files were copied — it writes whatever path it is given.
 */
export async function placeMedia(
  project: EditingProject,
  destination: ExportDestination
): Promise<EditingProject> {
  if (!destination.copyMedia) return project

  /*
   * Copies are numbered in track order.
   *
   * For an editor that reads the project file this is cosmetic. For one that
   * does not — where the person selects twenty files and drags them in — it is
   * the difference between tracks that come out in a sensible order and twenty
   * clips in whatever order the file manager felt like. The number is a prefix
   * rather than a rename, so the original name is still readable.
   */
  const order = new Map<string, number>()
  project.timeline.tracks
    .filter((track) => track.type === 'video')
    .forEach((track, index) => {
      const mediaId = track.clips[0]?.mediaId
      if (mediaId) order.set(mediaId, index + 1)
    })

  const media = []
  for (const item of project.media) {
    const position = order.get(item.id)
    const name =
      position === undefined
        ? basename(item.path)
        : `${String(position).padStart(2, '0')} - ${basename(item.path)}`
    const target = join(destination.directory, MEDIA_DIR, name)
    await copyFile(item.path, target)
    media.push({ ...item, path: target, name })
  }
  return { ...project, media }
}

/** Copy the watermark image in, and point the project at the copy. */
export async function placeWatermark(
  project: EditingProject,
  destination: ExportDestination
): Promise<EditingProject> {
  if (!project.watermark) return project
  const target = join(destination.directory, ASSETS_DIR, basename(project.watermark.assetPath))
  await copyFile(project.watermark.assetPath, target)

  const tracks = project.timeline.tracks.map((track) =>
    track.type !== 'overlay'
      ? track
      : {
          ...track,
          clips: track.clips.map((clip) => (clip.assetPath ? { ...clip, assetPath: target } : clip))
        }
  )
  return {
    ...project,
    watermark: { ...project.watermark, assetPath: target },
    timeline: { ...project.timeline, tracks }
  }
}

/**
 * A path relative to the export folder, in POSIX form.
 *
 * Relative wherever the editor allows it, because a project that survives being
 * moved to another machine is worth more than one that opens fractionally
 * faster. `relative()` answers in the platform's separators; a project file is
 * read by an application that may not be on this platform.
 */
export function relativePath(fromDirectory: string, target: string): string {
  const rel = relative(fromDirectory, target)
  return rel.split(sep).join('/')
}

/** The three metadata documents, which together reconstruct the project. */
export async function writeMetadata(
  project: EditingProject,
  destination: ExportDestination
): Promise<string[]> {
  const dir = join(destination.directory, METADATA_DIR)
  const files: Array<[string, unknown]> = [
    ['project.json', project],
    ['povs.json', { schemaVersion: project.schemaVersion, povs: project.povs, media: project.media }],
    [
      'watermark.json',
      project.watermark
        ? {
            schemaVersion: project.schemaVersion,
            asset: basename(project.watermark.assetPath),
            config: project.watermark.config,
            transform: project.watermark.transform
          }
        : { schemaVersion: project.schemaVersion, asset: null, config: null, transform: null }
    ]
  ]
  const written: string[] = []
  for (const [name, body] of files) {
    const path = join(dir, name)
    await writeFile(path, JSON.stringify(body, null, 2), 'utf8')
    written.push(path)
  }
  return written
}
