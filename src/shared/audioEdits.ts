/**
 * Non-destructive, hand-made audio edits.
 *
 * An edit is an instruction, never a change to the source: "mute 12.4→12.9",
 * "bleep 30.1→30.6", "turn 60→75 down". They live on the clip, survive
 * saving, and are applied only when a file is written — so undoing one later
 * costs nothing and the original VOD is never touched.
 *
 * Nothing detects or proposes these: an edit the editor placed by hand is
 * authoritative the moment it exists, the same way a marker or a trim point
 * is.
 */

export type AudioEditKind =
  /** Silence the range. */
  | 'mute'
  /** Silence the range and lay a tone over it. */
  | 'bleep'
  /** Drop the level of the range without silencing it. */
  | 'duck'

export interface AudioEdit {
  id: string
  /**
   * The POV this edit was drawn against. Times are relative to that POV's own
   * cut of the clip, so an edit only ever applies to that POV's export.
   */
  povId?: string
  kind: AudioEditKind
  /** Seconds within the clip's own timeline: 0 is the start of the clip. */
  startSeconds: number
  endSeconds: number
  /** Decibels for `duck`; defaults to -18. */
  gainDb?: number
  /** What the editor called it, for their own list — never shown elsewhere. */
  label?: string
}

export const DEFAULT_BLEEP_HZ = 1000
/** Amplitude of the bleep, 0..1. Loud enough to mask, not loud enough to hurt. */
export const BLEEP_AMPLITUDE = 0.3
/** Fade at each edge, so a mute does not click. */
export const EDGE_FADE_SECONDS = 0.012

/**
 * Small enough frames that a gate lands where it was asked to, rather than at
 * the next frame boundary. `volume`'s `enable=` expression is evaluated once
 * per audio frame, not per sample — at FFmpeg's default frame size that
 * quantises every gate to the frame boundary, putting a mute tens of
 * milliseconds away from where it was drawn. Cutting the frame to 128 samples
 * brings the gate to within ~3 ms of where it was asked for.
 */
export const GATE_RESOLUTION = 'asetnsamples=n=128:p=0'

export interface FilterPlan {
  /** Complete `-filter_complex` graph, or null when nothing is to be done. */
  filterComplex: string | null
  /** Label of the processed audio stream, for `-map`. */
  outputLabel: string
  /** One line per edit, for the export notes. */
  notes: string[]
}

/**
 * Build the FFmpeg graph for a set of edits.
 *
 * `volume` with `enable=` is used for the gain changes because it is applied
 * per sample against the timeline, so several ranges compose without splitting
 * the audio into pieces and concatenating it — which is where clicks and drift
 * come from. Bleeps are a generated tone mixed in, gated to the same range.
 */
