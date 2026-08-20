import type { AppSettings, ExportSettings } from './types.js'

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  container: 'mp4',
  cutMode: 'smart',
  quality: 'best',
  hwAccel: 'auto',
  keyframeToleranceSeconds: 0.5,
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
  undo: 'Ctrl+KeyZ',
  redo: 'Ctrl+Shift+KeyZ',
  loopSelection: 'KeyP',
  zoomIn: 'Equal',
  zoomOut: 'Minus'
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
      tempDirectory: null,
      autoInstallTools: true,
      logLevel: 'info'
    },
    ui: {
      theme: 'system',
      timelineFollowPlayhead: true
    },
    shortcuts: { ...DEFAULT_SHORTCUTS }
  }
}

/** Deep-merge persisted settings over defaults so new keys always exist. */
export function mergeSettings(base: AppSettings, patch: unknown): AppSettings {
  if (typeof patch !== 'object' || patch === null) return base
  const p = patch as Record<string, unknown>
  return {
    outputDirectory: str(p.outputDirectory, base.outputDirectory),
    concurrency: clampInt(p.concurrency, 1, 4, base.concurrency),
    export: {
      ...base.export,
      ...pick(p.export, [
        'container',
        'cutMode',
        'quality',
        'hwAccel',
        'keyframeToleranceSeconds',
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
        'tempDirectory',
        'autoInstallTools',
        'logLevel'
      ])
    },
    ui: {
      ...base.ui,
      ...pick(p.ui, ['theme', 'timelineFollowPlayhead', 'sidePanelWidth', 'timelineHeight'])
    },
    shortcuts: {
      ...base.shortcuts,
      ...(typeof p.shortcuts === 'object' && p.shortcuts !== null
        ? (p.shortcuts as Record<string, string>)
        : {})
    }
  }
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
