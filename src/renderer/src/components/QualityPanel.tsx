import { useState } from 'react'
import { formatBytes } from '@shared/errors'
import { createId } from '@shared/clips'
import type {
  ExportContainer,
  ExportSettings,
  CutMode,
  QualityPreference,
  StreamInfo
} from '@shared/types'
import { applyTemplate, buildFolderSegments } from '@shared/filenames'
import { useActiveSource, useStore } from '../store.js'
import { Button, EmptyState, Field, IconButton, Input, PromptDialog, Select } from '../ui/index.js'

const QUALITIES: Array<{ value: QualityPreference; label: string }> = [
  { value: 'best', label: 'Best available' },
  { value: '1440', label: '1440p or below' },
  { value: '1080', label: '1080p or below' },
  { value: '720', label: '720p or below' },
  { value: 'audio-only', label: 'Audio only' }
]

/** Export settings for the current project + the *actually inspected* source. */
/** The structures editors actually ask for, plus a free-text escape hatch. */
const FOLDER_PRESETS = [
  { label: 'All in one folder', value: '' },
  { label: 'Folder per project', value: '{Project}' },
  { label: 'Project → folder per POV', value: '{Project}/{Creator}' },
  { label: 'Project → folder per clip', value: '{Project}/{Name}' },
  { label: 'Project → clip → POV', value: '{Project}/{Name}/{Creator}' },
  { label: 'Folder per POV only', value: '{Creator}' },
  { label: 'Folder per clip only', value: '{Name}' }
]

/** What the next export will actually be called, folders and all. */
function previewPath(settings: ExportSettings): string {
  const ctx = {
    name: 'MRPD Shootout',
    project: 'Bank Robbery',
    creator: 'Streamer',
    vodTitle: 'Ranked Session',
    platform: 'twitch',
    date: '2026-08-18',
    index: 1
  }
  const folders = buildFolderSegments(settings.folderTemplate ?? '', ctx)
  const file = `${applyTemplate(settings.filenameTemplate || '{Name}', ctx)}.${settings.container}`
  return [...folders, file].join(' / ')
}

