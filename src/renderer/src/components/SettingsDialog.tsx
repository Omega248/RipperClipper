import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/errors'
import { DEFAULT_SHORTCUTS } from '@shared/defaults'
import type { AppSettings, LogLevel, ThemeMode } from '@shared/types'
import type { CacheStats } from '@shared/ipc'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import SetupPanel from './SetupPanel.js'
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Icon,
  Input,
  Notice,
  ProgressBar,
  Select,
  StatusBadge
} from '../ui/index.js'
import type { IconName } from '../ui/index.js'

interface Props {
  onClose: () => void
}

/**
 * Settings.
 *
 * Organised by what the editor is trying to change, not by which subsystem
 * owns the value. The categories are the ones a person would name — Appearance,
 * Export, Storage — and everything that only matters when something has
 * broken lives in Diagnostics, which is deliberately last and deliberately
 * plain.
 */

type Category =
  | 'appearance'
  | 'export'
  | 'downloads'
  | 'storage'
  | 'shortcuts'
  | 'setup'
  | 'diagnostics'

const CATEGORIES: Array<{ id: Category; label: string; icon: IconName }> = [
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'export', label: 'Export', icon: 'download' },
  { id: 'downloads', label: 'Downloads', icon: 'folder' },
  { id: 'storage', label: 'Storage', icon: 'file' },
  { id: 'shortcuts', label: 'Keyboard', icon: 'settings' },
  { id: 'setup', label: 'Setup', icon: 'refresh' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'help' }
]

