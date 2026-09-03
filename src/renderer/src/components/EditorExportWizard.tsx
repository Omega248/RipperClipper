import { useEffect, useMemo, useState } from 'react'
import type { EditorCapabilities, EditorId, Support } from '@shared/editorCapabilities'
import { EDITOR_ORDER, SUPPORT_LABEL, SUPPORT_MARK } from '@shared/editorCapabilities'
import type { EditingProject } from '@shared/editingProject'
import { buildEditingProject } from '@shared/buildEditingProject'
import type { ExportedMedia } from '@shared/buildEditingProject'
import { formatTimecode } from '@shared/time'
import { resolveWatermark } from '@shared/watermark'
import type { WatermarkImage } from '@shared/watermark'
import type { ClipSegment } from '@shared/types'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import { Button, Checkbox, Dialog, Field, Notice, Select, Spinner } from '../ui/index.js'

/**
 * Hand a finished clip to an editing application.
 *
 * The four steps are the four decisions: which angles, what the watermark is
 * doing, which editor, and where it goes. Everything else the app already
 * knows — the sync offsets, the resolution, the frame rate, the file each
 * angle was written to.
 *
 * The one thing this screen must never say is "Encoding". Building a project
 * writes text files that point at video already on the disk; if that ever
 * starts taking a length of time proportional to the footage, something has
 * gone wrong upstream rather than here.
 */
