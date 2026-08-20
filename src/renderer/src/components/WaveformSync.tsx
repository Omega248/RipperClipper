import { useCallback, useEffect, useRef, useState } from 'react'
import { formatTimecode } from '@shared/time'
import { isSynced, localToEvent, eventToLocal } from '@shared/sync'
import { alignByAudio } from '@shared/align'
import type { AlignmentResult } from '@shared/align'
import type { ClipSegment } from '@shared/types'
import type { PeaksReply } from '@shared/ipc'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { message, title } from './QualityPanel.js'
import { Button, Dialog, EmptyState, Notice, Select } from '../ui/index.js'

interface Props {
  onClose: () => void
  /**
   * When present, corrections apply to THIS clip only and the window is centred
   * on it. Without it, the correction moves the whole POV.
   */
  clip?: ClipSegment | null
}

const WINDOW_SECONDS = 30

/**
 * Manual synchronisation by ear and eye.
 *
 * Two POVs' waveforms are drawn over the same stretch of real-world time. When
 * platform metadata is off — a stream that started late, a VOD trimmed at the
 * front — the same gunshot appears in both lanes at visibly different places.
 * Drag the lower waveform until the shapes line up and commit the offset; the
 * mapping becomes manual, which the automatic solver will not overwrite.
 */
