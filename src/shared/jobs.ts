/**
 * What a job's stage means, in one place.
 *
 * This existed as a local `isSettled` inside a `useEffect` in `App.tsx`, so
 * everywhere else that needed the same question — the rail badge, the Backlog's
 * failed band — answered it independently, and the rail answered it wrong:
 * `stage !== 'complete'` counts failed and cancelled jobs as pending, so two
 * cancelled exports read as "2" on Export forever. A badge that is never right
 * is a badge you learn to ignore, which is the one thing a badge must not be.
 *
 * Three questions, three predicates, no filtering on string literals anywhere
 * else in the app.
 */

import type { JobStage } from './types.js'

/** Finished, one way or another. Nothing more will happen to this job. */
export function isSettled(stage: JobStage): boolean {
  return stage === 'complete' || stage === 'failed' || stage === 'cancelled'
}

/** Failed, as distinct from cancelled — a cancel was asked for, a failure was not. */
export function isFailed(stage: JobStage): boolean {
  return stage === 'failed'
}

/** Actually working, or waiting to. This is the number a badge should show. */
export function isInFlight(stage: JobStage): boolean {
  return !isSettled(stage)
}
