import { useEffect } from 'react'
import { useStore } from '../store.js'
import { openClip } from '../navigate.js'
import { Button, Icon } from '../ui/index.js'

/**
 * The review run.
 *
 * `exportEveryPov` will fan every clip across every angle in one call, so the
 * machine side of batch work was already solid. The human side had nothing: no
 * way to say "work through these forty moments", no next, no notion of a
 * moment being done. Every clip was reached by navigating to it by hand.
 *
 * This is the queue. It appears above the workspace whenever `reviewRun` has
 * anything in it — that emptiness is the only state, deliberately, because a
 * separate `inReviewRun` boolean is how the app previously ended up with two
 * controls disagreeing about where you were.
 *
 * The keyboard loop is the point. Mark in and out, pick an angle, queue it,
 * next — without the player ever rebuilding between moments. If N remounts the
 * player the loop is slower than clicking and nobody will use it.
 */
export default function ReviewRunStrip(): JSX.Element | null {
  const run = useStore((s) => s.reviewRun)
  const index = useStore((s) => s.reviewIndex)
  const advanceRun = useStore((s) => s.advanceRun)
  const endRun = useStore((s) => s.endRun)
  const clips = useStore((s) => s.project?.clips)

  const active = run.length > 0

  // Only bound while a run is going, so N means nothing outside it. The strip
  // owns this rather than useShortcuts because the binding has to disappear
  // with the strip.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      if (event.key === 'Escape') {
        endRun()
        return
      }
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      const next = event.shiftKey ? index - 1 : index + 1
      if (next < 0 || next >= run.length) return
      advanceRun(next - index)
      const clipId = run[next]
      // openClip moves the selection with the playhead; the player element
      // itself stays mounted, which is what keeps the loop worth using.
      if (clipId) openClip(clipId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, advanceRun, endRun, index, run])

  if (!active) return null

  const position = Math.min(index + 1, run.length)
  const finished = position >= run.length
  const nextId = run[index + 1]
  const nextName = nextId ? (clips ?? []).find((c) => c.id === nextId)?.name : null

  return (
    <div className="review-run">
      <span className="review-run-kicker">Review run</span>
      <span className="review-run-count">
        {position} / {run.length}
      </span>

      <span className="review-run-track" aria-hidden="true">
        <span
          className="review-run-fill"
          style={{ width: `${Math.round((position / run.length) * 100)}%` }}
        />
      </span>

      <span className="review-run-next ellipsis">
        {nextName ? `Next — ${nextName}` : 'Last moment in this run'}
      </span>

      <span className="review-run-keys">
        <kbd>I</kbd>
        <kbd>O</kbd>
        mark
        <kbd>1–9</kbd>
        angle
        {/* E commits, so it is the one key that carries the accent. */}
        <kbd className="is-commit">E</kbd>
        queue
      </span>

      {finished ? (
        <Button size="compact" variant="primary" onClick={endRun}>
          Finish
          <Icon name="check" size={13} />
        </Button>
      ) : (
        <Button
          size="compact"
          variant="primary"
          onClick={() => {
            advanceRun(1)
            const clipId = run[index + 1]
            if (clipId) openClip(clipId)
          }}
        >
          Next
          <kbd>N</kbd>
          <Icon name="chevron-right" size={13} />
        </Button>
      )}

      <Button size="compact" variant="ghost" onClick={endRun}>
        Leave run
      </Button>
    </div>
  )
}
