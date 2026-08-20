/**
 * Non-destructive, hand-made audio edits.
 *
 * An edit is an instruction, never a change to the source: "mute 12.4→12.9",
 * "bleep 30.1→30.6", "turn 60→75 down". They live on the clip, survive
 * saving, and are applied only when a file is written — so undoing one later
 * costs nothing and the original VOD is never touched.
 *
 * There is no detector behind these any more (see the removed profanity
 * feature) and so no review workflow either: an edit the editor placed is
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

  if (bleeps.length === 0) {
    return { filterComplex: parts.join(';'), outputLabel: 'edited', notes }
  }

  // One gated tone per bleep, mixed over the silenced range.
  bleeps.forEach((bleep, index) => {
    const from = bleep.startSeconds
    const to = bleep.endSeconds
    const fade = Math.min(EDGE_FADE_SECONDS, (to - from) / 4)
    // aevalsrc rather than sine: it takes an explicit amplitude, so the bleep
    // lands at a predictable level instead of whatever the build's sine
    // happens to output.
    parts.push(
      `aevalsrc=${amplitude}*sin(2*PI*${hz}*t):d=${opts.durationSeconds.toFixed(3)}:s=48000:c=stereo` +
        `,${GATE_RESOLUTION}` +
        `,volume=enable='not(between(t,${from.toFixed(3)},${to.toFixed(3)}))':volume=0` +
        `,afade=t=in:st=${from.toFixed(3)}:d=${fade.toFixed(3)}` +
        `,afade=t=out:st=${(to - fade).toFixed(3)}:d=${fade.toFixed(3)}[bleep${index}]`
    )
  })

  const mixInputs = ['[edited]', ...bleeps.map((_, i) => `[bleep${i}]`)].join('')
  parts.push(`${mixInputs}amix=inputs=${1 + bleeps.length}:normalize=0:duration=first[out]`)

  return { filterComplex: parts.join(';'), outputLabel: 'out', notes }
}

/** Edits belonging to one POV. Edits with no POV belong to the clip's own. */
export function editsForPov(
  edits: AudioEdit[] | undefined,
  povId: string,
  fallbackPovId: string
): AudioEdit[] {
  return (edits ?? []).filter((edit) => (edit.povId ?? fallbackPovId) === povId)
}
