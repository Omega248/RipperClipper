import { describe, expect, it } from 'vitest'
import { buildAudioFilter, editsForPov } from '@shared/audioEdits'
import type { AudioEdit } from '@shared/audioEdits'

function edit(init: Partial<AudioEdit> & { kind: AudioEdit['kind']; startSeconds: number; endSeconds: number }): AudioEdit {
  return { id: `e_${init.startSeconds}`, ...init }
}

describe('buildAudioFilter', () => {
  it('does nothing when there are no edits', () => {
    const plan = buildAudioFilter([], { durationSeconds: 10 })
    expect(plan.filterComplex).toBeNull()
    expect(plan.outputLabel).toBe('0:a')
    expect(plan.notes).toEqual([])
  })

  it('ignores a zero-or-negative-length edit', () => {
    const plan = buildAudioFilter([edit({ kind: 'mute', startSeconds: 5, endSeconds: 5 })], {
      durationSeconds: 10
    })
    expect(plan.filterComplex).toBeNull()
  })

  it('mutes a range with a gate small enough to land precisely', () => {
    const plan = buildAudioFilter([edit({ kind: 'mute', startSeconds: 1, endSeconds: 2 })], {
      durationSeconds: 10
    })
    expect(plan.filterComplex).toContain('asetnsamples=n=128:p=0')
    expect(plan.filterComplex).toContain("volume=enable='between(t,1.000,2.000)':volume=0")
    expect(plan.outputLabel).toBe('edited')
    expect(plan.notes[0]).toMatch(/Silenced 1\.00–2\.00s/)
  })

  it('ducks a range by the requested (or default) decibels', () => {
    const withDefault = buildAudioFilter([edit({ kind: 'duck', startSeconds: 0, endSeconds: 1 })], {
      durationSeconds: 10
    })
    expect(withDefault.filterComplex).toContain('volume=-18dB')

    const withCustom = buildAudioFilter(
      [edit({ kind: 'duck', startSeconds: 0, endSeconds: 1, gainDb: -9 })],
      { durationSeconds: 10 }
    )
    expect(withCustom.filterComplex).toContain('volume=-9dB')
  })

  it('mixes a gated tone in for a bleep, and mutes the underlying audio', () => {
    const plan = buildAudioFilter([edit({ kind: 'bleep', startSeconds: 2, endSeconds: 3 })], {
      durationSeconds: 10,
      bleepHz: 800,
      bleepAmplitude: 0.5
    })
    expect(plan.filterComplex).toContain("volume=enable='between(t,2.000,3.000)':volume=0")
    expect(plan.filterComplex).toContain('aevalsrc=0.5*sin(2*PI*800*t)')
    expect(plan.filterComplex).toContain('amix=inputs=2')
    expect(plan.outputLabel).toBe('out')
  })

  it('applies several edits of different kinds in one pass', () => {
    const plan = buildAudioFilter(
      [
        edit({ kind: 'mute', startSeconds: 1, endSeconds: 2 }),
        edit({ kind: 'duck', startSeconds: 3, endSeconds: 4 }),
        edit({ kind: 'bleep', startSeconds: 5, endSeconds: 6 })
      ],
      { durationSeconds: 10 }
    )
    expect(plan.notes).toHaveLength(3)
    expect(plan.filterComplex).toContain('amix=inputs=2')
  })

  it('clamps a range to the clip duration', () => {
    const plan = buildAudioFilter([edit({ kind: 'mute', startSeconds: 8, endSeconds: 20 })], {
      durationSeconds: 10
    })
    expect(plan.filterComplex).toContain('between(t,8.000,10.000)')
  })
})

describe('editsForPov', () => {
  const edits: AudioEdit[] = [
    edit({ kind: 'mute', startSeconds: 1, endSeconds: 2, povId: 'pov_a' }),
    edit({ kind: 'mute', startSeconds: 3, endSeconds: 4, povId: 'pov_b' }),
    edit({ kind: 'mute', startSeconds: 5, endSeconds: 6 }) // no explicit POV — belongs to the fallback
  ]

  it('returns only edits matching the POV, plus POV-less edits when the fallback matches', () => {
    expect(editsForPov(edits, 'pov_a', 'pov_a')).toHaveLength(2)
    expect(editsForPov(edits, 'pov_b', 'pov_a')).toHaveLength(1)
  })

  it('returns an empty array when there are no edits', () => {
    expect(editsForPov(undefined, 'pov_a', 'pov_a')).toEqual([])
  })
})