export default function SettingsDialog({ onClose }: Props): JSX.Element {
  const settings = useStore((s) => s.settings)
  const env = useStore((s) => s.env)
  const setSettings = useStore((s) => s.setSettings)
  const setEnv = useStore((s) => s.setEnv)
  const toast = useStore((s) => s.toast)
  const updateStatus = useStore((s) => s.updateStatus)
  const [cache, setCache] = useState<CacheStats | null>(null)
  const [logs, setLogs] = useState('')
  const [category, setCategory] = useState<Category>('appearance')

  useEffect(() => {
    void window.api.cacheStats().then(setCache)
  }, [])

  if (!settings) return <></>

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const next = await window.api.updateSettings(patch)
      setSettings(next)
      setEnv(await window.api.env())
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not save that'), message: message(err) })
    }
  }

  return (
    <Dialog
      title="Settings"
      size="large"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`settings-nav-item${category === c.id ? ' on' : ''}`}
              aria-current={category === c.id}
              onClick={() => setCategory(c.id)}
            >
              <Icon name={c.icon} size={15} />
              {c.label}
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          {category === 'appearance' && (
            <section className="panel-section">
              <h3>Appearance</h3>
              <div className="rows">
                <Field
                  label="Theme"
                  htmlFor="theme"
                  hint="Following the system means Ripper Clipper changes with Windows, including when it switches at sunset."
                >
                  <Select
                    id="theme"
                    block
                    value={settings.ui.theme}
                    options={[
                      { value: 'system', label: 'Follow the system' },
                      { value: 'light', label: 'Light' },
                      { value: 'dark', label: 'Dark' }
                    ]}
                    onChange={(value) =>
                      void save({ ui: { ...settings.ui, theme: value as ThemeMode } })
                    }
                  />
                </Field>
                <Field label="Timeline">
                  <Checkbox
                    checked={settings.ui.timelineFollowPlayhead}
                    label="Scroll the timeline to follow the playhead"
                    onChange={(checked) =>
                      void save({ ui: { ...settings.ui, timelineFollowPlayhead: checked } })
                    }
                  />
                </Field>
                <Field
                  label="Scrubbing"
                  hint="Built previews (for a range the player can't play natively, or when the Editor is open) downscale to a lighter file — faster to seek within, lower picture quality. Only affects preview playback, never what gets exported."
                >
                  <Checkbox
                    checked={settings.ui.fastPreview}
                    label="Prefer fast scrubbing over preview picture quality"
                    onChange={(checked) => void save({ ui: { ...settings.ui, fastPreview: checked } })}
                  />
                </Field>
              </div>
            </section>
          )}

          {category === 'export' && (
            <section className="panel-section">
              <h3>Export</h3>
              <div className="rows">
                <Field
                  label="Encoding"
                  htmlFor="hw"
                  hint="Only used when a clip genuinely has to be re-encoded. Anything that can be copied always is, which is both faster and lossless."
                >
                  <Select
                    id="hw"
                    block
                    value={settings.export.hwAccel}
                    options={[
                      { value: 'auto', label: 'Automatic', hint: 'Use the graphics card when it helps' },
                      { value: 'none', label: 'Processor only' },
                      { value: 'nvenc', label: 'NVIDIA graphics card' },
                      { value: 'qsv', label: 'Intel graphics' },
                      { value: 'amf', label: 'AMD graphics card' },
                      { value: 'videotoolbox', label: 'Apple graphics' },
                      { value: 'vaapi', label: 'VA-API' }
                    ]}
                    onChange={(value) =>
                      void save({
                        export: {
                          ...settings.export,
                          hwAccel: value as AppSettings['export']['hwAccel']
                        }
                      })
                    }
                  />
                </Field>
                <Field label="When a batch finishes">
                  <Checkbox
                    checked={settings.ui.exportCompletionSound}
                    label="Play a short sound, alongside the toast and notification"
                    onChange={(checked) =>
                      void save({ ui: { ...settings.ui, exportCompletionSound: checked } })
                    }
                  />
                </Field>
              </div>
              <div className="hint">
                Quality, file type, folders and filenames are set per project on the Export page,
                because they usually change with the job rather than with the application.
              </div>
            </section>
          )}

          {category === 'downloads' && (
            <section className="panel-section">
              <h3>Downloads</h3>
              <div className="rows">
                <Field label="Save clips to">
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Input value={settings.outputDirectory} readOnly aria-label="Output folder" />
                    <Button
                      icon="folder"
                      onClick={async () => {
                        const dir = await window.api.pickOutputDirectory()
                        if (dir) void save({ outputDirectory: dir })
                      }}
                    >
                      Browse…
                    </Button>
                  </div>
                </Field>
                <Field
                  label="At once"
                  htmlFor="conc"
                  hint="More at once does not make any single clip faster, and puts more load on the platform. Two is a good default."
                >
                  <Select
                    id="conc"
                    block
                    value={String(settings.concurrency)}
                    options={[1, 2, 3, 4].map((n) => ({
                      value: String(n),
                      label: `${n} export${n === 1 ? '' : 's'} at a time`
                    }))}
                    onChange={(value) => void save({ concurrency: Number(value) })}
                  />
                </Field>
              </div>
            </section>
          )}

          {category === 'storage' && (
            <section className="panel-section">
              <h3>Storage</h3>
              <div className="rows">
                <Field label="Location">
                  <Input value={settings.cache.directory} readOnly aria-label="Cache location" />
                </Field>
                <Field
                  label="Keep up to"
                  htmlFor="cachemax"
                  hint="Downloaded pieces of a VOD are shared between clips that overlap, so the same seconds are never fetched twice."
                >
                  <Select
                    id="cachemax"
                    block
                    value={String(settings.cache.maxSizeBytes)}
                    options={[1, 2, 4, 8, 16, 32].map((gb) => ({
                      value: String(gb * 1024 * 1024 * 1024),
                      label: `${gb} GB`
                    }))}
                    onChange={(value) =>
                      void save({ cache: { ...settings.cache, maxSizeBytes: Number(value) } })
                    }
                  />
                </Field>
                <div className="hint">
                  Using {cache ? `${formatBytes(cache.sizeBytes)} across ${cache.entries} pieces` : '…'}.
                </div>
                <Button
                  icon="trash"
                  onClick={async () => {
                    setCache(await window.api.clearCache())
                  }}
                >
                  Clear stored pieces
                </Button>
              </div>
            </section>
          )}

          {category === 'shortcuts' && (
            <section className="panel-section">
              <h3>Keyboard</h3>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Keys</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(settings.shortcuts).map(([action, binding]) => (
                    <tr key={action}>
                      <td>{humanAction(action)}</td>
                      <td>
                        <Input
                          mono
                          size="compact"
                          value={binding}
                          aria-label={humanAction(action)}
                          onChange={(e) =>
                            void save({
                              shortcuts: { ...settings.shortcuts, [action]: e.target.value }
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button
                icon="refresh"
                onClick={() => void save({ shortcuts: { ...DEFAULT_SHORTCUTS } })}
              >
                Reset to defaults
              </Button>
            </section>
          )}

          {category === 'setup' && <SetupPanel />}

          {category === 'diagnostics' && (
            <section className="panel-section">
              <h3>Diagnostics</h3>
              <Notice tone="info">
                Everything below is here for when something has gone wrong. Nothing on this page
                needs changing for normal use.
              </Notice>

              <h3 style={{ marginTop: 'var(--space-4)' }}>Updates</h3>
              <div className="rows">
                <div className="hint">Ripper Clipper v{env?.appVersion ?? '—'}</div>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button
                    icon="refresh"
                    loading={updateStatus.state === 'checking'}
                    disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
                    onClick={async () => {
                      const status = await window.api.checkForUpdates()
                      if (status.state === 'not-available') {
                        toast({
                          kind: 'info',
                          title: "You're up to date",
                          message: `Running the latest version (v${env?.appVersion ?? '?'}).`
                        })
                      } else if (status.state === 'unsupported') {
                        toast({
                          kind: 'info',
                          title: 'Not available on this build',
                          message: 'Only the stable release channel checks for updates.'
                        })
                      } else if (status.state === 'error') {
                        toast({ kind: 'error', title: 'Could not check for updates', message: status.message })
                      }
                    }}
                  >
                    Check for updates
                  </Button>
                  {updateStatus.state === 'available' && (
                    <Button variant="primary" onClick={() => void window.api.downloadUpdate()}>
                      Download v{updateStatus.version}
                    </Button>
                  )}
                  {updateStatus.state === 'downloaded' && (
                    <Button variant="primary" onClick={() => void window.api.installUpdate()}>
                      Restart to install v{updateStatus.version}
                    </Button>
                  )}
                </div>
                {updateStatus.state === 'downloading' && (
                  <ProgressBar value={updateStatus.percent / 100} label={`Downloading update — ${updateStatus.percent}%`} />
                )}
              </div>

              <h3 style={{ marginTop: 'var(--space-4)' }}>Components</h3>
              <div className="rows">
                <ToolRow
                  label="Video engine (FFmpeg)"
                  value={settings.advanced.ffmpegPath ?? env?.ffmpeg.ffmpegPath ?? 'not found'}
                  found={Boolean(env?.ffmpeg.available)}
                  onBrowse={async () => {
                    const path = await window.api.pickFile('ffmpeg')
                    if (path) void save({ advanced: { ...settings.advanced, ffmpegPath: path } })
                  }}
                />
                <ToolRow
                  label="Media inspector (FFprobe)"
                  value={settings.advanced.ffprobePath ?? env?.ffmpeg.ffprobePath ?? 'not found'}
                  found={Boolean(env?.ffmpeg.available)}
                  onBrowse={async () => {
                    const path = await window.api.pickFile('ffprobe')
                    if (path) void save({ advanced: { ...settings.advanced, ffprobePath: path } })
                  }}
                />
                <ToolRow
                  label="VOD reader (yt-dlp)"
                  value={settings.advanced.ytDlpPath ?? env?.resolver.path ?? 'not found'}
                  found={Boolean(env?.resolver.available)}
                  onBrowse={async () => {
                    const path = await window.api.pickFile('ytdlp')
                    if (path) void save({ advanced: { ...settings.advanced, ytDlpPath: path } })
                  }}
                />
              </div>

              <h3 style={{ marginTop: 'var(--space-4)' }}>Hardware</h3>
              <div className="hint">
                Encoders this machine reports:{' '}
                {env?.ffmpeg.hwEncoders.length ? env.ffmpeg.hwEncoders.join(', ') : 'none'}.
              </div>

              <h3 style={{ marginTop: 'var(--space-4)' }}>Logs</h3>
              <div className="rows">
                <Field label="Detail" htmlFor="loglevel">
                  <Select
                    id="loglevel"
                    block
                    value={settings.advanced.logLevel}
                    options={(['debug', 'info', 'warn', 'error'] as LogLevel[]).map((l) => ({
                      value: l,
                      label: l
                    }))}
                    onChange={(value) =>
                      void save({ advanced: { ...settings.advanced, logLevel: value as LogLevel } })
                    }
                  />
                </Field>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <Button onClick={async () => setLogs(await window.api.tailLogs(200))}>
                    Show recent log
                  </Button>
                  <Button
                    icon="folder"
                    onClick={async () => window.api.revealPath(await window.api.logsPath())}
                  >
                    Open log folder
                  </Button>
                  <Button
                    icon="refresh"
                    onClick={async () => {
                      setEnv(await window.api.refreshEnv())
                      toast({
                        kind: 'info',
                        title: 'Checked again',
                        message: 'Detection finished.'
                      })
                    }}
                  >
                    Re-check everything
                  </Button>
                </div>
                {logs && <pre className="log-view">{logs}</pre>}
              </div>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function ToolRow({
  label,
  value,
  found,
  onBrowse
}: {
  label: string
  value: string
  found: boolean
  onBrowse: () => void
}): JSX.Element {
  return (
    <Field label={label}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <StatusBadge status={found ? 'ready' : 'failed'} label={found ? 'Found' : 'Not found'} />
        <Input mono readOnly value={value} aria-label={`${label} location`} />
        <Button size="compact" onClick={onBrowse}>
          Browse…
        </Button>
      </div>
    </Field>
  )
}

function humanAction(action: string): string {
  return action
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}
