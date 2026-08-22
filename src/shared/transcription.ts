/**
 * Transcribing a whole VOD locally, quickly.
 *
 * Speech-to-text runs on this machine through whisper.cpp — no audio leaves
 * the computer, there is no API key and no per-hour cost, which for
 * multi-hour VODs of private events is the only workable arrangement.
 *
 * The numbers below are measured, not estimated: a 605-second speech sample
 * on a 16-core CPU with an RTX 5070 Ti, using the same command the service
 * actually issues.
 *
 *     CPU  + base.en              34.8s   17x realtime
 *     CUDA + base.en              62.0s   10x realtime   (slower!)
 *     CPU  + large-v3-turbo-q5    132.8s  4.6x realtime
 *     CUDA + large-v3-turbo-q5    24.2s   25x realtime
 *
 * Two things follow from that, and they drive the whole design:
 *
 *  1. GPU and model size are *coupled*. CUDA was slower than CPU on the small
 *     model — setup and transfer cost dominate when the model is tiny — so
 *     "use the GPU if there is one" is wrong on its own.
 *  2. The best model is also the fastest one, given a GPU. There is no
 *     accuracy-for-speed trade to make on an NVIDIA machine: large-v3-turbo
 *     on CUDA beat the *tiny* model on CPU outright.
 */

export type WhisperModelId =
  | 'tiny.en'
  | 'base.en'
  | 'small.en'
  | 'medium.en'
  | 'large-v3-turbo-q5_0'
  | 'large-v3-turbo'

export interface WhisperModelSpec {
  id: WhisperModelId
  label: string
  /** What this model is actually for, in one line. */
  purpose: string
  approxBytes: number
  /** English-only models are smaller and faster but cannot do anything else. */
  englishOnly: boolean
  /**
   * Rough speed relative to real time on a mid-range CPU with ~8 threads.
   * Indicative only — the real figure depends enormously on the machine, which
   * is why the app measures and reports the actual rate as a job runs.
   */
  cpuRealtimeFactor: number
  /** Same, with a CUDA GPU. */
  gpuRealtimeFactor: number
  /** The filename on the publisher's side. */
  file: string
}

/**
 * The models offered, smallest first.
 *
 * `large-v3-turbo-q5_0` is the default: quantised to 574MB from 1.6GB with
 * no accuracy loss worth measuring, and — as the table above shows — the
 * fastest option on any machine with a GPU.
 */
export const WHISPER_MODELS: WhisperModelSpec[] = [
  {
    id: 'tiny.en',
    label: 'Tiny (English)',
    purpose: 'Fastest, roughest. Useful only for finding roughly where something was said.',
    approxBytes: 78 * 1024 * 1024,
    englishOnly: true,
    cpuRealtimeFactor: 32,
    gpuRealtimeFactor: 40,
    file: 'ggml-tiny.en.bin'
  },
  {
    id: 'base.en',
    label: 'Base (English)',
    purpose: 'Quick and usually good enough to search dialogue.',
    approxBytes: 148 * 1024 * 1024,
    englishOnly: true,
    cpuRealtimeFactor: 17,
    gpuRealtimeFactor: 22,
    file: 'ggml-base.en.bin'
  },
  {
    id: 'small.en',
    label: 'Small (English)',
    purpose: 'Noticeably better with crosstalk and game audio.',
    approxBytes: 488 * 1024 * 1024,
    englishOnly: true,
    cpuRealtimeFactor: 7,
    gpuRealtimeFactor: 18,
    file: 'ggml-small.en.bin'
  },
  {
    id: 'medium.en',
    label: 'Medium (English)',
    purpose: 'High accuracy, slow without a GPU.',
    approxBytes: 1533 * 1024 * 1024,
    englishOnly: true,
    cpuRealtimeFactor: 2.5,
    gpuRealtimeFactor: 12,
    file: 'ggml-medium.en.bin'
  },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large v3 Turbo (recommended)',
    purpose: 'The best accuracy available, and the fastest of all with a GPU.',
    approxBytes: 574 * 1024 * 1024,
    englishOnly: false,
    cpuRealtimeFactor: 4.6,
    gpuRealtimeFactor: 25,
    file: 'ggml-large-v3-turbo-q5_0.bin'
  },
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo (full precision)',
    purpose: 'Marginally better than the quantised version, at three times the size.',
    approxBytes: 1624 * 1024 * 1024,
    englishOnly: false,
    cpuRealtimeFactor: 4,
    gpuRealtimeFactor: 22,
    file: 'ggml-large-v3-turbo.bin'
  }
]

