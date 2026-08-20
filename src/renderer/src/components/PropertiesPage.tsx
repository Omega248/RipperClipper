import { useState } from 'react'
import { editsForPov } from '@shared/audioEdits'
import type { AudioEdit, AudioEditKind } from '@shared/audioEdits'
import { clipRangeInPov } from '@shared/povMapping'
import { povLabel } from '@shared/pov'
import { coverageStatus } from '@shared/status'
import { formatDuration, formatTimecode } from '@shared/time'
import { useStore } from '../store.js'
import { Button, EmptyState, Field, IconButton, Input, PageHeader, Select, StatusBadge, TimeInput } from '../ui/index.js'

const AUDIO_EDIT_KIND_LABEL: Record<AudioEditKind, string> = {
  mute: 'Silence it',
  bleep: 'Bleep it',
  duck: 'Turn it down'
}

/**
 * Properties: what this clip *is*, plus the hand-drawn audio edits that
 * belong to its chosen sound POV.
 *
 * Facts, and the two choices that belong with them — which POV supplies the
 * picture and which supplies the sound. The timeline is on Video, the output
 * is on Export.
 */
export default function PropertiesPage(): JSX.Element {
  const project = useStore((s) => s.project)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const patchClip = useStore((s) => s.patchClip)
  const setClipPov = useStore((s) => s.setClipPov)
  const setPage = useStore((s) => s.setPage)
  const addAudioEdit = useStore((s) => s.addAudioEdit)
  const patchAudioEdit = useStore((s) => s.patchAudioEdit)
  const removeAudioEdit = useStore((s) => s.removeAudioEdit)
  const [draftKind, setDraftKind] = useState<AudioEditKind>('mute')

  const clip = project?.clips.find((c) => c.id === selectedClipId) ?? project?.clips[0] ?? null
  if (!project || !clip) {
    return (
      <>
        <PageHeader title="Properties" description="What a clip is, and where its picture and sound come from." />
        <div className="page-body">
          <EmptyState
            icon="scissors"
            title="No clip to describe"
            description="Make a clip on the Video page and its details appear here."
            action={{ label: 'Go to Video', icon: 'play', onClick: () => setPage('video') }}
          />
        </div>
      </>
    )
  }

  const covering = project.sources.filter((s) => clipRangeInPov(clip, s).coverage !== 'none')
  const videoPov = clip.videoSourceId ?? clip.sourceId
  const audioPov = clip.audioSourceId ?? videoPov
  const povOptions = covering.map((s) => ({ value: s.id, label: povLabel(s) }))
  const edits = editsForPov(clip.audioEdits, audioPov, audioPov)

  const fact = (label: string, value: string): JSX.Element => (
    <div key={label}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )

  return (
    <>
      <PageHeader
        title="Properties"
        description="What this clip is, and where its picture and sound come from."
        meta={
          <>
            <span>{clip.name}</span>
            <span>{formatDuration(clip.durationSeconds)}</span>
            <span>
              {covering.length} of {project.sources.length} POVs cover it
            </span>
          </>
        }
      />

      <div className="page-body one properties">
        <section>
          <h3>Clip</h3>
          <Field label="Name" htmlFor="prop-name">
            <Input
              id="prop-name"
              value={clip.name}
              onChange={(e) => patchClip(clip.id, { name: e.target.value })}
            />
          </Field>
          <dl className="model-facts">
            {fact('Event', project.name)}
            {fact('Length', formatDuration(clip.durationSeconds))}
            {fact(
              'Starts',
              clip.eventStartTime
                ? new Date(clip.eventStartTime * 1000).toLocaleString()
                : 'Not on the event clock yet'
            )}
            {fact('Ends', clip.eventEndTime ? new Date(clip.eventEndTime * 1000).toLocaleString() : '—')}
            {fact(
              'Made in',
              povLabel(project.sources.find((s) => s.id === clip.sourceId) ?? project.sources[0])
            )}
            {fact(
              'Export',
              clip.exportedPath ? 'Complete' : clip.status === 'failed' ? 'Failed' : 'Not exported'
            )}
          </dl>
          {clip.exportedPath && <div className="hint mono ellipsis">{clip.exportedPath}</div>}
          {clip.lastMessage && <div className="hint">{clip.lastMessage}</div>}
        </section>

        <section>
          <h3>Picture and sound</h3>
          <div className="rows" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <Field label="Video from" htmlFor="prop-video">
              <Select
                id="prop-video"
                block
                value={videoPov}
                options={povOptions}
                onChange={(id) => setClipPov(clip.id, 'video', id)}
              />
            </Field>
            <Field label="Sound from" htmlFor="prop-audio">
              <Select
                id="prop-audio"
                block
                value={audioPov}
                options={povOptions}
                onChange={(id) => setClipPov(clip.id, 'audio', id)}
              />
            </Field>
          </div>

          <table className="grid">
            <thead>
              <tr>
                <th>POV</th>
                <th>Platform</th>
                <th>Where it falls in that recording</th>
                <th>Coverage</th>
                <th>Timing</th>
              </tr>
            </thead>
            <tbody>
              {project.sources.map((source) => {
                const range = clipRangeInPov(clip, source)
                return (
                  <tr key={source.id}>
                    <td>
                      {povLabel(source)}
                      {source.id === videoPov && <span className="pill">video</span>}
                      {source.id === audioPov && <span className="pill">sound</span>}
                    </td>
                    <td className="dim" style={{ textTransform: 'uppercase' }}>
                      {source.platform}
                    </td>
                    <td className="mono">
                      {range.coverage === 'none'
                        ? '—'
                        : `${formatTimecode(range.localStart, { millis: false })} → ${formatTimecode(
                            range.localEnd,
                            { millis: false }
                          )}`}
                    </td>
                    <td>
                      <StatusBadge
                        status={coverageStatus(range.coverage)}
                        label={
                          range.coverage === 'full'
                            ? 'Covered'
                            : range.coverage === 'partial'
                              ? 'Partly covered'
                              : range.coverage === 'none'
                                ? 'Not recording'
                                : 'Not aligned'
                        }
                      />
                    </td>
                    <td className="mono">
                      {range.confidence > 0 ? `${Math.round(range.confidence * 100)}%` : '—'}
                      {(clip.povOffsets?.[source.id] ?? 0) !== 0 && (
                        <span className="pill">
                          {clip.povOffsets![source.id] > 0 ? '+' : ''}
                          {clip.povOffsets![source.id].toFixed(2)}s
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Audio edits</h3>
          <p className="hint inline">
            Mute, bleep or turn down a range of this clip's sound, drawn against{' '}
            {povLabel(project.sources.find((s) => s.id === audioPov) ?? project.sources[0])}. Nothing changes
            until you export.
          </p>

          {edits.length === 0 ? (
            <p className="hint">No edits yet.</p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Start</th>
                  <th>End</th>
                  <th />
                  <th />
                </tr>
              </thead>
              <tbody>
                {edits.map((edit) => (
                  <AudioEditRow
                    key={edit.id}
                    edit={edit}
                    duration={clip.durationSeconds}
                    onChange={(patch) => patchAudioEdit(clip.id, edit.id, patch)}
                    onRemove={() => removeAudioEdit(clip.id, edit.id)}
                  />
                ))}
              </tbody>
            </table>
          )}

          <div className="rows" style={{ gridTemplateColumns: 'auto 1fr' }}>
            <Field label="New edit" htmlFor="prop-new-edit-kind">
              <Select
                id="prop-new-edit-kind"
                value={draftKind}
                options={(['mute', 'bleep', 'duck'] as AudioEditKind[]).map((k) => ({
                  value: k,
                  label: AUDIO_EDIT_KIND_LABEL[k]
                }))}
                onChange={(k) => setDraftKind(k as AudioEditKind)}
              />
            </Field>
            <Button
              icon="plus"
              onClick={() => {
                const start = 0
                const end = Math.min(2, clip.durationSeconds)
                addAudioEdit(clip.id, {
                  povId: audioPov,
                  kind: draftKind,
                  startSeconds: start,
                  endSeconds: end
                })
              }}
            >
              Add {AUDIO_EDIT_KIND_LABEL[draftKind].toLowerCase()}
            </Button>
          </div>
        </section>
      </div>
    </>
  )
}

function AudioEditRow({
  edit,
  duration,
  onChange,
  onRemove
}: {
  edit: AudioEdit
  duration: number
  onChange: (patch: Partial<AudioEdit>) => void
  onRemove: () => void
}): JSX.Element {
  return (
    <tr>
      <td>
        <Select
          size="compact"
          label="Kind"
          value={edit.kind}
          options={(['mute', 'bleep', 'duck'] as AudioEditKind[]).map((k) => ({
            value: k,
            label: AUDIO_EDIT_KIND_LABEL[k]
          }))}
          onChange={(k) => onChange({ kind: k as AudioEditKind })}
        />
      </td>
      <td>
        <TimeInput
          seconds={edit.startSeconds}
          max={edit.endSeconds}
          onCommit={(seconds) => onChange({ startSeconds: seconds })}
          label={`Start of ${AUDIO_EDIT_KIND_LABEL[edit.kind]}`}
        />
      </td>
      <td>
        <TimeInput
          seconds={edit.endSeconds}
          max={duration}
          onCommit={(seconds) => onChange({ endSeconds: seconds })}
          label={`End of ${AUDIO_EDIT_KIND_LABEL[edit.kind]}`}
        />
      </td>
      <td>
        {edit.kind === 'duck' && (
          <Input
            type="number"
            value={String(edit.gainDb ?? -18)}
            style={{ width: 64 }}
            aria-label="Decibels"
            onChange={(e) => onChange({ gainDb: Number(e.target.value) })}
          />
        )}
      </td>
      <td>
        <IconButton icon="trash" label="Remove this edit" onClick={onRemove} />
      </td>
    </tr>
  )
}
