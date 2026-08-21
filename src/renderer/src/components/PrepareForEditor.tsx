import { useMemo, useState } from 'react'
import { prepareForEditor, readyForEditor } from '@shared/prepareEditor'
import { workflowOf } from '@shared/collections'
import { formatDuration } from '@shared/time'
import { CLIP_WORKFLOW_LABEL } from '@shared/types'
import { useStore } from '../store.js'
import { Badge, Button, Checkbox, Dialog, EmptyState, Notice } from '../ui/index.js'

/**
 * Bringing gathered material into the Editor (§19) — DEV/EXPERIMENTAL ONLY.
 *
 * Only the Editor's own module graph imports this, and that graph is
 * unreachable in a stable build (see `__EDITOR_ENABLED__` in App.tsx), so
 * this is dropped from production output rather than hidden — which is what
 * §19 and §23 require.
 *
 * The plan is shown *before* anything is built. A clip that cannot be
 * prepared is named with its reason and a clip only partly covered says so,
 * because finding out half way through assembling a sequence that one POV was
 * never aligned is precisely the failure this exists to prevent.
 */
export default function PrepareForEditor({ onClose }: { onClose: () => void }): JSX.Element {
  const project = useStore((s) => s.project)
  const addClipToTimeline = useStore((s) => s.addClipToTimeline)
  const ensureTimeline = useStore((s) => s.ensureTimeline)
  const setClipWorkflowState = useStore((s) => s.setClipWorkflowState)
  const toast = useStore((s) => s.toast)

  const clips = project?.clips ?? []
  // Default to what has actually been gathered, not every raw find.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(readyForEditor(clips).map((c) => c.id))
  )

  const plan = useMemo(
    () => (project ? prepareForEditor(project, [...selected]) : null),
    [project, selected]
  )

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const bring = (): void => {
    if (!plan || plan.clips.length === 0) return
    ensureTimeline()

    // Read the tracks back *after* ensureTimeline, since on a first open it
    // is what created them — the tracks do not exist before this point.
    const timeline = useStore.getState().project?.timeline
    const videoTrack = timeline?.tracks.filter((t) => t.kind === 'video').sort((a, b) => a.order - b.order)[0]
    const audioTrack = timeline?.tracks.filter((t) => t.kind === 'audio').sort((a, b) => a.order - b.order)[0]
    if (!videoTrack) return

    for (const prepared of plan.clips) {
      addClipToTimeline(prepared.clipId, videoTrack.id, audioTrack?.id)
      setClipWorkflowState(prepared.clipId, 'in-edit')
    }
    toast({
      kind: 'success',
      title: `Brought ${plan.clips.length} clip${plan.clips.length === 1 ? '' : 's'} into the Editor`,
      message: `${formatDuration(plan.totalSeconds)} of material across ${plan.sourceIds.length} POV${plan.sourceIds.length === 1 ? '' : 's'}.`
    })
    onClose()
  }

  return (
    <Dialog
      title="Prepare for Editor"
      description="Gather clips, their POVs, sync, audio edits and watermarks into the sequence."
      size="large"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!plan || plan.clips.length === 0} onClick={bring}>
            Bring {plan?.clips.length ?? 0} into the Editor
          </Button>
        </>
      }
    >
      {clips.length === 0 ? (
        <EmptyState icon="scissors" title="No clips yet." description="Mark some moments first." />
      ) : (
        <>
          <ul className="prepare-list">
            {clips.map((clip) => (
              <li key={clip.id}>
                <Checkbox
                  checked={selected.has(clip.id)}
                  onChange={() => toggle(clip.id)}
                  label={
                    <span className="prepare-row">
                      <span className="ellipsis">{clip.name}</span>
                      <Badge>{CLIP_WORKFLOW_LABEL[workflowOf(clip)]}</Badge>
                      <span className="mono">{formatDuration(clip.durationSeconds)}</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>

          {plan && plan.skipped.length > 0 && (
            <Notice tone="warning" title="These cannot be brought in">
              <ul className="prepare-skipped">
                {plan.skipped.map((s) => (
                  <li key={s.clipId}>
                    <strong>{s.name}</strong> — {s.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          {plan && plan.warnings.length > 0 && (
            <Notice tone="info" title="Worth knowing first">
              <ul className="prepare-skipped">
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}

          {plan && plan.clips.length > 0 && (
            <p className="hint">
              {plan.clips.length} clip{plan.clips.length === 1 ? '' : 's'} ·{' '}
              {formatDuration(plan.totalSeconds)} · {plan.sourceIds.length} POV
              {plan.sourceIds.length === 1 ? '' : 's'}
            </p>
          )}
        </>
      )}
    </Dialog>
  )
}