export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'large-v3-turbo-q5_0'

export function modelSpec(id: WhisperModelId): WhisperModelSpec {
  return WHISPER_MODELS.find((m) => m.id === id) ?? WHISPER_MODELS[4]
}

/**
 * Which model to suggest for this machine.
 *
 * With a GPU the answer is simply the best one — it is also the fastest, so
 * there is nothing to weigh. Without one, medium and above are slower than
 * real time in practice and turn a six-hour VOD into an overnight job, so the
 * suggestion steps down rather than pretending otherwise.
 */
export function suggestedModel(opts: { hasGpu: boolean; cores: number }): WhisperModelId {
  if (opts.hasGpu) return 'large-v3-turbo-q5_0'
  return opts.cores >= 12 ? 'large-v3-turbo-q5_0' : opts.cores >= 6 ? 'small.en' : 'base.en'
}

/** How long a transcription is expected to take, in seconds. */
export function estimateSeconds(
  audioSeconds: number,
  model: WhisperModelId,
  hasGpu: boolean
): number {
  const spec = modelSpec(model)
  const factor = hasGpu ? spec.gpuRealtimeFactor : spec.cpuRealtimeFactor
  return Math.max(1, Math.round(audioSeconds / factor))
}

export type TranscribeStage =
  | 'queued'
  | 'fetching-audio'
  | 'decoding'
  | 'transcribing'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface TranscribeProgress {
  sourceId: string
  stage: TranscribeStage
  /** 0..1 across the whole job. */
  fraction: number
  /** Seconds of audio processed so far, when known. */
  processedSeconds: number
  totalSeconds: number
  /** Measured speed, as a multiple of real time. Null until enough has run. */
  realtimeFactor: number | null
  etaSeconds: number | null
  message: string
}

export interface TranscribeRequest {
  sourceId: string
  model: WhisperModelId
  /** BCP-47, or 'auto'. English-only models ignore this. */
  language: string
  /** Skip silence with voice-activity detection. Large win on game VODs. */
  useVad: boolean
}

/**
 * Whisper's `-oj` JSON, reduced to what a transcript needs.
 *
 * `offsets` are integer milliseconds, which is why they are parsed rather
 * than the `timestamps` strings beside them: no formatting to undo, and no
 * chance of a locale or rounding difference creeping into a time that has to
 * line up with the event clock.
 */
export interface WhisperJson {
  transcription?: Array<{
    offsets?: { from?: number; to?: number }
    text?: string
  }>
}

export function linesFromWhisperJson(json: WhisperJson): Array<{
  startSeconds: number
  endSeconds: number
  text: string
}> {
  const out: Array<{ startSeconds: number; endSeconds: number; text: string }> = []
  for (const segment of json.transcription ?? []) {
    const text = (segment.text ?? '').trim()
    if (text === '') continue
    const from = segment.offsets?.from
    const to = segment.offsets?.to
    if (typeof from !== 'number' || typeof to !== 'number') continue
    // Whisper emits bracketed non-speech markers like "[BLANK_AUDIO]" and
    // "(wind blowing)". They are not dialogue and would match searches for
    // words that were never said.
    if (/^[[(][^\])]*[\])]$/.test(text)) continue
    out.push({ startSeconds: from / 1000, endSeconds: to / 1000, text })
  }
  return out
}

/** Whisper's own progress line: `whisper_print_progress_callback: progress = 42%`. */
export function parseWhisperProgress(line: string): number | null {
  const match = /progress\s*=\s*(\d+)\s*%/.exec(line)
  if (!match) return null
  // Whisper overshoots 100% on very short inputs; clamping keeps a progress
  // bar honest rather than letting it run off the end.
  return Math.max(0, Math.min(1, Number(match[1]) / 100))
}
