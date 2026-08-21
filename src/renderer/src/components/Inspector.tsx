import { useRef } from 'react'
import { formatTimecode } from '@shared/time'
import { DEFAULT_PIP_TRANSFORM, isIdentityTransform } from '@shared/timeline'
import type { TimelineItem, TimelineTransform } from '@shared/types'
import { useStore } from '../store.js'
import { povLabel } from '@shared/pov'
import { Button, Checkbox, EmptyState, Field, IconButton, Slider } from '../ui/index.js'

const IDENTITY: TimelineTransform = { x: 0, y: 0, scale: 1, rotation: 0 }
/** A drag or a burst of keystrokes within this long counts as one undo step. */
const HISTORY_COALESCE_MS = 500

/**
 * Context-sensitive properties for whatever is selected on the timeline —
 * nothing here re-derives what's already true in the timeline data; every
 * control reads and writes `TimelineItem` fields directly through
 * `patchTimelineItem`, so the Inspector can never drift from what actually
 * exports.
 */
export default function Inspector({ onGoToVideo }: { onGoToVideo: () => void }): JSX.Element {
  const project = useStore((s) => s.project)
  const selectedItemId = useStore((s) => s.selectedTimelineItemId)
  const patchTimelineItem = useStore((s) => s.patchTimelineItem)
  const playhead = useStore((s) => s.timelinePlayheadSeconds)
  const addTimelineMarker = useStore((s) => s.addTimelineMarker)
  const removeTimelineMarker = useStore((s) => s.removeTimelineMarker)
  const patchTimelineMarker = useStore((s) => s.patchTimelineMarker)
  const setTimelinePlayhead = useStore((s) => s.setTimelinePlayhead)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const selectClip = useStore((s) => s.selectClip)
  const timeline = project?.timeline

  const item = timeline?.items.find((i) => i.id === selectedItemId) ?? null

  // A slider fires its onChange on every pixel of drag, and a textarea on
  // every keystroke — pushing history on each of those would turn one drag
  // into dozens of undo steps. The first change of a burst pushes history;
  // anything else within HISTORY_COALESCE_MS of the last one rides along on
  // the same undo step, the same way TimelineEditor's own drag handlers only
  // commit once, on release.
  const historyTimerRef = useRef<number | null>(null)
  const patchWithHistory = (itemId: string, patch: Partial<TimelineItem>): void => {
    if (historyTimerRef.current === null) useStore.getState().pushHistory()
    else window.clearTimeout(historyTimerRef.current)
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null
    }, HISTORY_COALESCE_MS)
    patchTimelineItem(itemId, patch)
  }

  if (!timeline) return <EmptyState icon="settings" title="Open or create a project to see its properties." />

  if (!item) {
    const markers = [...timeline.markers].sort((a, b) => a.timeSeconds - b.timeSeconds)
    return (
      <div className="inspector">
        <section className="inspector-section">
          <h4>Sequence markers</h4>
          <Button
            size="compact"
            icon="flag"
            onClick={() => addTimelineMarker(playhead)}
            title="Add a marker at the playhead"
          >
            Add marker at playhead
          </Button>
          {markers.length === 0 ? (
            <p className="hint">No markers yet — drop one to flag a cut, a line, or a spot to fix later.</p>
          ) : (
            <div className="inspector-markers">
              {markers.map((m) => (
                <div className="inspector-marker" key={m.id}>
                  <button className="inspector-marker-jump" onClick={() => setTimelinePlayhead(m.timeSeconds)}>
                    <span className="mono">{formatTimecode(m.timeSeconds, { millis: false })}</span>
                    <input
                      className="inspector-marker-name"
                      value={m.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => patchTimelineMarker(m.id, { name: e.target.value })}
                    />
                  </button>
                  <IconButton
                    icon="trash"
                    size="compact"
                    label={`Delete ${m.name}`}
                    onClick={() => removeTimelineMarker(m.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
        <EmptyState
          icon="settings"
          title="Nothing selected"
          description="Select a clip on the timeline to see its transform, opacity and watermark."
        />
      </div>
    )
  }

  const source = project?.sources.find((s) => s.id === item.sourceId)
  const clip = item.sourceClipId ? project?.clips.find((c) => c.id === item.sourceClipId) : undefined

  const revealSource = (): void => {
    setActiveSource(item.sourceId)
    if (clip) selectClip(clip.id)
    onGoToVideo()
  }

  const t = item.transform ?? IDENTITY
  const setTransform = (patch: Partial<TimelineTransform>): void =>
    patchWithHistory(item.id, { transform: { ...t, ...patch } })

  return (
    <div className="inspector">
      <section className="inspector-section">
        <h4>{clip ? clip.name : 'Untitled'}</h4>
        <p className="hint">
          {source ? povLabel(source) : 'Unknown POV'} ·{' '}
          {formatTimecode(item.sourceStartSeconds, { millis: false })} →{' '}
          {formatTimecode(item.sourceEndSeconds, { millis: false })}
        </p>
        <Button size="compact" icon="external" onClick={revealSource}>
          Reveal source
        </Button>
      </section>

      {item.kind === 'video' ? (
        <>
          <section className="inspector-section">
            <h4>Picture-in-picture</h4>
            <Field label="This item" layout="row">
              <Checkbox
                checked={Boolean(item.pip)}
                onChange={(checked) =>
                  patchWithHistory(item.id, {
                    pip: checked ? true : undefined,
                    // Starting from identity (or nothing) would otherwise
                    // composite a full-frame inset directly over the
                    // background — turning it on jumps straight to a
                    // sensible corner so what the sliders below show is
                    // what actually renders.
                    transform:
                      checked && isIdentityTransform(item.transform) ? DEFAULT_PIP_TRANSFORM : item.transform
                  })
                }
                label={
                  item.pip
                    ? 'Composited as an inset over whatever it overlaps'
                    : 'Off — this item just wins outright when it overlaps another'
                }
              />
            </Field>
          </section>

          <section className="inspector-section">
            <div className="inspector-section-head">
              <h4>{item.pip ? 'Inset position & size' : 'Transform'}</h4>
              <IconButton
                icon="refresh"
                size="compact"
                label="Reset transform"
                onClick={() => patchWithHistory(item.id, { transform: undefined })}
              />
            </div>
            <Slider
              label="X"
              value={t.x}
              min={-1}
              max={1}
              step={0.01}
              format={(v) => v.toFixed(2)}
              onChange={(x) => setTransform({ x })}
            />
            <Slider
              label="Y"
              value={t.y}
              min={-1}
              max={1}
              step={0.01}
              format={(v) => v.toFixed(2)}
              onChange={(y) => setTransform({ y })}
            />
            <Slider
              label="Scale"
              value={t.scale}
              min={0.1}
              max={3}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(scale) => setTransform({ scale })}
            />
            <Slider
              label="Rotation"
              value={t.rotation}
              min={-180}
              max={180}
              step={1}
              format={(v) => `${v}°`}
              onChange={(rotation) => setTransform({ rotation })}
            />
          </section>

          <section className="inspector-section">
            <div className="inspector-section-head">
              <h4>Opacity</h4>
              <IconButton
                icon="refresh"
                size="compact"
                label="Reset opacity"
                onClick={() => patchWithHistory(item.id, { opacity: undefined })}
              />
            </div>
            <Slider
              label="Opacity"
              value={item.opacity ?? 1}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(opacity) => patchWithHistory(item.id, { opacity })}
            />
          </section>

          <section className="inspector-section">
            <h4>Watermark</h4>
            <Field label="This item" layout="row">
              <Checkbox
                checked={item.watermarkOverride !== 'none'}
                onChange={(checked) => patchWithHistory(item.id, { watermarkOverride: checked ? undefined : 'none' })}
                label={item.watermarkOverride === 'none' ? 'Off for this item' : "Inherits the POV's saved watermark"}
              />
            </Field>
          </section>
        </>
      ) : (
        <section className="inspector-section">
          <div className="inspector-section-head">
            <h4>Audio</h4>
            <IconButton
              icon="refresh"
              size="compact"
              label="Reset volume"
              onClick={() => patchWithHistory(item.id, { volume: undefined })}
            />
          </div>
          <Slider
            label="Volume"
            value={item.volume ?? 1}
            min={0}
            max={2}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(volume) => patchWithHistory(item.id, { volume })}
          />
          <Field label="Muted" layout="row">
            <Checkbox
              checked={Boolean(item.muted)}
              onChange={(muted) => patchWithHistory(item.id, { muted })}
              label={item.muted ? 'Muted' : 'Audible'}
            />
          </Field>
        </section>
      )}

      {item.note !== undefined && (
        <section className="inspector-section">
          <h4>Note</h4>
          <textarea
            className="inspector-note"
            value={item.note}
            onChange={(e) => patchWithHistory(item.id, { note: e.target.value })}
          />
        </section>
      )}
      {item.note === undefined && (
        <Button size="compact" icon="plus" onClick={() => patchWithHistory(item.id, { note: '' })}>
          Add note
        </Button>
      )}
    </div>
  )
}
