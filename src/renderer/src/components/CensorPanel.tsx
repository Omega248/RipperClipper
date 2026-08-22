import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_PROFANITY } from '@shared/profanity'
import type { CensorAction, ProfanityHit } from '@shared/profanity'
import type { AnalysisProgress } from '@shared/transcription'
import { clipRangeInPov } from '@shared/povMapping'
import { formatTimecode } from '@shared/time'
import type { ClipSegment } from '@shared/types'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { message, title } from './QualityPanel.js'
import { Badge, Button, EmptyState, Notice, ProgressBar, Select } from '../ui/index.js'

/**
 * Reviewing what to censor.
 *
 * Every POV is read separately and automatically, so this list is usually
 * already populated by the time it is opened. Nothing here silences anything
 * on its own: each suggestion is accepted, dismissed or nudged by hand,
 * because a word muted that was never said is a hole in someone's dialogue
 * and costs more than the one it saves.
 *
 * Accepting a hit writes an ordinary `AudioEdit` against that POV, so from
 * that point on it is the same object the waveform editor draws and the
 * exporter applies — there is no separate censor pipeline to keep in step.
 */

/** How far a nudge moves an edge, in seconds. */
const NUDGE = 0.1

export default function CensorPanel({ clip }: { clip: ClipSegment }): JSX.Element {
  const sources = useStore((s) => s.project?.sources) ?? []
  const addAudioEdit = useStore((s) => s.addAudioEdit)
  const patchAudioEdit = useStore((s) => s.patchAudioEdit)
  const removeAudioEdit = useStore((s) => s.removeAudioEdit)
  const toast = useStore((s) => s.toast)

  const [ready, setReady] = useState<{ available: boolean; reason: string | null } | null>(null)
  const [hits, setHits] = useState<ProfanityHit[] | null>(null)
  const [progress, setProgress] = useState<Record<string, AnalysisProgress>>({})
  const [action, setAction] = useState<CensorAction>('bleep')
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  // Only POVs that actually cover this moment can have said anything in it.
  const covering = useMemo(
    () => sources.filter((s) => clipRangeInPov(clip, s).coverage !== 'none'),
    [sources, clip]
  )
  const sourceIds = useMemo(() => covering.map((s) => s.id), [covering])

  const refreshHits = useCallback(async (): Promise<void> => {
    try {
      setHits(await window.api.clipHits({ clipId: clip.id, sourceIds }))
    } catch {
      setHits([])
    }
  }, [clip.id, sourceIds])

  useEffect(() => {
    void window.api.censorReady().then(setReady)
  }, [])

  useEffect(() => {
    void refreshHits()
  }, [refreshHits])

  useEffect(() => {
    return window.api.onClipAnalysisProgress((p) => {
      if (p.clipId !== clip.id) return
      setProgress((prev) => ({ ...prev, [p.sourceId]: p }))
      // A POV finishing is new information; fold it in as it lands rather
      // than waiting for the whole sweep.
      if (p.stage === 'complete') void refreshHits()
    })
  }, [clip.id, refreshHits])

  /** Read every covering POV. Safe to press repeatedly — done POVs are skipped. */
  const analyseAll = async (): Promise<void> => {
    setBusy(true)
    try {
      for (const source of covering) {
        const range = clipRangeInPov(clip, source)
        if (range.coverage === 'none') continue
        await window.api.clipAnalyse({
          clipId: clip.id,
          source,
          startSeconds: range.localStart,
          endSeconds: range.localEnd
        })
      }
      await refreshHits()
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not read the clip'), message: message(err) })
    } finally {
      setBusy(false)
    }
  }

  const keyOf = (hit: ProfanityHit): string => `${hit.sourceId}:${hit.startSeconds.toFixed(3)}`

  /**
   * The edit already covering a hit, if the editor accepted it.
   *
   * Matched by overlap rather than by a stored id, so an edit the editor
   * later dragged on the waveform is still recognised as this hit's — the
   * two views must never disagree about whether a word is handled.
   */
  const editFor = (hit: ProfanityHit): { id: string; kind: string } | undefined =>
    (clip.audioEdits ?? []).find(
      (e) =>
        e.povId === hit.sourceId &&
        e.endSeconds > hit.startSeconds + 0.001 &&
        e.startSeconds < hit.endSeconds - 0.001
    )

  const accept = (hit: ProfanityHit, kind: CensorAction): void => {
    const existing = editFor(hit)
    if (existing) {
      patchAudioEdit(clip.id, existing.id, { kind })
      return
    }
    addAudioEdit(clip.id, {
      povId: hit.sourceId,
      kind,
      startSeconds: hit.startSeconds,
      endSeconds: hit.endSeconds,
      label: hit.word
    })
  }

  const nudge = (hit: ProfanityHit, edge: 'start' | 'end', delta: number): void => {
    const existing = editFor(hit)
    if (!existing) return
    const edit = (clip.audioEdits ?? []).find((e) => e.id === existing.id)
    if (!edit) return
    const next =
      edge === 'start'
        ? { startSeconds: Math.max(0, Math.min(edit.endSeconds - 0.05, edit.startSeconds + delta)) }
        : { endSeconds: Math.max(edit.startSeconds + 0.05, edit.endSeconds + delta) }
    patchAudioEdit(clip.id, existing.id, next)
  }

  const visible = (hits ?? []).filter((h) => !dismissed.has(keyOf(h)))
  const accepted = visible.filter((h) => editFor(h) !== undefined).length
  const running = Object.values(progress).filter(
    (p) => p.stage !== 'complete' && p.stage !== 'failed' && p.stage !== 'skipped'
  )

  if (ready && !ready.available) {
    return (
      <div className="censor-panel">
        <Notice tone="info" title="Reading clips is not set up yet">
          {ready.reason} Settings → Setup installs the speech engine (9MB); the model is chosen
          there too.
        </Notice>
      </div>
    )
  }

  return (
    <div className="censor-panel">
      <div className="censor-head">
        <span className="hint">
          {hits === null
            ? 'Checking…'
            : visible.length === 0
              ? 'Nothing flagged.'
              : `${visible.length} flagged · ${accepted} handled`}
        </span>
        <span className="spacer" />
        <Select
          size="compact"
          label="What to do"
          value={action}
          options={[
            { value: 'bleep', label: 'Bleep' },
            { value: 'mute', label: 'Silence' }
          ]}
          onChange={(v) => setAction(v as CensorAction)}
        />
        <Button size="compact" icon="refresh" loading={busy} onClick={() => void analyseAll()}>
          Read POVs
        </Button>
        <Button
          size="compact"
          variant="primary"
          disabled={visible.length === 0}
          title="Apply the chosen action to everything still flagged"
          onClick={() => visible.forEach((h) => accept(h, action))}
        >
          {action === 'bleep' ? 'Bleep all' : 'Silence all'}
        </Button>
      </div>

      {running.length > 0 && (
        <div className="censor-running">
          <ProgressBar
            value={
              Object.values(progress).reduce((sum, p) => sum + p.fraction, 0) /
              Math.max(1, Object.values(progress).length)
            }
            label="Reading POVs"
          />
          <span className="hint">
            Reading {running.length} POV{running.length === 1 ? '' : 's'}…
          </span>
        </div>
      )}

      {hits !== null && visible.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing flagged."
          description="Either nothing on the list was said, or these POVs have not been read yet."
        />
      ) : (
        <ul className="censor-list">
          {visible.map((hit) => {
            const source = covering.find((s) => s.id === hit.sourceId)
            const edit = editFor(hit)
            return (
              <li key={keyOf(hit)} className={`censor-row${edit ? ' is-handled' : ''}`}>
                <div className="censor-row-main">
                  <div className="censor-row-head">
                    <strong>{hit.word}</strong>
                    <Badge>{source ? povLabel(source, covering.indexOf(source)) : hit.sourceId}</Badge>
                    <span className="mono">{formatTimecode(hit.startSeconds, { millis: false })}</span>
                    {/* Whisper times segments, not words, so a long line's
                        position is an estimate — say so rather than implying
                        a precision that is not there. */}
                    {hit.timingConfidence === 'estimated' && (
                      <Badge tone="warning">check timing</Badge>
                    )}
                    {edit && <Badge tone="success">{edit.kind === 'bleep' ? 'Bleeped' : 'Silenced'}</Badge>}
                  </div>
                  <div className="censor-row-context ellipsis" title={hit.context}>
                    {hit.context}
                  </div>
                </div>

                <div className="censor-row-actions">
                  {edit ? (
                    <>
                      <span className="censor-nudge">
                        <Button size="compact" onClick={() => nudge(hit, 'start', -NUDGE)} title="Start earlier">
                          ←
                        </Button>
                        <Button size="compact" onClick={() => nudge(hit, 'start', NUDGE)} title="Start later">
                          →
                        </Button>
                        <span className="mono">
                          {(hit.endSeconds - hit.startSeconds).toFixed(2)}s
                        </span>
                        <Button size="compact" onClick={() => nudge(hit, 'end', -NUDGE)} title="End earlier">
                          ←
                        </Button>
                        <Button size="compact" onClick={() => nudge(hit, 'end', NUDGE)} title="End later">
                          →
                        </Button>
                      </span>
                      <Button size="compact" onClick={() => removeAudioEdit(clip.id, edit.id)}>
                        Undo
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="compact" onClick={() => accept(hit, 'bleep')}>
                        Bleep
                      </Button>
                      <Button size="compact" onClick={() => accept(hit, 'mute')}>
                        Silence
                      </Button>
                      <Button
                        size="compact"
                        variant="ghost"
                        title="Not actually a problem — hide it"
                        onClick={() => setDismissed((prev) => new Set(prev).add(keyOf(hit)))}
                      >
                        Ignore
                      </Button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="hint">
        Matching {DEFAULT_PROFANITY.length} words. Every suggestion is yours to accept, ignore or
        adjust — nothing is silenced on its own.
      </p>
    </div>
  )
}
