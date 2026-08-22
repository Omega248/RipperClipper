import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/errors'
import type { ToolId, ToolStatus } from '@shared/ipc'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import { Button, Checkbox, Notice, ProgressBar, Spinner, StatusBadge } from '../ui/index.js'

/**
 * Settings → Setup.
 *
 * The components Ripper Clipper needs, described by what they let the editor do
 * rather than by their names. "yt-dlp" means nothing to someone cutting a
 * clip; "reading VOD links" does. The real names, versions, publishers and
 * paths are in Diagnostics.
 */

/** What each component is *for*, in the editor's terms. */
const PURPOSE: Record<ToolId, { name: string; what: string }> = {
  ffmpeg: { name: 'Video engine', what: 'Cuts and writes the finished files' },
  ytdlp: { name: 'VOD reader', what: 'Turns a link into something playable' },
  whisper: { name: 'Speech engine', what: 'Transcribes VODs on this machine — optional' }
}

export default function SetupPanel(): JSX.Element {
  const env = useStore((s) => s.env)
  const settings = useStore((s) => s.settings)
  const progress = useStore((s) => s.toolProgress)
  const setSettings = useStore((s) => s.setSettings)
  const setEnv = useStore((s) => s.setEnv)
  const toast = useStore((s) => s.toast)

  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [running, setRunning] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      setTools(await window.api.toolStatus())
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not check setup'), message: message(err) })
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A finished install changes what is on disk, so re-read it.
  useEffect(() => {
    const last = Object.values(progress).at(-1)
    if (last && (last.stage === 'done' || last.stage === 'failed')) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress])

  const install = async (ids: ToolId[]): Promise<void> => {
    if (ids.length === 0) return
    setRunning(true)
    try {
      setEnv(await window.api.installTools(ids))
      await refresh()
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Setup did not finish'), message: message(err) })
    } finally {
      setRunning(false)
    }
  }

  const missing = (tools ?? []).filter((t) => !t.installed && !t.unsupported)
  const totalBytes = missing.reduce((n, t) => n + t.approxBytes, 0)

  return (
    <div className="panel-section">
      <h3>Setup</h3>
      <div className="hint">
        Everything here installs itself the first time you run Ripper Clipper, into the
        application&apos;s own folder. Nothing system-wide is touched and nothing needs installing
        by hand.
      </div>

      {tools === null && <Spinner label="Checking…" />}

      {tools !== null && (
        <table className="grid">
          <thead>
            <tr>
              <th>Component</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => {
              const purpose = PURPOSE[tool.id]
              const line = progress[tool.id]
              const active = line && line.stage !== 'done' && line.stage !== 'failed'
              return (
                <tr key={tool.id}>
                  <td>
                    <div>{purpose?.name ?? tool.label}</div>
                    <div className="hint inline">{purpose?.what ?? tool.purpose}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {tool.unsupported ? (
                      <StatusBadge status="unavailable" label="Not available here" />
                    ) : active ? (
                      <StatusBadge status="processing" label="Setting up" />
                    ) : tool.installed ? (
                      <StatusBadge status="ready" label={tool.bundled ? 'Included' : 'Ready'} />
                    ) : (
                      <StatusBadge status="unavailable" label={`Missing · ~${formatBytes(tool.approxBytes)}`} />
                    )}
                    {active && (
                      <div style={{ marginTop: 6, minWidth: 140 }}>
                        <ProgressBar
                          value={line?.totalBytes ? line.receivedBytes / line.totalBytes : undefined}
                          label={`${purpose?.name ?? tool.label} setup`}
                        />
                      </div>
                    )}
                  </td>
                  <td>
                    {!tool.unsupported && (
                      <Button size="compact" disabled={running} onClick={() => void install([tool.id])}>
                        {tool.installed ? 'Reinstall' : 'Set up'}
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <div className="rows">
        <Button
          variant="primary"
          icon="download"
          loading={running}
          disabled={missing.length === 0}
          onClick={() => void install(missing.map((t) => t.id))}
        >
          {missing.length === 0
            ? 'Everything is set up'
            : `Set up what is missing (~${formatBytes(totalBytes)})`}
        </Button>
        {running && (
          <Button onClick={() => void window.api.cancelToolInstall()}>Cancel</Button>
        )}
        <Checkbox
          checked={settings?.advanced.autoInstallTools ?? true}
          label="Set up anything missing automatically when the app starts"
          onChange={async (checked) => {
            if (!settings) return
            setSettings(
              await window.api.updateSettings({
                advanced: { ...settings.advanced, autoInstallTools: checked }
              })
            )
          }}
        />
      </div>

      {env && (!env.ffmpeg.available || !env.resolver.available) && (
        <Notice tone="warning" title="Something still is not working">
          {!env.ffmpeg.available && 'Exporting is unavailable until the video engine is set up. '}
          {!env.resolver.available && 'VOD links cannot be opened until the VOD reader is set up. '}
          Try again above, or check Diagnostics.
        </Notice>
      )}
    </div>
  )
}
