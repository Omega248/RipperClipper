import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS, defaultSettings, mergeSettings } from '../../src/shared/defaults.js'

const PATHS = { outputDirectory: '/out', cacheDirectory: '/cache' }

describe('export presets in settings', () => {
  it('defaults to an empty list', () => {
    expect(defaultSettings(PATHS).exportPresets).toEqual([])
  })

  it('keeps a well-formed preset from persisted settings', () => {
    const base = defaultSettings(PATHS)
    const merged = mergeSettings(base, {
      exportPresets: [
        { id: 'p1', name: 'Fast archive', settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' } }
      ]
    })
    expect(merged.exportPresets).toHaveLength(1)
    expect(merged.exportPresets[0]).toMatchObject({ id: 'p1', name: 'Fast archive' })
    expect(merged.exportPresets[0].settings.cutMode).toBe('copy')
  })

  it('fills in any missing setting fields from the defaults rather than dropping the preset', () => {
    const base = defaultSettings(PATHS)
    const merged = mergeSettings(base, {
      exportPresets: [{ id: 'p1', name: 'Partial', settings: { cutMode: 'precise' } }]
    })
    expect(merged.exportPresets[0].settings.cutMode).toBe('precise')
    expect(merged.exportPresets[0].settings.container).toBe(DEFAULT_EXPORT_SETTINGS.container)
  })

  it('drops entries missing an id or a name instead of failing the whole load', () => {
    const base = defaultSettings(PATHS)
    const merged = mergeSettings(base, {
      exportPresets: [
        { id: 'p1', name: 'Good', settings: DEFAULT_EXPORT_SETTINGS },
        { name: 'No id', settings: DEFAULT_EXPORT_SETTINGS },
        { id: 'p3', settings: DEFAULT_EXPORT_SETTINGS },
        'not even an object'
      ]
    })
    expect(merged.exportPresets.map((p) => p.id)).toEqual(['p1'])
  })

  it('falls back to the existing presets when the field is missing or malformed', () => {
    const base = { ...defaultSettings(PATHS), exportPresets: [{ id: 'x', name: 'X', settings: DEFAULT_EXPORT_SETTINGS }] }
    expect(mergeSettings(base, {}).exportPresets).toEqual(base.exportPresets)
    expect(mergeSettings(base, { exportPresets: 'nope' }).exportPresets).toEqual(base.exportPresets)
  })
})
