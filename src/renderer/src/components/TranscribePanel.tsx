import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODELS,
  estimateSeconds,
  modelSpec,
  suggestedModel
} from '@shared/transcription'
import type { TranscribeProgress, WhisperModelId } from '@shared/transcription'
import { formatDuration } from '@shared/time'
import type { WhisperModelStatus } from '@shared/ipc'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { message, title } from './QualityPanel.js'
import { formatBytes } from './HealthPage.js'
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Notice,
  ProgressBar,
  Section,
  Select
} from '../ui/index.js'

/**
 * Transcribing POVs on this machine.
 *
 * Nothing here starts on its own. Transcription is minutes of real work on a
 * multi-hour VOD, so it is always the editor's decision — but once started it
 * is genuinely fast, and the panel reports the *measured* rate rather than a
 * spinner, because "25x real time, four minutes left" is the difference
 * between waiting and wondering whether it has hung.
 *
 * Twitch and Kick publish no captions at all, so for those POVs this is the
 * only way to search what was said. YouTube POVs usually have captions
 * already and will simply show as transcribed.
 */
export default function TranscribePanel(): JSX.Element {
  const project = useStore((s) => s.project)
  const env = useStore((s) => s.env)
  const toast = useStore((s) => s.toast)

  const [models, setModels] = useState<WhisperModelStatus[] | null>(null)
  const [model, setModel] = useState<WhisperModelId>(DEFAULT_WHISPER_MODEL)
  const [useVad, setUseVad] = useState(true)
  const [progress, setProgress] = useState<Record<string, TranscribeProgress>>({})
  const [installing, setInstalling] = useState<WhisperModelId | null>(null)

  const sources = project?.sources ?? []
  // FFmpeg's NVENC probe is a real test of this machine's NVIDIA stack, so it
  // doubles as the "will the GPU build help" signal the estimates need.
  const hasGpu = (env?.ffmpeg.hwEncoders ?? []).some((e) => e.includes('nvenc'))
  const whisperInstalled = true

  const refreshModels = useCallback(async (): Promise<void> => {
    try {
      const status = await window.api.whisperModelStatus()
      setModels(status)
      // Prefer something already downloaded over the default nobody has yet.
      const installed = status.filter((m) => m.installed)
      if (installed.length > 0 && !installed.some((m) => m.id === model)) {
        setModel(installed[0].id)
      }
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not read models'), message: message(err) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  useEffect(() => {
    // Progress arrives as an event because a job outlives any single call.
    return window.api.onTranscribeProgress((p) =>
      setProgress((prev) => ({ ...prev, [p.sourceId]: p }))
    )
  }, [])

  const suggestion = useMemo(
    () => suggestedModel({ hasGpu, cores: navigator.hardwareConcurrency || 8 }),
    [hasGpu]
  )

  const installModel = async (id: WhisperModelId): Promise<void> => {
    setInstalling(id)
    try {
      setModels(await window.api.whisperModelInstall(id))
      setModel(id)
      toast({
        kind: 'success',
        title: `${modelSpec(id).label} is ready`,
        message: 'It stays on this machine — nothing is uploaded when you transcribe.'
      })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Download failed'), message: message(err) })
    } finally {
      setInstalling(null)
    }
  }

  const transcribe = async (sourceId: string): Promise<void> => {
    const source = sources.find((s) => s.id === sourceId)
    if (!source) return
    try {
      await window.api.transcribeStart({ source, model, language: 'auto', useVad })
      toast({
        kind: 'success',
        title: 'Transcribed',
        message: `${povLabel(source, sources.indexOf(source))} is now searchable by what was said.`
      })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Transcription failed'), message: message(err) })
    } finally {
      setProgress((prev) => {
        const next = { ...prev }
        delete next[sourceId]
        return next
      })
    }
  }

  const installedModels = models?.filter((m) => m.installed) ?? []
  const chosen = modelSpec(model)

  return (
    <Section
      title="Transcription"
      description="Search what was said. Runs entirely on this machine — no audio is uploaded."
    >
      {hasGpu ? (
        <Notice tone="success">
          A CUDA GPU was detected. The recommended model runs at roughly 25x real time here — a
          six-hour VOD in about a quarter of an hour.
        </Notice>
      ) : (
        <Notice tone="info">
          No CUDA GPU detected, so transcription runs on the processor. Expect roughly{' '}
          {modelSpec(suggestion).cpuRealtimeFactor}x real time with the suggested model.
        </Notice>
      )}

      <div className="transcribe-controls">
        <Field label="Model">
          <Select
            size="compact"
            label="Speech model"
            value={model}
            options={WHISPER_MODELS.map((m) => ({
              value: m.id,
              label: `${m.label}${models?.find((s) => s.id === m.id)?.installed ? '' : ' — not downloaded'}`
            }))}
            onChange={(v) => setModel(v as WhisperModelId)}
          />
        </Field>
        <Checkbox
          checked={useVad}
          onChange={setUseVad}
          label="Skip silence (faster on quiet VODs)"
        />
      </div>

      <p className="hint">
        {chosen.purpose} {model === suggestion && <strong>Suggested for this machine.</strong>}
      </p>

      {models && !models.find((m) => m.id === model)?.installed && (
        <Notice tone="warning" title={`${chosen.label} is not downloaded`}>
          {formatBytes(chosen.approxBytes)} — downloaded once and reused for every VOD.
          <Button
            size="compact"
            loading={installing === model}
            onClick={() => void installModel(model)}
          >
            Download
          </Button>
        </Notice>
      )}

      <ul className="health-list transcribe-list">
        {sources.map((source, index) => {
          const active = progress[source.id]
          const seconds = estimateSeconds(source.durationSeconds, model, hasGpu)
          return (
            <li key={source.id}>
              <div className="health-row">
                <span className="ellipsis">{povLabel(source, index)}</span>
                <Badge>{source.platform}</Badge>
                {active ? (
                  <span className="transcribe-progress">
                    <ProgressBar value={active.fraction} />
                    <span className="mono">
                      {active.realtimeFactor ? `${active.realtimeFactor.toFixed(1)}x` : '…'}
                      {active.etaSeconds !== null && ` · ${formatDuration(active.etaSeconds)} left`}
                    </span>
                  </span>
                ) : (
                  <span className="health-row-meta mono">~{formatDuration(seconds)}</span>
                )}
                {active ? (
                  <Button size="compact" onClick={() => void window.api.transcribeCancel(source.id)}>
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="compact"
                    disabled={installedModels.length === 0 || !whisperInstalled}
                    onClick={() => void transcribe(source.id)}
                  >
                    Transcribe
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {sources.length === 0 && <p className="hint">No POVs loaded yet.</p>}
    </Section>
  )
}
