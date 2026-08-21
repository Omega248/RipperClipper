/**
 * Handing gathered material to the Editor (§19) — DEV/EXPERIMENTAL ONLY.
 *
 * This module is pure and free of UI, but the *feature* is gated: the only
 * thing that imports it is the Editor's own module graph, which
 * `__EDITOR_ENABLED__` proves unreachable in a stable build (see
 * electron.vite.config.ts), so a production build drops this file entirely
 * rather than merely hiding the button. §19 and §23 both require that it must
 * not leak into stable, and "the import is unreachable" is a stronger
 * guarantee than "the button is hidden".
 *
 * What "prepare" means: work out exactly what the Editor will need for a set
 * of clips — which POVs, which ranges of them, which audio edits and
 * watermarks travel along — and report anything that would make the handover
 * incomplete *before* any of it is built. Discovering half way through
 * assembling a timeline that one POV was never aligned is the failure this
 * exists to prevent.
 */

import { clipRangeInPov } from './povMapping.js'
import { isSynced } from './sync.js'
import { workflowOf } from './collections.js'
import type { AudioEdit } from './audioEdits.js'
import type { ClipSegment, ProjectFile, TimelineTransform, VodSource } from './types.js'
import type { WatermarkConfig } from './watermark.js'

/** One clip's material, resolved against the POV it will actually be cut from. */
export interface PreparedClip {
  clipId: string
  name: string
  sourceId: string
  /** The range in that POV's own time — what the Editor's timeline item spans. */
  sourceStartSeconds: number
  sourceEndSeconds: number
  /** The sound POV, when it differs from the picture. */
  audioSourceId?: string
  audioEdits: AudioEdit[]
  watermark?: WatermarkConfig | 'none'
  transform?: TimelineTransform
  /** Only partial coverage was available — the Editor gets less than the whole moment. */
  partial: boolean
}

export interface PreparationPlan {
  clips: PreparedClip[]
  /** Every POV the prepared clips reference, deduplicated. */
  sourceIds: string[]
  /** Total seconds of material — what the Editor's sequence will run to. */
  totalSeconds: number
  /**
   * Reasons the handover is incomplete. Non-empty does not mean "refuse":
   * a partial handover is often exactly what is wanted, so the caller is
   * told and decides. Silently dropping a clip would not be.
   */
  warnings: string[]
  /** Clips that could not be prepared at all, with why. */
  skipped: Array<{ clipId: string; name: string; reason: string }>
}

/**
 * Work out what the Editor needs, and what it will not get.
 *
 * A clip is prepared from its chosen picture POV — `videoSourceId` when the
 * editor picked one, otherwise the POV it was authored in — because that is
 * the POV the exporter would use, and the Editor must start from the same
 * decision rather than a different default.
 */
export function prepareForEditor(
  project: ProjectFile,
  clipIds: string[]
): PreparationPlan {
  const chosen = project.clips.filter((c) => clipIds.includes(c.id))
  const byId = new Map(project.sources.map((s) => [s.id, s]))

  const clips: PreparedClip[] = []
  const skipped: PreparationPlan['skipped'] = []
  const warnings: string[] = []
  const sourceIds = new Set<string>()
  let totalSeconds = 0

  for (const clip of chosen) {
    const pictureId = clip.videoSourceId ?? clip.sourceId
    const source = byId.get(pictureId)
    if (!source) {
      skipped.push({ clipId: clip.id, name: clip.name, reason: 'its POV is no longer in the project' })
      continue
    }

    const range = clipRangeInPov(clip, source)
    if (range.coverage === 'none') {
      skipped.push({
        clipId: clip.id,
        name: clip.name,
        reason: `${source.creator || source.title} was not recording during it`
      })
      continue
    }
    if (range.coverage === 'unknown') {
      skipped.push({
        clipId: clip.id,
        name: clip.name,
        reason: `${source.creator || source.title} is not aligned to the event clock yet`
      })
      continue
    }

    const audioSource = clip.audioSourceId && clip.audioSourceId !== pictureId ? clip.audioSourceId : undefined
    if (audioSource && !byId.has(audioSource)) {
      warnings.push(`${clip.name} wanted its sound from a POV that is no longer loaded; using its own.`)
    }

    sourceIds.add(pictureId)
    if (audioSource && byId.has(audioSource)) sourceIds.add(audioSource)

    const partial = range.coverage === 'partial'
    if (partial) {
      warnings.push(`${clip.name} is only partly covered by ${source.creator || source.title}.`)
    }

    clips.push({
      clipId: clip.id,
      name: clip.name,
      sourceId: pictureId,
      sourceStartSeconds: range.localStart,
      sourceEndSeconds: range.localEnd,
      ...(audioSource && byId.has(audioSource) ? { audioSourceId: audioSource } : {}),
      audioEdits: clip.audioEdits ?? [],
      partial
    })
    totalSeconds += range.localEnd - range.localStart
  }

  // Stated once for the whole plan rather than per clip: a POV that is not on
  // the event clock affects every clip that would come from it, and repeating
  // it per clip buries the actual point.
  const unaligned = [...sourceIds]
    .map((id) => byId.get(id))
    .filter((s): s is VodSource => Boolean(s) && (!s!.syncMapping || !isSynced(s!.syncMapping)))
  if (unaligned.length > 0) {
    warnings.push(
      `${unaligned.length} POV${unaligned.length === 1 ? ' is' : 's are'} not aligned to the event clock — their cuts may not line up.`
    )
  }

  return { clips, sourceIds: [...sourceIds], totalSeconds, warnings, skipped }
}

/** Clips worth offering to the Editor by default: everything actually ready. */
export function readyForEditor(clips: ClipSegment[]): ClipSegment[] {
  return clips.filter((c) => {
    const state = workflowOf(c)
    return state === 'ready-for-edit' || state === 'povs-collected' || state === 'in-edit'
  })
}
