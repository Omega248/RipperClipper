import { useEffect, useState } from 'react'
import { formatBytes } from '@shared/errors'
import { DEFAULT_WHISPER_MODEL, estimateSeconds } from '@shared/transcription'
import type { WhisperModelId } from '@shared/transcription'
import { formatDuration } from '@shared/time'
import type { WhisperModelStatus } from '@shared/ipc'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import { Button, Notice, StatusBadge } from '../ui/index.js'

/**
 * Settings → the speech model used to find swearing.
 *
 * One of these has to exist before clips can be read, and which one is a real
 * trade the editor should make rather than have made for them — so each is
 * shown with its size and what a five-minute clip actually costs on this
 * machine, instead of vague labels like "better".
 */

/** The clip length the estimates are quoted against — a typical scene. */
const EXAMPLE_CLIP_SECONDS = 5 * 60

export default function SpeechModels(): JSX.Element {
  const toast = useStore((s) => s.toast)
  const progress = useStore((s) => s.toolProgress)
  const [models, setModels] = useState<WhisperModelStatus[] | null>(null)
  const [busy, setBusy] = useState<WhisperModelId | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      setModels(await window.api.whisperModelStatus())
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not check models'), message: message(err) })
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A finished download changes what is on disk, so re-read it.
  useEffect(() => {
    const last = Object.values(progress).at(-1)
    if (last && (last.stage === 'done' || last.stage === 'failed')) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress])

  const install = async (id: WhisperModelId): Promise<void> => {
    setBusy(id)
    try {
      setModels(await window.api.whisperModelInstall(id))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Download failed'), message: message(err) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: WhisperModelId): Promise<void> => {
    setBusy(id)
    try {
      setModels(await window.api.whisperModelRemove(id))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not remove it'), message: message(err) })
    } finally {
      setBusy(null)
    }
  }

  const anyInstalled = (models ?? []).some((m) => m.installed)

  return (
    <div className="panel-section">
      <h3>Speech model</h3>
      <div className="hint">
        Used to read clips aloud so swearing can be found. Everything runs on this machine — no
        audio is ever uploaded. Only the clip you are working on is read, never the whole VOD.
      </div>

      {models && !anyInstalled && (
        <Notice tone="info" title="No model downloaded yet">
          Until one is here, clips cannot be read and the censor list stays empty. The recommended
          one is a one-off download reused for every clip.
        </Notice>
      )}

      {models !== null && (
        <table className="grid">
          <thead>
            <tr>
              <th>Model</th>
              <th>Speed</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => {
              const line = progress[model.id]
              const active = busy === model.id
              return (
                <tr key={model.id}>
                  <td>
                    <div>
                      {model.label}
                      {model.id === DEFAULT_WHISPER_MODEL && !model.installed && ' · suggested'}
                    </div>
                    <div className="hint inline">{model.purpose}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {/* Concrete rather than adjectival: what a five-minute
                        clip actually costs is the thing being chosen between. */}
                    ~{formatDuration(estimateSeconds(EXAMPLE_CLIP_SECONDS, model.id))}
                    <div className="hint inline">per 5 min clip</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {active ? (
                      <StatusBadge status="processing" label="Downloading" />
                    ) : model.installed ? (
                      <StatusBadge status="ready" label={formatBytes(model.sizeBytes)} />
                    ) : (
                      <StatusBadge status="unavailable" label={`~${formatBytes(model.approxBytes)}`} />
                    )}
                    {active && line?.totalBytes ? (
                      <div className="hint inline">
                        {formatBytes(line.receivedBytes)} of {formatBytes(line.totalBytes)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {model.installed ? (
                      <Button size="compact" disabled={busy !== null} onClick={() => void remove(model.id)}>
                        Remove
                      </Button>
                    ) : (
                      <Button
                        size="compact"
                        loading={active}
                        disabled={busy !== null}
                        onClick={() => void install(model.id)}
                      >
                        Download
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