export default function QualityPanel(): JSX.Element {
  const source = useActiveSource()
  const project = useStore((s) => s.project)
  const setSourceFormats = useStore((s) => s.setSourceFormats)
  const toast = useStore((s) => s.toast)
  const appSettings = useStore((s) => s.settings)
  const setAppSettings = useStore((s) => s.setSettings)
  const [inspecting, setInspecting] = useState(false)
  const [applyPresetId, setApplyPresetId] = useState('')
  const [savePresetPrompt, setSavePresetPrompt] = useState(false)

  if (!project) return <EmptyState icon="file" title="No project loaded" />

  const settings = project.exportSettings
  const patch = (next: Partial<typeof settings>): void => {
    useStore.setState({
      project: { ...project, exportSettings: { ...settings, ...next } },
      dirty: true
    })
  }

  const presets = appSettings?.exportPresets ?? []

  const savePreset = async (name: string): Promise<void> => {
    if (!appSettings || name.trim() === '') return
    const preset = { id: createId('preset'), name: name.trim(), settings: { ...settings } }
    try {
      const next = await window.api.updateSettings({
        exportPresets: [...appSettings.exportPresets, preset]
      })
      setAppSettings(next)
      toast({ kind: 'success', title: 'Preset saved', message: `"${preset.name}" is ready to reuse.` })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not save that preset'), message: message(err) })
    }
  }

  const deletePreset = async (id: string): Promise<void> => {
    if (!appSettings) return
    try {
      const next = await window.api.updateSettings({
        exportPresets: appSettings.exportPresets.filter((p) => p.id !== id)
      })
      setAppSettings(next)
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not delete that preset'), message: message(err) })
    }
  }

  /** Toggles a preset as the one auto-applied to a project's export settings when it's created. */
  const setDefaultPreset = async (id: string | null): Promise<void> => {
    if (!appSettings) return
    try {
      const next = await window.api.updateSettings({
        exportPresets: appSettings.exportPresets.map((p) => {
          const { isDefault: _drop, ...rest } = p
          return p.id === id ? { ...rest, isDefault: true } : rest
        })
      })
      setAppSettings(next)
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not set the default preset'), message: message(err) })
    }
  }

  const inspect = async (): Promise<void> => {
    if (!source) return
    setInspecting(true)
    try {
      const formats = await window.api.inspectFormats(source)
      setSourceFormats(source.id, formats)
      toast({
        kind: 'success',
        title: 'Source inspected',
        message: `${formats.length} stream${formats.length === 1 ? '' : 's'} reported by the platform.`
      })
    } catch (err) {
      toast({
        kind: 'error',
        title: title(err, 'Inspection failed'),
        message: message(err)
      })
    } finally {
      setInspecting(false)
    }
  }

  const video = (source?.formats ?? []).filter((f) => f.hasVideo).sort(byQuality)
  const audio = (source?.formats ?? []).filter((f) => f.hasAudio && !f.hasVideo).sort(byQuality)

  return (
    <div>
      <div className="panel-section">
        <h3>Presets</h3>
        <div className="rows">
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Field label="Apply a saved preset" htmlFor="preset-apply">
                <Select
                  id="preset-apply"
                  block
                  disabled={presets.length === 0}
                  value={applyPresetId}
                  options={[
                    { value: '', label: presets.length === 0 ? 'No presets saved yet' : 'Choose one…' },
                    ...presets.map((p) => ({ value: p.id, label: p.name }))
                  ]}
                  onChange={(value) => {
                    const preset = presets.find((p) => p.id === value)
                    if (preset) patch(preset.settings)
                    setApplyPresetId('')
                  }}
                />
              </Field>
            </div>
            <Button icon="save" onClick={() => setSavePresetPrompt(true)}>
              Save current as preset…
            </Button>
          </div>
          {presets.length > 0 && (
            <ul className="version-history-list">
              {presets.map((p) => (
                <li key={p.id} className="version-history-row">
                  <span>
                    {p.name}
                    {p.isDefault && ' · default'}
                  </span>
                  <IconButton
                    icon="star"
                    size="compact"
                    selected={p.isDefault}
                    label={p.isDefault ? `"${p.name}" is the default preset` : `Make "${p.name}" the default preset`}
                    onClick={() => void setDefaultPreset(p.isDefault ? null : p.id)}
                  />
                  <IconButton
                    icon="close"
                    size="compact"
                    label={`Delete preset "${p.name}"`}
                    onClick={() => void deletePreset(p.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="panel-section">
        <h3>Quality and format</h3>
        <div className="rows">
          <Field label="Quality" htmlFor="q">
            <Select
              id="q"
              block
              value={settings.quality}
              options={QUALITIES.map((q) => ({ value: q.value, label: q.label }))}
              onChange={(value) => patch({ quality: value as QualityPreference })}
            />
          </Field>
          <Field label="File type" htmlFor="container">
            <Select
              id="container"
              block
              value={settings.container}
              options={[
                { value: 'mp4', label: 'MP4', hint: 'Plays everywhere' },
                { value: 'mkv', label: 'MKV', hint: 'Keeps any format the source used' }
              ]}
              onChange={(value) => patch({ container: value as ExportContainer })}
            />
          </Field>
          <Field
            label="Cutting"
            htmlFor="cut"
            hint="Copying is instant and lossless but can only cut at certain points; re-encoding is exact but slower."
          >
            <Select
              id="cut"
              block
              value={settings.cutMode}
              options={[
                { value: 'smart', label: 'Smart', hint: 'Copy unless the cut would drift' },
                { value: 'copy', label: 'Copy only', hint: 'Never re-encode' },
                { value: 'precise', label: 'Exact', hint: 'Always re-encode' }
              ]}
              onChange={(value) => patch({ cutMode: value as CutMode })}
            />
          </Field>
          <Field
            label="Cut tolerance"
            htmlFor="tol"
            hint="How far a copied cut may land from where you marked it, in seconds."
          >
            <Input
              id="tol"
              mono
              type="number"
              min={0}
              max={10}
              step={0.1}
              value={settings.keyframeToleranceSeconds}
              onChange={(e) => patch({ keyframeToleranceSeconds: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Safety padding"
            htmlFor="pad"
            hint="Extra seconds at each end, added only to POVs whose alignment is a guess. A hand-aligned angle is always cut exactly. Set 0 to always cut tight."
          >
            <Input
              id="pad"
              mono
              type="number"
              min={0}
              max={30}
              step={0.5}
              value={settings.uncertainPaddingSeconds}
              onChange={(e) => patch({ uncertainPaddingSeconds: Number(e.target.value) })}
            />
          </Field>
        </div>
      </div>

      <div className="panel-section">
        <h3>Names and folders</h3>
        <div className="rows">
          <Field label="Folders" htmlFor="folders">
            <Select
              id="folders"
              block
              value={
                FOLDER_PRESETS.some((p) => p.value === settings.folderTemplate)
                  ? settings.folderTemplate
                  : 'custom'
              }
              options={[
                ...FOLDER_PRESETS.map((preset) => ({ value: preset.value, label: preset.label })),
                { value: 'custom', label: 'Custom…' }
              ]}
              onChange={(value) => {
                if (value === 'custom') return
                patch({ folderTemplate: value })
              }}
            />
          </Field>
          <Field label="Folder pattern" htmlFor="folder-tpl">
            <Input
              id="folder-tpl"
              placeholder="(no folders)"
              value={settings.folderTemplate}
              onChange={(e) => patch({ folderTemplate: e.target.value })}
            />
          </Field>
          <Field
            label="Filename"
            htmlFor="tpl"
            hint="Available: {Name} {VODTitle} {Creator} {Platform} {Date} {Index} {Start} {End} {Duration}. The extension is added for you."
          >
            <Input
              id="tpl"
              value={settings.filenameTemplate}
              onChange={(e) => patch({ filenameTemplate: e.target.value })}
            />
          </Field>
          <div className="hint mono">Example: {previewPath(settings)}</div>
        </div>
      </div>

      <div className="panel-section">
        <h3>What this source offers</h3>
        {!source && <div className="hint">Load a VOD first.</div>}
        {source && !source.formatsInspected && (
          <div className="rows">
            <div className="hint">
              Qualities are only listed once the source has actually been asked — Ripper Clipper
              never guesses what a platform offers.
            </div>
            <Button icon="search" loading={inspecting} onClick={() => void inspect()}>
              Check available qualities
            </Button>
          </div>
        )}
        {source?.formatsInspected && (
          <>
            <table className="grid">
              <thead>
                <tr>
                  <th>Video</th>
                  <th>Codec</th>
                  <th>FPS</th>
                  <th>Bitrate</th>
                </tr>
              </thead>
              <tbody>
                {video.slice(0, 8).map((f) => (
                  <tr key={f.id}>
                    <td>{f.width && f.height ? `${f.width} × ${f.height}` : f.label}</td>
                    <td>{f.codec ?? '—'}</td>
                    <td>{f.fps ? Math.round(f.fps) : '—'}</td>
                    <td>{f.bitrate ? `${(f.bitrate / 1_000_000).toFixed(1)} Mbps` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {audio.length > 0 && (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Audio</th>
                    <th>Rate</th>
                    <th>Ch</th>
                    <th>Bitrate</th>
                  </tr>
                </thead>
                <tbody>
                  {audio.slice(0, 5).map((f) => (
                    <tr key={f.id}>
                      <td>{f.codec ?? f.label}</td>
                      <td>{f.sampleRate ? `${Math.round(f.sampleRate / 1000)} kHz` : '—'}</td>
                      <td>{f.channels ?? '—'}</td>
                      <td>{f.bitrate ? `${Math.round(f.bitrate / 1000)} kbps` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {video[0]?.filesize && (
              <div className="hint">
                The whole broadcast at this quality would be about {formatBytes(video[0].filesize)}.
                Only the parts your clips cover are ever downloaded.
              </div>
            )}
            <Button size="compact" icon="refresh" onClick={() => void inspect()}>
              Check again
            </Button>
          </>
        )}
      </div>

      {source && source.capabilities.notes.length > 0 && (
        <div className="panel-section">
          <h3>Notes about this platform</h3>
          <ul className="hint" style={{ paddingLeft: 16 }}>
            {source.capabilities.notes.map((note) => (
              <li key={note} style={{ marginBottom: 4 }}>
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {savePresetPrompt && (
        <PromptDialog
          title="Save export preset"
          description="Quality, container, cutting mode, filenames and folders — everything currently set on this page."
          label="Preset name"
          confirmLabel="Save"
          onCancel={() => setSavePresetPrompt(false)}
          onConfirm={(value) => {
            void savePreset(value)
            setSavePresetPrompt(false)
          }}
        />
      )}
    </div>
  )
}

function byQuality(a: StreamInfo, b: StreamInfo): number {
  const areaA = (a.width ?? 0) * (a.height ?? 0)
  const areaB = (b.width ?? 0) * (b.height ?? 0)
  if (areaA !== areaB) return areaB - areaA
  return (b.bitrate ?? 0) - (a.bitrate ?? 0)
}

export function title(err: unknown, fallback: string): string {
  return err && typeof err === 'object' && 'title' in err ? String((err as { title: string }).title) : fallback
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