export function buildAudioFilter(
  edits: AudioEdit[],
  opts: {
    inputLabel?: string
    durationSeconds: number
    /** Tone frequency for bleeps, in hertz. */
    bleepHz?: number
    /** Bleep amplitude, 0..1. */
    bleepAmplitude?: number
    /** Flat volume multiplier for the whole range, applied before any edit. 1 = unchanged. */
    gain?: number
  }
): FilterPlan {
  const active = edits
    .filter((e) => e.endSeconds > e.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds)
  const input = opts.inputLabel ?? '0:a'
  const gain = opts.gain ?? 1
  const gainNotes = gain !== 1 ? [`Volume set to ${Math.round(gain * 100)}%`] : []
  if (active.length === 0) {
    if (gain === 1) return { filterComplex: null, outputLabel: input, notes: [] }
    return {
      filterComplex: `[${input}]volume=${gain.toFixed(4)}[gained]`,
      outputLabel: 'gained',
      notes: gainNotes
    }
  }

  const hz = opts.bleepHz ?? DEFAULT_BLEEP_HZ
  const amplitude = opts.bleepAmplitude ?? BLEEP_AMPLITUDE
  const notes: string[] = [...gainNotes]
  const chain: string[] = gain !== 1 ? [`volume=${gain.toFixed(4)}`] : []
  const bleeps: AudioEdit[] = []

  for (const edit of active) {
    const from = Math.max(0, edit.startSeconds)
    const to = Math.min(opts.durationSeconds, edit.endSeconds)
    if (to <= from) continue
    const between = `between(t,${from.toFixed(3)},${to.toFixed(3)})`
    const what = edit.label ?? edit.kind

    if (edit.kind === 'duck') {
      const db = edit.gainDb ?? -18
      chain.push(`volume=enable='${between}':volume=${db}dB`)
      notes.push(`Lowered ${from.toFixed(2)}–${to.toFixed(2)}s by ${Math.abs(db)} dB (${what})`)
      continue
    }

    chain.push(`volume=enable='${between}':volume=0`)
    if (edit.kind === 'bleep') bleeps.push({ ...edit, startSeconds: from, endSeconds: to })
    notes.push(
      `${edit.kind === 'bleep' ? 'Bleeped' : 'Silenced'} ${from.toFixed(2)}–${to.toFixed(2)}s (${what})`
    )
  }

  if (chain.length === 0) return { filterComplex: null, outputLabel: input, notes }

  const parts: string[] = []
  /*
   * The tone is EVALUATED OVER THE EXISTING STREAM, not generated beside it
   * and mixed in.
   *
   * The obvious shape — an `aevalsrc` per bleep, mixed over the silenced
   * range with `amix` — deadlocks on ffmpeg 7: a filtergraph source has no
   * input to wait on, so it is always ready to produce, and when the video
   * encoder is slow enough to push back (anything from `-preset medium` up)
   * the graph never settles and the export simply never finishes. Measured on
   * the same command and the same clip: 0.6s on ffmpeg 4.4, still running
   * after a hundred seconds on 7.0.2. An export that hangs forever is far
   * worse than one that is slow, and the app does not control which ffmpeg
   * binary it is pointed at.
   *
   * `aeval` is an ordinary filter: it is driven by the samples arriving from
   * the clip, so there is no independent source to schedule and no mix to
   * keep in step. It replaces the samples in the gated range outright, which
   * is what a bleep is anyway — the `volume=0` above already silenced them.
   */
  if (bleeps.length > 0) {
    const ranges = bleeps.map((bleep) => {
      const from = bleep.startSeconds.toFixed(3)
      const to = bleep.endSeconds.toFixed(3)
      // A hard-edged tone clicks. The ramp is folded into the amplitude
      // expression rather than added as `afade` filters, because a fade
      // filter applies to the whole stream and this must only touch the
      // gated range.
      const fade = Math.max(
        0.001,
        Math.min(EDGE_FADE_SECONDS, (bleep.endSeconds - bleep.startSeconds) / 4)
      ).toFixed(3)
      return {
        gate: `between(t,${from},${to})`,
        // Zero outside the range, ramping to one over `fade` at each edge.
        envelope: `between(t,${from},${to})*clip(min((t-${from})/${fade},(${to}-t)/${fade}),0,1)`
      }
    })

    // Summed rather than or-ed: `enable` treats any non-zero value as true,
    // and the ranges never overlap, so a sum is both correct and shorter.
    const gate = ranges.map((r) => r.gate).join('+')
    const envelope = ranges.map((r) => r.envelope).join('+')
    chain.push(
      `aeval='${amplitude}*(${envelope})*sin(2*PI*${hz}*t)':c=same:enable='${gate}'`
    )
  }

  /*
   * `asetpts=PTS-STARTPTS` first, and it is not optional either.
   *
   * A precise-mode cut seeks in two stages — an approximate input seek, then
   * an accurate trim — and neither resets the stream's own timestamps to
   * zero. Every edit's `startSeconds`/`endSeconds` are clip-relative (0 is
   * the start of the clip), so `between(t, …)` below is comparing against
   * the wrong clock unless the first frame that actually reaches this filter
   * is redefined as t=0. Measured without this: the gate never once matched
   * a real frame, and the "mute" silently muted nothing.
   */
  parts.push(`[${input}]${['asetpts=PTS-STARTPTS', GATE_RESOLUTION, ...chain].join(',')}[edited]`)

  return { filterComplex: parts.join(';'), outputLabel: 'edited', notes }
}

/** Edits belonging to one POV. Edits with no POV belong to the clip's own. */
export function editsForPov(
  edits: AudioEdit[] | undefined,
  povId: string,
  fallbackPovId: string
): AudioEdit[] {
  return (edits ?? []).filter((edit) => (edit.povId ?? fallbackPovId) === povId)
}
