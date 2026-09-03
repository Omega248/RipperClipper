import { describe, expect, it } from 'vitest'
import { projectNameFromSource, shortDate, suggestedProjectName } from '@shared/projectNames'

/**
 * A project's name ends up in the recent list and in the folder its exports
 * are written to, so "Untitled project" three times over is a real problem,
 * not a cosmetic one.
 */

describe('shortDate', () => {
  it('is the same string on every machine', () => {
    // Deliberately not toLocaleDateString: a name that renders as 31/08/2026
    // here and 8/31/2026 there is a name you cannot search for.
    expect(shortDate(new Date(Date.UTC(2026, 7, 31, 12)))).toBe('31 Aug 2026')
    expect(shortDate('2026-01-05T09:00:00.000Z')).toBe('5 Jan 2026')
  })

  it('says nothing rather than "Invalid Date"', () => {
    expect(shortDate(null)).toBeNull()
    expect(shortDate(undefined)).toBeNull()
    expect(shortDate('not a date')).toBeNull()
  })
})

describe('suggestedProjectName', () => {
  it('is the date, so two projects made on different days are told apart', () => {
    expect(suggestedProjectName(new Date(Date.UTC(2026, 7, 31, 12)))).toBe('31 Aug 2026')
  })
})

describe('projectNameFromSource', () => {
  it('leads with who, because a project is an event and its angles are people', () => {
    expect(
      projectNameFromSource({ creator: 'basedLore', title: 'SUBATHON DAY 29', createdAt: '2026-08-14T10:00:00Z' })
    ).toBe('basedLore — 14 Aug 2026')
  })

  it('falls back through what is actually known', () => {
    expect(projectNameFromSource({ creator: 'basedLore', createdAt: null })).toBe('basedLore')
    expect(projectNameFromSource({ creator: '  ', title: 'SUBATHON DAY 29' })).toBe('SUBATHON DAY 29')
  })

  it('never returns a name too long to read in a list', () => {
    const name = projectNameFromSource({ title: 'x'.repeat(200) })
    expect(name.length).toBeLessThanOrEqual(60)
    expect(name.endsWith('…')).toBe(true)
  })

  it('always answers something usable', () => {
    expect(projectNameFromSource({}).length).toBeGreaterThan(0)
    expect(projectNameFromSource({ creator: null, title: null, createdAt: null }).length).toBeGreaterThan(0)
  })
})
