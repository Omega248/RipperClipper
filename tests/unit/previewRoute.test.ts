import { describe, expect, it } from 'vitest'
import { mergeSettings, defaultSettings } from '../../src/shared/defaults.js'

describe('settings round-trip', () => {
  it('keeps export choices that used to be dropped on reload', () => {
    const base = defaultSettings({ outputDirectory: '/out', cacheDirectory: '/cache' })
    const saved = {
      ...base,
      export: { ...base.export, folderTemplate: '{Project}/{Creator}', uncertainPaddingSeconds: 5 },
      advanced: { ...base.advanced, ffmpegPath: '/bin/ffmpeg' }
    }
    const loaded = mergeSettings(base, saved)
    expect(loaded.export.folderTemplate).toBe('{Project}/{Creator}')
    expect(loaded.export.uncertainPaddingSeconds).toBe(5)
    expect(loaded.advanced.ffmpegPath).toBe('/bin/ffmpeg')
  })
})
