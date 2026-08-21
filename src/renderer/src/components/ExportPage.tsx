import { useEffect, useMemo, useState } from 'react'
import { applyTemplate, buildFolderSegments, sanitizeFilename } from '@shared/filenames'
import { formatBytes } from '@shared/errors'
import { povLabel } from '@shared/pov'
import { planExport } from '@shared/povMapping'
import { formatDuration } from '@shared/time'
import type { ClipSegment, DiskSpaceInfo } from '@shared/types'
import { useStore } from '../store.js'
import QueuePanel from './QueuePanel.js'
import QualityPanel from './QualityPanel.js'
import { resolveWatermark, streamerFor } from '@shared/watermark'
import { Badge, Button, EmptyState, Notice, PageHeader, StatusBadge } from '../ui/index.js'

/**
 * Export: what is about to be written, before it is written.
 *
 * Every row spells out the two choices that are easiest to get wrong — which
 * POV the picture comes from and which one the sound comes from — plus the
 * audio decisions that will be applied and the exact filename it will land
 * under.
 */
export default function ExportPage({
  onExport,
  onGoToVideo
}: {
  onExport: (clips: ClipSegment[]) => void
  onGoToVideo: () => void
}): JSX.Element {
  const project = useStore((s) => s.project)
  const settings = useStore((s) => s.settings)
  const streamers = useStore((s) => s.streamers)
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  const outputDirectory = project?.outputDirectory ?? settings?.outputDirectory ?? ''

  const [diskSpace, setDiskSpace] = useState<DiskSpaceInfo | null>(null)
  useEffect(() => {
    if (!outputDirectory) return
    let cancelled = false
    void window.api.diskSpace(outputDirectory).then((info) => {
      if (!cancelled) setDiskSpace(info)
    })
    return () => {
      cancelled = true
    }
  }, [outputDirectory])
  // Below this, a batch of exports risks running out mid-way rather than
  // finishing — worth a warning before it starts, not a failure partway in.
  const LOW_SPACE_BYTES = 5 * 1024 * 1024 * 1024
  const lowSpace = diskSpace !== null && diskSpace.freeBytes < LOW_SPACE_BYTES

  const rows = useMemo(() => {
    if (!project) return []
    const padding = project.exportSettings.uncertainPaddingSeconds
    return project.clips.map((clip) => {
      const plan = planExport(clip, project.sources, { paddingSeconds: padding })
      const videoSource = plan?.video.source ?? null
      const audioSource = plan?.audio?.source ?? videoSource
      const format = videoSource?.formats?.find((f) => f.hasVideo)
      // A watermark has to be drawn onto the picture, which means the video is
      // processed rather than copied. That is worth saying — in those words,
      // not in FFmpeg's.
      const watermarked = videoSource
        ? Boolean(
            resolveWatermark(videoSource.watermark, streamerFor(streamers, videoSource)?.watermark)
          )
        : false
      const context = {
        name: clip.name,
        project: project.name,
        vodTitle: videoSource?.title,
        creator: videoSource?.creator,
        platform: videoSource?.platform,
        date: (videoSource?.createdAt ?? '').slice(0, 10),
        duration: formatDuration(clip.durationSeconds)
      }
      const folders = buildFolderSegments(project.exportSettings.folderTemplate, context)
      const file = `${sanitizeFilename(
        applyTemplate(project.exportSettings.filenameTemplate, context) || clip.name
      )}.${project.exportSettings.container}`
      return {
        clip,
        plan,
        videoSource,
        audioSource,
        resolution: format?.width && format?.height ? `${format.width}×${format.height}` : 'best available',
        fps: format?.fps ? `${Math.round(format.fps)} fps` : null,
        watermarked,
        path: [...folders, file].join(' / '),
        warnings: plan?.warnings ?? []
      }
    })
  }, [project, settings, streamers])

  if (!project || rows.length === 0) {
    return (
      <>
        <PageHeader title="Export" description="What is about to be written, before it is written." />
        <div className="page-body">
          <EmptyState
            icon="download"
            title="Nothing to export yet"
            description="Clips appear here as soon as you make one, with the exact filename and folder each will land in."
            action={{ label: 'Go to Video', icon: 'play', onClick: onGoToVideo }}
          />
        </div>
      </>
    )
  }

  const selected = rows.filter((r) => chosen.has(r.clip.id))
  const exportable = rows.filter((r) => r.plan)

  return (
    <>
      <PageHeader
        title="Export"
        description="Exactly what will be written, and where, before anything is written."
        meta={
          <>
            <span className="mono">{outputDirectory}</span>
            <span>{project.exportSettings.container.toUpperCase()}</span>
            {diskSpace && <span>{formatBytes(diskSpace.freeBytes)} free</span>}
            <span>
              Copied without re-encoding wherever the source allows it. A clip with a watermark is
              processed instead, which takes longer.
            </span>
          </>
        }
        actions={
          <>
            <Button
              disabled={selected.length === 0}
              onClick={() => onExport(selected.map((r) => r.clip))}
            >
              Export selected ({selected.length})
            </Button>
            <Button
              variant="primary"
              icon="download"
              disabled={exportable.length === 0}
              onClick={() => onExport(exportable.map((r) => r.clip))}
            >
              Export all ({exportable.length})
            </Button>
          </>
        }
      />

      <div className="page-body one export">
      <section>
        <h3>Ready to export</h3>
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th>Clip</th>
              <th>Picture from</th>
              <th>Sound from</th>
              <th>Quality</th>
              <th>Video</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.clip.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.clip.name}`}
                    checked={chosen.has(row.clip.id)}
                    onChange={(e) => {
                      const next = new Set(chosen)
                      if (e.target.checked) next.add(row.clip.id)
                      else next.delete(row.clip.id)
                      setChosen(next)
                    }}
                  />
                </td>
                <td>
                  {row.clip.name}
                  <div className="hint" style={{ margin: 0 }}>
                    {formatDuration(row.clip.durationSeconds)}
                  </div>
                </td>
                <td>
                  {row.videoSource ? (
                    povLabel(row.videoSource)
                  ) : (
                    <StatusBadge status="unavailable" label="No POV covers it" />
                  )}
                </td>
                <td>{row.audioSource ? povLabel(row.audioSource) : '—'}</td>
                <td>
                  {row.resolution}
                  {row.fps ? ` · ${row.fps}` : ''}
                </td>
                <td>
                  {row.watermarked ? (
                    <Badge tone="info" glyph="◐">
                      Processed
                    </Badge>
                  ) : (
                    <span className="dim">Copied</span>
                  )}
                </td>
                <td className="mono ellipsis" title={row.path}>
                  {row.path}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.some((r) => r.warnings.length > 0) && (
          <Notice tone="warning" title="Some clips are being adjusted">
            {rows
              .flatMap((r) => r.warnings)
              .slice(0, 4)
              .join(' ')}
          </Notice>
        )}

        {lowSpace && diskSpace && (
          <Notice tone="warning" title="Running low on disk space">
            Only {formatBytes(diskSpace.freeBytes)} free at {outputDirectory}. A large batch could
            run out partway through — free up space, or change the output folder in Settings →
            Downloads, before exporting a lot at once.
          </Notice>
        )}
      </section>

      <section>
        <h3>Output</h3>
        <QualityPanel />
      </section>

      <section>
        <h3>Queue</h3>
        <QueuePanel />
      </section>
      </div>
    </>
  )
}
