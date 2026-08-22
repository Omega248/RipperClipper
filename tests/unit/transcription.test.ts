import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODELS,
  estimateSeconds,
  linesFromWhisperJson,
  modelSpec,
  parseWhisperProgress,
  suggestedModel
} from '../../src/shared/transcription.js'

/**
 * Local speech-to-text.
 *
 * The measured figures behind these choices are in the module's own comment.
 * What is asserted here is the *behaviour* those figures imply — chiefly that
 * whisper's output becomes clean, searchable, correctly-timed lines.
 */

describe('parsing whisper output', () => {
  it('converts millisecond offsets into seconds', () => {
    const lines = linesFromWhisperJson({
      transcription: [{ offsets: { from: 1500, to: 3250 }, text: ' hello there ' }]
    })
    expect(lines).toEqual([{ startSeconds: 1.5, endSeconds: 3.25, text: 'hello there' }])
  })

  it('drops whisper’s non-speech markers, which are not dialogue', () => {
    // Searching for "music" must not match a stream that only had a jingle.
    const lines = linesFromWhisperJson({
      transcription: [
        { offsets: { from: 0, to: 1000 }, text: '[BLANK_AUDIO]' },
        { offsets: { from: 1000, to: 2000 }, text: '(wind blowing)' },
        { offsets: { from: 2000, to: 3000 }, text: 'actual speech' }
      ]
    })
    expect(lines.map((l) => l.text)).toEqual(['actual speech'])
  })

  it('skips segments with no usable timing rather than guessing one', () => {
    const lines = linesFromWhisperJson({
      transcription: [{ text: 'no offsets here' }, { offsets: { from: 0 }, text: 'half a range' }]
    })
    expect(lines).toEqual([])
  })

  it('ignores empty segments', () => {
    expect(
      linesFromWhisperJson({ transcription: [{ offsets: { from: 0, to: 10 }, text: '   ' }] })
    ).toEqual([])
  })

  it('survives a document with no transcription at all', () => {
    expect(linesFromWhisperJson({})).toEqual([])
  })
})

describe('progress parsing', () => {
  it('reads whisper’s own progress line', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =  42%')).toBeCloseTo(0.42)
  })

  it('clamps the overshoot whisper reports on very short inputs', () => {
    // Measured: an 11-second sample reports 272%.
    expect(parseWhisperProgress('progress = 272%')).toBe(1)
  })

  it('ignores unrelated output', () => {
    expect(parseWhisperProgress('whisper_model_load: loading model')).toBeNull()
  })
})

describe('choosing a model', () => {
  it('recommends the best model on a GPU, since it is also the fastest there', () => {
    // Measured: CUDA + large-v3-turbo beat CPU + tiny outright.
    expect(suggestedModel({ hasGpu: true, cores: 4 })).toBe('large-v3-turbo-q5_0')
  })

  it('steps down on a weak CPU rather than promising an overnight job', () => {
    expect(suggestedModel({ hasGpu: false, cores: 4 })).toBe('base.en')
    expect(suggestedModel({ hasGpu: false, cores: 8 })).toBe('small.en')
  })

  it('defaults to the quantised turbo model', () => {
    expect(DEFAULT_WHISPER_MODEL).toBe('large-v3-turbo-q5_0')
    // Substantially smaller than full precision, which is the whole point.
    expect(modelSpec('large-v3-turbo-q5_0').approxBytes).toBeLessThan(
      modelSpec('large-v3-turbo').approxBytes / 2
    )
  })

  it('falls back to a real model for an unknown id rather than crashing', () => {
    expect(modelSpec('nonsense' as never).id).toBeTruthy()
  })

  it('every model has a distinct id and a positive size', () => {
    const ids = new Set(WHISPER_MODELS.map((m) => m.id))
    expect(ids.size).toBe(WHISPER_MODELS.length)
    expect(WHISPER_MODELS.every((m) => m.approxBytes > 0)).toBe(true)
  })
})

describe('estimating how long a VOD will take', () => {
  it('is far quicker with a GPU on the large model', () => {
    const sixHours = 6 * 3600
    const gpu = estimateSeconds(sixHours, 'large-v3-turbo-q5_0', true)
    const cpu = estimateSeconds(sixHours, 'large-v3-turbo-q5_0', false)
    expect(gpu).toBeLessThan(cpu / 4)
  })

  it('puts a six-hour VOD well inside a quarter of an hour on a GPU', () => {
    // 25x real time measured; 6h/25 is about 14 minutes.
    expect(estimateSeconds(6 * 3600, 'large-v3-turbo-q5_0', true)).toBeLessThan(16 * 60)
  })

  it('never estimates zero, however short the audio', () => {
    expect(estimateSeconds(0.1, 'tiny.en', true)).toBeGreaterThan(0)
  })
})
