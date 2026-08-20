import { useEffect, useState } from 'react'
import { formatTimecode, validateRange } from '@shared/time'
import { applyTemplate } from '@shared/filenames'
import { useActiveClips, useActiveSource, useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import PovMatrix from './PovMatrix.js'
import { Button, EmptyState, Field, Input, Notice, TimeInput } from '../ui/index.js'

/**
 * Numeric precision for the selected clip.
 *
 * The three time fields are timecode controls rather than text boxes: they
 * validate against the POV's real duration, nudge with the arrow keys, and say
 * what is wrong instead of silently reverting.
 */
export default function Properties(): JSX.Element {
  const clips = useActiveClips()
  const source = useActiveSource()
  const selectedClipId = useStore((s) => s.selectedClipId)
  const patchClip = useStore((s) => s.patchClip)
  const project = useStore((s) => s.project)
  const inPoint = useStore((s) => s.inPoint)
  const outPoint = useStore((s) => s.outPoint)
  const currentTime = useStore((s) => s.currentTime)
  const setInPoint = useStore((s) => s.setInPoint)
  const setOutPoint = useStore((s) => s.setOutPoint)
  const createClip = useStore((s) => s.createClip)

  const clip = clips.find((c) => c.id === selectedClipId) ?? null

  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(clip?.name ?? '')
    setError(null)
  }, [clip?.id, clip?.name])

  /** Commit a boundary, refusing anything the POV cannot actually contain. */
  const commit = (which: 'start' | 'end', seconds: number): void => {
    if (!clip || !source || !clip.authored) return
    const nextStart = which === 'start' ? seconds : clip.startSeconds
    const nextEnd = which === 'end' ? seconds : clip.endSeconds
    const validation = validateRange(nextStart, nextEnd, source.durationSeconds)
    if (!validation.ok) {
      setError(validation.errors.join(' '))
      return
    }
    setError(null)
    patchClip(clip.id, which === 'start' ? { startSeconds: seconds } : { endSeconds: seconds })
    playerBus.seek(seconds)
  }

  const commitDuration = (seconds: number): void => {
    if (!clip || !source) return
    if (seconds <= 0) {
      setError('A clip has to be longer than nothing.')
      return
    }
    const validation = validateRange(clip.startSeconds, clip.startSeconds + seconds, source.durationSeconds)
    if (!validation.ok) {
      setError(validation.errors.join(' '))
      return
    }
    setError(null)
    patchClip(clip.id, { endSeconds: clip.startSeconds + seconds })
  }

  return (
    <div>
      <div className="panel-section">
        <h3>Pending selection</h3>
        <div className="rows">
          <Field label="In">
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Input
                mono
                readOnly
                value={inPoint === null ? '—' : formatTimecode(inPoint)}
                aria-label="Selection in point"
              />
              <Button size="compact" onClick={() => setInPoint(currentTime)} title="Set in point (I)">
                Set
              </Button>
            </div>
          </Field>
          <Field label="Out">
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Input
                mono
                readOnly
                value={outPoint === null ? '—' : formatTimecode(outPoint)}
                aria-label="Selection out point"
              />
              <Button size="compact" onClick={() => setOutPoint(currentTime)} title="Set out point (O)">
                Set
              </Button>
            </div>
          </Field>
          <Button
            variant="primary"
            icon="plus"
            fullWidth
            disabled={!source}
            onClick={() => createClip()}
            title="Add the pending selection as a clip (Enter)"
          >
            Add selection as clip
          </Button>
        </div>
      </div>

      <div className="panel-section">
        <h3>Clip properties</h3>
        {!clip && (
          <EmptyState
            icon="scissors"
            title="No clip selected"
            description="Select a clip to change its name and its exact boundaries."
          />
        )}
        {clip && (
          <div className="rows">
            <Field label="Name" htmlFor="clip-name">
              <Input
                id="clip-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => patchClip(clip.id, { name })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            </Field>
            <Field label="Start" htmlFor="clip-start">
              <TimeInput
                id="clip-start"
                label="Clip start"
                seconds={clip.startSeconds}
                max={source?.durationSeconds}
                readOnly={!clip.authored}
                onCommit={(v) => commit('start', v)}
              />
            </Field>
            <Field label="End" htmlFor="clip-end">
              <TimeInput
                id="clip-end"
                label="Clip end"
                seconds={clip.endSeconds}
                max={source?.durationSeconds}
                readOnly={!clip.authored}
                onCommit={(v) => commit('end', v)}
              />
            </Field>
            <Field label="Length" htmlFor="clip-duration" error={error ?? undefined}>
              <TimeInput
                id="clip-duration"
                label="Clip length"
                seconds={clip.durationSeconds}
                readOnly={!clip.authored}
                onCommit={commitDuration}
              />
            </Field>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button size="compact" onClick={() => commit('start', currentTime)}>
                Start at playhead
              </Button>
              <Button size="compact" onClick={() => commit('end', currentTime)}>
                End at playhead
              </Button>
            </div>
            {project && source && (
              <div className="hint">
                Exports as{' '}
                <strong>
                  {applyTemplate(project.exportSettings.filenameTemplate || '{Name}', {
                    name: clip.name,
                    vodTitle: source.title,
                    creator: source.creator,
                    platform: source.platform,
                    date: (source.createdAt ?? new Date().toISOString()).slice(0, 10)
                  })}
                  .{project.exportSettings.container}
                </strong>
              </div>
            )}
            {!clip.authored && (
              <Notice tone="info">
                This clip was made in another POV. The times above are where it falls in the angle
                you are watching — switch to the POV marked <strong>authored</strong> below to change
                its boundaries.
              </Notice>
            )}
            <PovMatrix clip={clip} />
            {clip.exportedPath && (
              <Button
                size="compact"
                icon="folder"
                onClick={() => void window.api.revealPath(clip.exportedPath!)}
              >
                Show last export in folder
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