export default function EditorExportWizard({
  clip,
  onClose
}: {
  clip: ClipSegment
  onClose: () => void
}): JSX.Element {
  const project = useStore((s) => s.project)
  const jobs = useStore((s) => s.jobs)
  const settings = useStore((s) => s.settings)
  const toast = useStore((s) => s.toast)
  const env = useStore((s) => s.env)
  const [images, setImages] = useState<WatermarkImage[]>([])

  useEffect(() => {
    void window.api.listWatermarkImages().then(setImages).catch(() => undefined)
  }, [])

  const [editors, setEditors] = useState<Record<EditorId, EditorCapabilities> | null>(null)
  const [editor, setEditor] = useState<EditorId>('resolve')
  const [copyMedia, setCopyMedia] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [issues, setIssues] = useState<Array<{ severity: string; message: string; fix?: string }>>([])
  const [done, setDone] = useState<{ directory: string; projectFile: string | null; notes: string[]; elapsedMs: number } | null>(null)

  useEffect(() => {
    void window.api.listEditors().then(setEditors)
  }, [])

  useEffect(() => {
    if (folder === null) setFolder(project?.outputDirectory ?? settings?.outputDirectory ?? null)
  }, [project?.outputDirectory, settings?.outputDirectory, folder])

  /*
   * The angles that actually have a file.
   *
   * A project can only point at media that exists, so the list of exportable
   * angles is the list of finished export jobs for this clip — not the list of
   * POVs loaded. Anything else would generate a project full of missing files.
   */
  const available = useMemo((): ExportedMedia[] => {
    const out: ExportedMedia[] = []
    for (const job of jobs) {
      if (job.clipId !== clip.id || !job.outputPath || !job.verification?.ok) continue
      const v = job.verification
      out.push({
        sourceId: job.sourceId,
        clipId: job.clipId,
        path: job.outputPath,
        fileName: job.outputPath.split(/[\\/]/).pop() ?? 'clip.mp4',
        durationSeconds: v.durationSeconds,
        width: v.video.width ?? 1920,
        height: v.video.height ?? 1080,
        fps: v.video.fps ?? 60,
        ...(v.video.codec ? { codec: v.video.codec } : {}),
        container: v.container,
        fileSizeBytes: v.sizeBytes
      })
    }
    return out
  }, [jobs, clip.id])

  const selected = chosen ?? new Set(available.map((m) => m.sourceId))
  const media = available.filter((m) => selected.has(m.sourceId))

  const built = useMemo((): EditingProject | null => {
    if (!project || media.length === 0) return null
    /*
     * Whose watermark travels with the project.
     *
     * The picture angle's, because that is the one whose frame the logo was
     * positioned against. `resolveWatermark` already knows the precedence —
     * this VOD's own override first, then the streamer's default — so this
     * asks it rather than reimplementing it.
     */
    const first = media[0]
    const source = project.sources.find((s) => s.id === first.sourceId)
    const chosen = source ? resolveWatermark(source.watermark, null) : null
    const image = chosen ? images.find((i) => i.id === chosen.config.imageId) : undefined
    const resolved =
      chosen && image
        ? {
            config: chosen.config,
            imagePath: image.path,
            imageWidth: image.width,
            imageHeight: image.height
          }
        : null
    return buildEditingProject({
      projectId: project.id,
      projectName: `${project.name} — ${clip.name}`,
      // The real version, not a placeholder: it is written into every
      // exported manifest, and "which build made this project" is the first
      // question asked when one of them turns out to be wrong.
      applicationVersion: env?.appVersion ?? 'unknown',
      clip,
      sources: project.sources,
      media,
      markers: project.markers,
      watermark:
        resolved && resolved.config.enabled
          ? {
              config: resolved.config,
              assetPath: resolved.imagePath,
              assetName: resolved.imagePath.split(/[\\/]/).pop() ?? 'watermark.png',
              imageWidth: resolved.imageWidth,
              imageHeight: resolved.imageHeight
            }
          : null,
      // The timeline takes the largest angle's frame, so nothing is scaled down
      // on the way in — an editor scales up far more gracefully than the app
      // could throw pixels away here.
      timeline: {
        width: Math.max(...media.map((m) => m.width)),
        height: Math.max(...media.map((m) => m.height)),
        fps: Math.max(...media.map((m) => m.fps))
      }
    })
  }, [project, media, clip, images, env?.appVersion])

  useEffect(() => {
    if (!built) return setIssues([])
    void window.api
      .validateEditingProject(built, editor)
      .then((r) => setIssues(r.issues))
      .catch(() => setIssues([]))
  }, [built, editor])

  const capability = editors?.[editor] ?? null
  const blocking = issues.filter((i) => i.severity === 'error')

  const run = async (): Promise<void> => {
    if (!built || !folder) return
    setBusy('Preparing the project…')
    try {
      const result = await window.api.exportEditingProject({
        project: built,
        editor,
        parentDirectory: folder,
        copyMedia
      })
      setDone(result)
    } catch (err) {
      toast({
        kind: 'error',
        title: title(err, 'Could not build the project'),
        message: message(err)
      })
    } finally {
      setBusy(null)
    }
  }

  if (done) {
    return (
      <Dialog
        title="Project ready"
        size="medium"
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" icon="folder" onClick={() => void window.api.revealPath(done.projectFile ?? done.directory)}>
              Show me the folder
            </Button>
          </>
        }
      >
        <div className="wizard">
          <Notice tone="success">
            {built?.povs.length} angle{built?.povs.length === 1 ? '' : 's'} written in{' '}
            {(done.elapsedMs / 1000).toFixed(1)}s. No video was read or re-encoded — a project is
            paths and numbers.
          </Notice>
          <p className="dim mono ellipsis">{done.directory}</p>
          {done.notes.map((note) => (
            <Notice key={note} tone="info">
              {note}
            </Notice>
          ))}
          <p className="hint">
            README.html in that folder has the steps, every angle’s sync offset, and the exact
            watermark numbers.
          </p>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={`Send “${clip.name}” to an editor`}
      size="large"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="download"
            loading={busy !== null}
            disabled={!built || !folder || blocking.length > 0}
            onClick={() => void run()}
          >
            {busy ?? 'Build project'}
          </Button>
        </>
      }
    >
      <div className="wizard">
        <section>
          <h3>Angles</h3>
          {available.length === 0 ? (
            <Notice tone="warning">
              Nothing has been exported for this clip yet. Export the angles you want first — an
              editing project points at files, so the files have to exist.
            </Notice>
          ) : (
            <ul className="wizard-povs">
              {available.map((m) => {
                const source = project?.sources.find((s) => s.id === m.sourceId)
                const pov = built?.povs.find((p) => p.mediaId === `media_${m.sourceId}`)
                return (
                  <li key={m.sourceId}>
                    <Checkbox
                      checked={selected.has(m.sourceId)}
                      label={source?.creator || source?.title || m.fileName}
                      onChange={(on) => {
                        const next = new Set(selected)
                        if (on) next.add(m.sourceId)
                        else next.delete(m.sourceId)
                        setChosen(next)
                      }}
                    />
                    <span className="dim">
                      {source?.platform} · {m.width}×{m.height} · {m.fps} fps ·{' '}
                      {formatTimecode(m.durationSeconds, { millis: false })}
                    </span>
                    {pov && (
                      <span className="mono dim">
                        {pov.syncOffsetSeconds >= 0 ? '+' : ''}
                        {pov.syncOffsetSeconds.toFixed(2)}s
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h3>Watermark</h3>
          {built?.watermark && built.watermark.config.enabled ? (
            <p className="dim">
              {built.watermark.assetName} — {(built.watermark.transform.width * 100).toFixed(0)}% of
              the frame at {(built.watermark.transform.opacity * 100).toFixed(0)}% opacity,{' '}
              {built.watermark.transform.anchor.replace('-', ' ')}. It travels as an overlay, so it
              stays adjustable in the editor and nothing is burnt into the video.
            </p>
          ) : (
            <p className="dim">No watermark configured — the angles go across as they are.</p>
          )}
        </section>

        <section>
          <h3>Editor</h3>
          <Field label="Editing application">
            <Select
              value={editor}
              onChange={(v) => setEditor(v as EditorId)}
              options={EDITOR_ORDER.filter((id) => editors?.[id]).map((id) => ({
                value: id,
                label: editors![id].name
              }))}
            />
          </Field>
          {capability && (
            <>
              <p className="dim">{capability.mechanism}.</p>
              <ul className="wizard-caps">
                <Cap label="Media import" value={capability.mediaImport} />
                <Cap label="Timeline" value={capability.timelineCreation} />
                <Cap label="Watermark overlay" value={capability.imageOverlay} />
                <Cap label="Position and size" value={capability.transform} />
                <Cap label="Markers" value={capability.markers} />
              </ul>
              {capability.limitations.map((l) => (
                <Notice key={l} tone="warning">
                  {l}
                </Notice>
              ))}
            </>
          )}
        </section>

        <section>
          <h3>Where</h3>
          <div className="wizard-folder">
            <span className="mono ellipsis dim">{folder ?? 'Choose a folder…'}</span>
            <Button
              size="compact"
              icon="folder"
              onClick={() => void window.api.chooseEditingProjectFolder().then((f) => f && setFolder(f))}
            >
              Change
            </Button>
          </div>
          <Checkbox
            checked={copyMedia}
            label="Copy the angles into the project folder"
            onChange={setCopyMedia}
          />
          <p className="hint">
            Off by default: the files are already on this disk, and copying twenty angles is the one
            part of this that would actually take time and space. Turn it on to move the folder to
            another machine.
          </p>
        </section>

        {issues.length > 0 && (
          <section>
            <h3>Before it is built</h3>
            {issues.map((issue) => (
              <Notice key={issue.message} tone={issue.severity === 'error' ? 'danger' : 'warning'}>
                {issue.message}
                {issue.fix ? ` ${issue.fix}` : ''}
              </Notice>
            ))}
          </section>
        )}

        {busy && (
          <p className="dim">
            <Spinner /> {busy}
          </p>
        )}
      </div>
    </Dialog>
  )
}

function Cap({ label, value }: { label: string; value: Support }): JSX.Element {
  return (
    <li className={`wizard-cap is-${value}`}>
      <span aria-hidden="true">{SUPPORT_MARK[value]}</span>
      <span>{label}</span>
      <span className="dim">{SUPPORT_LABEL[value]}</span>
    </li>
  )
}