export default function WaveformSync({ onClose, clip }: Props): JSX.Element {
  const sources = useStore((s) => s.project?.sources) ?? []
  const activeSourceId = useStore((s) => s.activeSourceId)
  const nudgeSync = useStore((s) => s.nudgeSync)
  const setClipPovOffset = useStore((s) => s.setClipPovOffset)
  const toast = useStore((s) => s.toast)
  const [match, setMatch] = useState<AlignmentResult | null>(null)

  const reference = sources.find((s) => s.id === activeSourceId) ?? null
  const others = sources.filter((s) => s.id !== activeSourceId)
  const [targetId, setTargetId] = useState<string | null>(others[0]?.id ?? null)
  const target = sources.find((s) => s.id === targetId) ?? null

  const [refPeaks, setRefPeaks] = useState<PeaksReply | null>(null)
  const [targetPeaks, setTargetPeaks] = useState<PeaksReply | null>(null)
  const [offset, setOffset] = useState(0)
  const existingOffset = clip && target ? (clip.povOffsets?.[target.id] ?? 0) : 0
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The window is pinned to the moment the panel was opened. Following
   * `currentTime` live would re-fetch and re-decode both POVs several times a
   * second while the video plays — which is exactly what starved the player of
   * bandwidth and made playback stutter. "Reload window" re-pins it.
   */
  const [centre, setCentre] = useState(() =>
    clip ? (clip.startSeconds + clip.endSeconds) / 2 : useStore.getState().currentTime
  )

  const refCanvas = useRef<HTMLCanvasElement | null>(null)
  const targetCanvas = useRef<HTMLCanvasElement | null>(null)
  const drag = useRef<{ x: number; from: number } | null>(null)

  const eventTime =
    reference?.syncMapping && isSynced(reference.syncMapping)
      ? localToEvent(reference.syncMapping, centre)
      : null

  const load = useCallback(async (): Promise<void> => {
    if (!reference || !target || eventTime === null) return
    setLoading(true)
    setError(null)
    setOffset(0)
    try {
      const half = WINDOW_SECONDS / 2
      const refStart = Math.max(0, centre - half)
      const targetLocal =
        target.syncMapping && isSynced(target.syncMapping)
          ? eventToLocal(target.syncMapping, eventTime)
          : null
      if (targetLocal === null) {
        setError(
          `${target.title} has no real-world timing at all, so there is nothing to correct yet. Load a POV whose platform reports a start time, or set this one's timing first.`
        )
        return
      }
      const [a, b] = await Promise.all([
        window.api.audioPeaks({
          source: reference,
          startSeconds: refStart,
          endSeconds: refStart + WINDOW_SECONDS,
          buckets: 900
        }),
        window.api.audioPeaks({
          source: target,
          startSeconds: Math.max(0, targetLocal - half),
          endSeconds: Math.max(0, targetLocal - half) + WINDOW_SECONDS,
          buckets: 900
        })
      ])
      setRefPeaks(a)
      setTargetPeaks(b)

      // Try to line them up by sound before the editor has to. A confident
      // match is applied straight away; a weak one is reported rather than
      // guessed at, and the export padding keeps that case safe.
      const secondsPerBucket = WINDOW_SECONDS / Math.max(1, a.rms.length)
      const found = alignByAudio(a.rms, b.rms, secondsPerBucket)
      setMatch(found)
      if (found.confident) setOffset(found.offsetSeconds)
    } catch (err) {
      setError(`${title(err, 'Could not read the audio')}: ${message(err)}`)
    } finally {
      setLoading(false)
    }
    // `centre` is deliberately the only time input: see the note on its state.
  }, [reference, target, eventTime, centre])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    draw(refCanvas.current, refPeaks, 0, 'var(--accent)')
  }, [refPeaks])
  useEffect(() => {
    draw(targetCanvas.current, targetPeaks, offset / WINDOW_SECONDS, 'var(--data-clip-edge)')
  }, [targetPeaks, offset])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!targetPeaks) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, from: offset }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drag.current) return
    const width = e.currentTarget.getBoundingClientRect().width
    const seconds = ((e.clientX - drag.current.x) / width) * WINDOW_SECONDS
    setOffset(round3(drag.current.from + seconds))
  }
  const endDrag = (): void => {
    drag.current = null
  }

  const apply = (): void => {
    if (!target || offset === 0) return
    // Dragging the target waveform right means its audio happens later than we
    // thought, so its footage sits later on the event clock.
    const label = povLabel(target, sources.indexOf(target))
    if (clip) {
      setClipPovOffset(clip.id, target.id, existingOffset - offset)
      toast({
        kind: 'success',
        title: `Aligned for "${clip.name}"`,
        message: `${label} moved ${offset > 0 ? '+' : ''}${offset.toFixed(3)}s for this clip only. Other clips keep their own alignment.`
      })
    } else {
      nudgeSync(target.id, -offset)
      toast({
        kind: 'success',
        title: 'Timing corrected by hand',
        message: `${label} moved ${offset > 0 ? '+' : ''}${offset.toFixed(3)}s. Every clip was re-mapped.`
      })
    }
    onClose()
  }

  return (
    <Dialog
      title={clip ? `Align POVs for "${clip.name}"` : 'Align POVs'}
      description="Drag one angle's sound until it lines up with the other. Nothing about the recordings changes — only where Ripper Clipper thinks they sit on the shared clock."
      size="large"
      onClose={onClose}
    >
      {!reference || others.length === 0 ? (
        <EmptyState
          icon="waveform"
          title="Only one POV loaded"
          description="Load a second angle of the same event to line it up against this one."
        />
      ) : eventTime === null ? (
        <EmptyState
          icon="clock"
          title="No shared clock yet"
          description="The angle you are watching has no known real-world start time, so there is nothing to compare against."
        />
      ) : (
        <>
          <div className="wave-controls">
            <label htmlFor="wave-target">Line up</label>
            <Select
              id="wave-target"
              value={targetId ?? ''}
              options={others.map((s, i) => ({ value: s.id, label: povLabel(s, i) }))}
              onChange={setTargetId}
            />
            <span className="hint inline">
              against {povLabel(reference, sources.indexOf(reference))}, {WINDOW_SECONDS}s around{' '}
              {formatTimecode(centre, { millis: false })}
            </span>
            <span className="spacer" />
            <Button
              size="compact"
              icon="refresh"
              loading={loading}
              title="Re-read both angles around where the player is now"
              onClick={() => setCentre(useStore.getState().currentTime)}
            >
              Reload at playhead
            </Button>
          </div>

          {error && <Notice tone="warning">{error}</Notice>}

          {match && !loading && (
            <Notice tone={match.confident ? 'success' : 'warning'}>
              {match.confident ? (
                <>
                  <strong>Sound matched</strong> at {match.offsetSeconds > 0 ? '+' : ''}
                  {match.offsetSeconds.toFixed(3)}s. Applied below — drag if you disagree.
                </>
              ) : (
                <>
                  <strong>No confident match</strong>. Line it up by hand, or leave it: exports from
                  an unsure angle are padded at both ends so the moment is not cut off.
                </>
              )}
            </Notice>
          )}

          <div className="wave-lane">
            <span className="wave-name">{povLabel(reference, sources.indexOf(reference))}</span>
            <canvas ref={refCanvas} width={900} height={90} className="wave" />
          </div>

          <div className="wave-lane">
            <span className="wave-name">
              {target ? povLabel(target, sources.indexOf(target)) : ''}
            </span>
            <canvas
              ref={targetCanvas}
              width={900}
              height={90}
              className="wave draggable"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              title="Drag left or right until the shapes line up"
            />
          </div>

          <div className="wave-actions">
            <span className="mono offset">
              {offset > 0 ? '+' : ''}
              {offset.toFixed(3)}s
              {existingOffset !== 0 && (
                <span className="hint inline">
                  {' '}
                  (already at {existingOffset > 0 ? '+' : ''}
                  {existingOffset.toFixed(3)}s)
                </span>
              )}
            </span>
            {[-1, -0.1, -0.01, 0.01, 0.1, 1].map((step) => (
              <Button key={step} size="compact" onClick={() => setOffset((o) => round3(o + step))}>
                {step > 0 ? '+' : ''}
                {step}s
              </Button>
            ))}
            <Button size="compact" variant="ghost" onClick={() => setOffset(0)}>
              Reset
            </Button>
            <span className="spacer" />
            <Button variant="primary" onClick={apply} disabled={offset === 0}>
              Apply to {target ? povLabel(target, sources.indexOf(target)) : 'this POV'}
            </Button>
          </div>

          <p className="hint">
            {clip ? (
              <>
                This corrects the angle for <strong>{clip.name}</strong> only. Every other clip keeps
                the alignment it already has.
              </>
            ) : (
              <>
                This sets the angle&apos;s timing by hand, which automatic alignment will not
                overwrite, and re-maps every existing clip immediately.
              </>
            )}
          </p>
        </>
      )}
    </Dialog>
  )
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Peak envelope with the louder RMS body inside it, shifted by `shift` (0..1 of width). */
function draw(
  canvas: HTMLCanvasElement | null,
  data: PeaksReply | null,
  shift: number,
  colour: string
): void {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)

  const styles = getComputedStyle(document.documentElement)
  const resolve = (v: string): string =>
    v.startsWith('var(') ? styles.getPropertyValue(v.slice(4, -1)).trim() || 'currentColor' : v

  ctx.strokeStyle = resolve('var(--border)')
  ctx.beginPath()
  ctx.moveTo(0, height / 2)
  ctx.lineTo(width, height / 2)
  ctx.stroke()

  if (!data || data.peaks.length === 0) return

  const dx = shift * width
  const step = width / data.peaks.length
  const mid = height / 2

  ctx.fillStyle = resolve(colour)
  ctx.globalAlpha = 0.35
  for (let i = 0; i < data.peaks.length; i++) {
    const h = data.peaks[i] * (height / 2 - 2)
    ctx.fillRect(i * step + dx, mid - h, Math.max(1, step), h * 2)
  }
  ctx.globalAlpha = 1
  for (let i = 0; i < data.rms.length; i++) {
    const h = data.rms[i] * (height / 2 - 2)
    ctx.fillRect(i * step + dx, mid - h, Math.max(1, step), h * 2)
  }
}
