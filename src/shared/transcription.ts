/**
 * Speech-to-text over a *clip range*, on this machine.
 *
 * Deliberately much lighter than transcribing whole VODs. The job here is
 * finding words inside a five-minute clip that is about to be exported, not
 * indexing a six-hour broadcast, and that changes every trade-off:
 *
 *   - only the clip's own range is decoded, so the work is seconds not hours;
 *   - the small English models are plenty, because what actually has to be
 *     recognised is a short closed vocabulary of words to censor, and a false
 *     positive costs one click to dismiss;
 *   - no GPU is needed at all. Measured at ~17x real time on CPU with
 *     `base.en`, a five-minute clip is about twenty seconds of work, and six
 *     POVs of it around two minutes.
 *
 * That is a completely different proposition from a whole-VOD pass, which
 * needed a 574MB-1.6GB model and, to be quick, a 671MB CUDA runtime.
 */

export type WhisperModelId = 'tiny.en' | 'base.en' | 'small.en'

export interface WhisperModelSpec {
  id: WhisperModelId
  label: string
  purpose: string
  approxBytes: number
  /** Rough speed against real time on a mid-range CPU. */
  cpuRealtimeFactor: number
  file: string
}

/**
 * The models offered. All English-only and all small: the largest here is
 * under 500MB, and even that is only worth it for badly-mixed audio.
 */
export const WHISPER_MODELS: WhisperModelSpec[] = [
  {
    id: 'tiny.en',
    label: 'Tiny',
    purpose: 'Fastest. Good enough to catch the words you want censored.',
    approxBytes: 78 * 1024 * 1024,
    cpuRealtimeFactor: 32,
    file: 'ggml-tiny.en.bin'
  },
  {
    id: 'base.en',
    label: 'Base (recommended)',
    purpose: 'Noticeably steadier with game audio and crosstalk. Still quick.',
    approxBytes: 148 * 1024 * 1024,
    cpuRealtimeFactor: 17,
    file: 'ggml-base.en.bin'
  },
  {
    id: 'small.en',
    label: 'Small',
    purpose: 'For quiet mics or heavy background noise. Slower.',
    approxBytes: 488 * 1024 * 1024,
    cpuRealtimeFactor: 7,
    file: 'ggml-small.en.bin'
  }
]

export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'base.en'

export function modelSpec(id: WhisperModelId): WhisperModelSpec {
  return WHISPER_MODELS.find((m) => m.id === id) ?? WHISPER_MODELS[1]
}

/** How long a clip is expected to take, in seconds. Never zero. */
export function estimateSeconds(clipSeconds: number, model: WhisperModelId): number {
  return Math.max(1, Math.round(clipSeconds / modelSpec(model).cpuRealtimeFactor))
}

export type AnalysisStage =
  | 'queued'
  | 'fetching'
  | 'transcribing'
  | 'complete'
  | 'failed'
  | 'skipped'

/** Progress for one POV's analysis of one clip. */
export interface AnalysisProgress {
  clipId: string
  sourceId: string
  stage: AnalysisStage
  /** 0..1 across this POV's own work. */
  fraction: number
  message: string
}

/** One spoken line, in the clip's own time — 0 is the start of the clip. */
export interface TranscriptLine {
  startSeconds: number
  endSeconds: number
  text: string
}

/** A clip's transcript for one POV. */
export interface ClipTranscript {
  clipId: string
  sourceId: string
  model: WhisperModelId
  lines: TranscriptLine[]
  createdAt: string
}

/**
 * Whisper's `-oj` JSON, reduced to what is needed.
 *
 * `offsets` are integer milliseconds, which is why they are read rather than
 * the `timestamps` strings beside them: no formatting to undo, and no chance
 * of a rounding or locale difference creeping into a time that has to line up
 * with an audio edit.
 */
export interface WhisperJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number }
    text?: string
  }>
}

export function linesFromWhisperJson(json: WhisperJson): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const segment of json.transcription ?? []) {
    const text = (segment.text ?? '').trim()
    if (text === '') continue
    const from = segment.offsets?.from
    const to = segment.offsets?.to
    if (typeof from !== 'number' || typeof to !== 'number') continue
    // Whisper emits bracketed non-speech markers — "[BLANK_AUDIO]",
    // "(wind blowing)". They are not speech and must never be censored.
    if (/^[[(][^\])]*[\])]$/.test(text)) continue
    out.push({ startSeconds: from / 1000, endSeconds: to / 1000, text })
  }
  return out
}

/** Whisper's own progress line: `whisper_print_progress_callback: progress = 42%`. */
export function parseWhisperProgress(line: string): number | null {
  const match = /progress\s*=\s*(\d+)\s*%/.exec(line)
  if (!match) return null
  // Whisper overshoots 100% on very short inputs; clamping keeps the bar honest.
  return Math.max(0, Math.min(1, Number(match[1]) / 100))
}
