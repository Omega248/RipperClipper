import type { AppSettings, ExportPreset, ExportSettings } from './types.js'

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  container: 'mp4',
  cutMode: 'smart',
  quality: 'best',
  hwAccel: 'auto',
  keyframeToleranceSeconds: 0.5,
  smartCut: true,
  uncertainPaddingSeconds: 2,
  // The clip's own name first, then who it came from and when, so a folder of
  // exports from one event still says which POV each file is.
  filenameTemplate: '{Name} - {Creator} - {Date}',
  // Each project gets its own folder by default; POV- or clip-per-folder are a
  // setting away.
  folderTemplate: '{Project}'
}

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  playPause: 'Space',
  seekBack: 'ArrowLeft',
  seekForward: 'ArrowRight',
  seekBackLarge: 'Shift+ArrowLeft',
  seekForwardLarge: 'Shift+ArrowRight',
  setIn: 'KeyI',
  setOut: 'KeyO',
  addClip: 'Enter',
  deleteClip: 'Delete',
  prevClip: 'KeyJ',
  playPauseAlt: 'KeyK',
  nextClip: 'KeyL',
  addMarker: 'KeyM',
  addMarkerEverywhere: 'Shift+KeyM',
  findInPovs: 'KeyF',
  undo: 'Ctrl+KeyZ',
  redo: 'Ctrl+Shift+KeyZ',
  loopSelection: 'KeyP',
  zoomIn: 'Equal',
  zoomOut: 'Minus'
}

/**
 * How many angles decode at once, by default.
 *
 * Sixteen, because the wall is the reason this app exists and a ceiling is a
 * bad place to be cautious: an angle over it is not a slower tile, it is a
 * tile that says no. Eight was chosen as "about what fits on one screen before
 * a tile stops being worth looking at", which is a judgement about *looking*
 * dressed up as a machine limit — and it meant loading a ninth angle produced
 * a refusal rather than a picture.
 *
 * The machine's actual limit is handled where it belongs: the shared bandwidth
 * budget picks a smaller rung as angles are added, and the wall lowers its own
 * quality when tiles report they cannot keep up. Both of those degrade; this
 * one only refuses. Which angles are on screen is the wall's angle picker.
 */
export const DEFAULT_ANGLE_CEILING = 16

/** The angle ceiling, with the legacy "no limit" sentinel folded into the default. */
export function normalizeAngleCeiling(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_ANGLE_CEILING
}

export function defaultSettings(paths: {
  outputDirectory: string
  cacheDirectory: string
}): AppSettings {
  return {
    outputDirectory: paths.outputDirectory,
    concurrency: 2,
    export: { ...DEFAULT_EXPORT_SETTINGS },
    cache: {
      directory: paths.cacheDirectory,
      maxSizeBytes: 8 * 1024 * 1024 * 1024
    },
    advanced: {
      ffmpegPath: null,
      ffprobePath: null,
      ytDlpPath: null,
      cookiesFromBrowser: null,
      tempDirectory: null,
      autoInstallTools: true,
      logLevel: 'info'
    },
    ui: {
      theme: 'system',
      timelineFollowPlayhead: true,
      exportCompletionSound: false,
      fastPreview: false,
      hasMadeAClip: false,
      maxLivePovs: DEFAULT_ANGLE_CEILING,
      autoNameBadge: true
    },
    shortcuts: { ...DEFAULT_SHORTCUTS },
    exportPresets: []
  }
}

/** Deep-merge persisted settings over defaults so new keys always exist. */
export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  if (typeof patch !== 'object' || patch === null) return base
  const p = patch as Record<string, unknown>
  return {
    outputDirectory: str(p.outputDirectory, base.outputDirectory),
    concurrency: clampInt(p.concurrency, 1, 32, base.concurrency),
    export: {
      ...base.export,
      ...pick(p.export, [
        'container',
        'cutMode',
        'quality',
        'hwAccel',
        'keyframeToleranceSeconds',
        'smartCut',
        'uncertainPaddingSeconds',
        'filenameTemplate',
        'folderTemplate'
      ])
    },
    cache: {
      ...base.cache,
      ...pick(p.cache, ['directory', 'maxSizeBytes'])
    },
    advanced: {
      ...base.advanced,
      ...pick(p.advanced, [
        'ffmpegPath',
        'ffprobePath',
        'ytDlpPath',
        'cookiesFromBrowser',
        'tempDirectory',
        'autoInstallTools',
        'logLevel'
      ])
    },
    ui: {
      ...base.ui,
      ...pick(p.ui, [
        'theme',
        'timelineFollowPlayhead',
        'sidePanelWidth',
        'timelineHeight',
        'exportCompletionSound',
        'fastPreview',
        'hasMadeAClip',
        'maxLivePovs',
        'autoNameBadge'
      ]),
      /*
       * A stored 0 is not a choice anyone made.
       *
       * 0 meant "no ceiling" and was also the old default, so every install
       * from before the wall had an angle picker has one — indistinguishable
       * from someone who picked it. "No limit" is gone from the options now
       * (a wall past two dozen angles is not a wall anyone reads), which makes
       * this safe: nothing can write a 0 any more, so anything holding one is
       * carrying the old default and should get the new one.
       */
      maxLivePovs: normalizeAngleCeiling((p.ui as Record<string, unknown> | undefined)?.maxLivePovs)
    },
    shortcuts: {
      ...base.shortcuts,
      ...(typeof p.shortcuts === 'object' && p.shortcuts !== null
        ? (p.shortcuts as Record<string, string>)
        : {})
    },
    exportPresets: parseExportPresets(p.exportPresets, base.exportPresets)
  }
}

/** Structurally-invalid entries are dropped rather than failing the whole load. */
function parseExportPresets(value: unknown, fallback: ExportPreset[]): ExportPreset[] {
  if (!Array.isArray(value)) return fallback
  const out: ExportPreset[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.name !== 'string') continue
    out.push({
      id: e.id,
      name: e.name,
      ...(e.isDefault === true ? { isDefault: true } : {}),
      settings: {
        ...DEFAULT_EXPORT_SETTINGS,
        ...pick<ExportSettings>(e.settings, [
          'container',
          'cutMode',
          'quality',
          'hwAccel',
          'keyframeToleranceSeconds',
          'smartCut',
          'uncertainPaddingSeconds',
          'filenameTemplate',
          'folderTemplate'
        ])
      }
    })
  }
  // At most one default survives, even if a hand-edited settings file had more.
  let seenDefault = false
  for (const preset of out) {
    if (!preset.isDefault) continue
    if (seenDefault) delete preset.isDefault
    else seenDefault = true
  }
  return out
}

function pick<T extends object>(value: unknown, keys: Array<keyof T>): Partial<T> {
  if (typeof value !== 'object' || value === null) return {}
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (src[key as string] !== undefined) out[key as string] = src[key as string]
  }
  return out as Partial<T>
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
