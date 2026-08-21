/**
 * What a project needs from you right now (§18).
 *
 * A list of project names says nothing about which one to open. What actually
 * decides that is what is *unfinished*: clips nobody has reviewed, POVs that
 * never got aligned, footage that covers a moment and was never looked at.
 * So the summary leads with attention rather than with counts.
 *
 * Pure, and derived entirely from a project already in memory — there is no
 * separate index to keep in step, and a summary can never disagree with the
 * project it describes.
 */

import { eventCoverageFraction } from './event.js'
import { unusedPovIds, workflowOf } from './collections.js'
import { isSynced } from './sync.js'
import type { ProjectFile } from './types.js'

export interface ProjectSummary {
  clips: number
  povs: number
  collections: number
  /** 0..1 — the fraction of the event window at least one POV can show. */
  coverage: number
  /** Clips still sitting at `found` — marked, but never looked at again. */
  needReview: number
  readyForExport: number
  exported: number
  /** POVs with no usable place on the event clock. */
  unalignedPovs: number
  /** Clips with a POV that covers them and was never used. */
  clipsWithUnusedPovs: number
}

export function summariseProject(project: ProjectFile): ProjectSummary {
  let needReview = 0
  let readyForExport = 0
  let exported = 0
  let clipsWithUnusedPovs = 0

  for (const clip of project.clips) {
    const state = workflowOf(clip)
    if (state === 'found') needReview++
    if (state === 'ready-for-edit') readyForExport++
    if (state === 'exported') exported++
    if (unusedPovIds(clip).length > 0) clipsWithUnusedPovs++
  }

  return {
    clips: project.clips.length,
    povs: project.sources.length,
    collections: project.event?.collections.length ?? 0,
    coverage: eventCoverageFraction(project),
    needReview,
    readyForExport,
    exported,
    // "Not aligned" is counted from the mapping itself rather than from
    // coverage, because a POV can be perfectly aligned and still not cover
    // the event — those are different problems and only one is work.
    unalignedPovs: project.sources.filter((s) => !s.syncMapping || !isSynced(s.syncMapping)).length,
    clipsWithUnusedPovs
  }
}

/**
 * The one line worth showing under a project's name: whatever most needs
 * doing, or that there is nothing.
 *
 * Deliberately singular. A row of six numbers is a report; one sentence is a
 * decision about whether to open this project next.
 */
export function attentionLine(summary: ProjectSummary): string {
  if (summary.clips === 0 && summary.povs === 0) return 'Empty — nothing gathered yet.'
  if (summary.unalignedPovs > 0) {
    return `${summary.unalignedPovs} POV${summary.unalignedPovs === 1 ? '' : 's'} not aligned to the event clock`
  }
  if (summary.needReview > 0) {
    return `${summary.needReview} clip${summary.needReview === 1 ? '' : 's'} still need review`
  }
  if (summary.clipsWithUnusedPovs > 0) {
    return `${summary.clipsWithUnusedPovs} clip${summary.clipsWithUnusedPovs === 1 ? '' : 's'} have POVs you have not used`
  }
  if (summary.readyForExport > 0) {
    return `${summary.readyForExport} ready for export`
  }
  if (summary.exported === summary.clips && summary.clips > 0) return 'All clips exported.'
  return 'Nothing outstanding.'
}
