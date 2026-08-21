import { describe, expect, it } from 'vitest'
import { buildClipListCsv } from '../../src/shared/clipListCsv.js'
import type { ClipListRow } from '../../src/shared/clipListCsv.js'

function row(overrides: Partial<ClipListRow> = {}): ClipListRow {
  return {
    name: 'Funny Death',
    videoPov: 'Streamer A',
    audioPov: 'Streamer A',
    durationSeconds: 92,
    resolution: '1920×1080',
    watermarked: false,
    path: 'Event / Funny Death.mp4',
    ...overrides
  }
}

describe('buildClipListCsv', () => {
  it('writes a header row followed by one row per clip', () => {
    const csv = buildClipListCsv([row(), row({ name: 'Insane Fight' })])
    const lines = csv.trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('Name,Video POV,Audio POV,Duration,Resolution,Watermarked,File')
    expect(lines[1]).toContain('Funny Death')
    expect(lines[2]).toContain('Insane Fight')
  })

  it('formats duration as clock time, hours only when needed', () => {
    expect(buildClipListCsv([row({ durationSeconds: 92 })])).toContain('1:32')
    expect(buildClipListCsv([row({ durationSeconds: 3725 })])).toContain('1:02:05')
    expect(buildClipListCsv([row({ durationSeconds: 5 })])).toContain('0:05')
  })

  it('quotes a field that contains a comma', () => {
    const csv = buildClipListCsv([row({ name: 'Wow, what a moment' })])
    expect(csv).toContain('"Wow, what a moment"')
  })

  it('quotes and escapes a field that contains a double quote', () => {
    const csv = buildClipListCsv([row({ name: 'He said "run"' })])
    expect(csv).toContain('"He said ""run"""')
  })

  it('quotes a field that contains a newline', () => {
    const csv = buildClipListCsv([row({ path: 'Event\nSub / clip.mp4' })])
    expect(csv).toContain('"Event\nSub / clip.mp4"')
  })

  it('leaves an ordinary field unquoted', () => {
    const csv = buildClipListCsv([row({ name: 'Plain Name' })])
    expect(csv).toContain('Plain Name,')
    expect(csv).not.toContain('"Plain Name"')
  })

  it('produces just the header for no clips', () => {
    expect(buildClipListCsv([]).trim()).toBe('Name,Video POV,Audio POV,Duration,Resolution,Watermarked,File')
  })

  it('shows Yes/No for watermarked rather than a raw boolean', () => {
    const csv = buildClipListCsv([row({ watermarked: true }), row({ watermarked: false })])
    const lines = csv.trim().split('\r\n').slice(1)
    expect(lines[0].endsWith(',Yes,' + row().path)).toBe(true)
    expect(lines[1].endsWith(',No,' + row().path)).toBe(true)
  })
})
