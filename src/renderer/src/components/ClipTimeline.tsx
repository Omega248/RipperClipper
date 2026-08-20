import { useMemo } from 'react'
import { formatTimecode } from '@shared/time'
import { POV_STATUS_LABEL } from '@shared/povMapping'
import type { ClipPovMapping, ClipSegment } from '@shared/types'
import { useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import { povLabel } from './PovBar.js'
import { Button } from '../ui/index.js'

interface Props {
  clip: ClipSegment
  onAlignClip: () => void
}

/**
 * The clip's own workspace: one lane per POV, positioned by real-world timing,
 * on the clip's relative clock (00:00 is the start of the clip, not of anyone's
 * VOD). Lanes show at a glance who covers the whole moment, who joined late and
 * who was not recording; clicking one switches to that angle at the same
 * instant, which is the multi-POV equivalent of cutting between cameras.
 */
export default function ClipTimeline({ clip, onAlignClip }: Props): JSX.Element | null {
  const sources = useStore((s) => s.project?.sources) ?? []
  const activeSourceId = useStore((s) => s.activeSourceId)
  const currentTime = useStore((s) => s.currentTime)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setCurrentTime = useStore((s) => s.setCurrentTime)

  const duration = Math.max(0.001, clip.endSeconds - clip.startSeconds)
  const mappings = clip.povMappings ?? []

  /**
   * Where the playhead sits inside the clip, 0..1. Derived from whichever POV
   * is playing, through that POV's own mapping, so switching angles does not
   * move it.
   */
  const playheadFraction = useMemo(() => {
    const active = mappings.find((m) => m.sourceId === activeSourceId)
    if (!active || !covers(active)) return null
    const span = active.requestedEndSeconds - active.requestedStartSeconds
    if (span <= 0) return null
    const fraction = (currentTime - active.requestedStartSeconds) / span
    return fraction >= -0.02 && fraction <= 1.02 ? Math.min(1, Math.max(0, fraction)) : null
  }, [mappings, activeSourceId, currentTime])

  if (mappings.length === 0) return null

  /** Clip-relative seconds → that POV's own VOD time, then seek there. */
  const seekTo = (mapping: ClipPovMapping, clipSeconds: number): void => {
    const target = mapping.requestedStartSeconds + clipSeconds
    if (mapping.sourceId !== activeSourceId) setActiveSource(mapping.sourceId)
    setCurrentTime(target)
    playerBus.seek(target)
  }

  const onLaneClick = (mapping: ClipPovMapping, event: React.MouseEvent<HTMLDivElement>): void => {
    if (!covers(mapping)) return
    const box = event.currentTarget.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    seekTo(mapping, fraction * duration)
  }

  const ticks = tickSeconds(duration)

  return (
    <div className="clip-timeline">
      <div className="clip-timeline-head">
        <strong>{clip.name}</strong>
        <span className="hint inline mono">
          {formatTimecode(0)} → {formatTimecode(duration)} · clip time
        </span>
        <span className="spacer" />
        <span className="hint inline">
          {mappings.filter(covers).length} of {mappings.length} POVs cover this clip
        </span>
        <Button
          size="compact"
          icon="waveform"
          onClick={onAlignClip}
          disabled={mappings.length < 2}
          title="Line a POV up against this clip's sound — this clip only"
        >
          Align this clip
        </Button>
      </div>

      <div className="clip-ruler" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} className="clip-tick" style={{ left: `${(t / duration) * 100}%` }}>
            {formatTimecode(t, { millis: false })}
          </span>
        ))}
      </div>

      <div className="clip-lanes">
        {mappings.map((mapping) => {
          const index = sources.findIndex((s) => s.id === mapping.sourceId)
          const source = sources[index]
          if (!source) return null
          const bar = laneBar(mapping)
          const active = mapping.sourceId === activeSourceId
          return (
            <div key={mapping.sourceId} className={`clip-lane${active ? ' active' : ''}`}>
              <button
                className="lane-name"
                title={`Switch to ${source.title} at this moment`}
                disabled={!covers(mapping)}
                onClick={() => seekTo(mapping, playheadFraction === null ? 0 : playheadFraction * duration)}
              >
                {povLabel(source, index)}
              </button>

              <div
                className="lane-track"
                role="presentation"
                onClick={(e) => onLaneClick(mapping, e)}
                title={
                  covers(mapping)
                    ? `${formatTimecode(mapping.vodStartSeconds)} → ${formatTimecode(mapping.vodEndSeconds)} in this VOD`
                    : POV_STATUS_LABEL[mapping.status]
                }
              >
                {bar && (
                  <div
                    className={`lane-bar ${mapping.status}`}
                    style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  />
                )}
                {!bar && <span className="lane-empty">{POV_STATUS_LABEL[mapping.status]}</span>}
              </div>

              <span className={`cover ${coverClass(mapping.status)}`}>
                {POV_STATUS_LABEL[mapping.status]}
                {(clip.povOffsets?.[mapping.sourceId] ?? 0) !== 0 && (
                  <span className="pill" title="Hand-aligned for this clip">
                    {(clip.povOffsets![mapping.sourceId] > 0 ? '+' : '') +
                      clip.povOffsets![mapping.sourceId].toFixed(2)}
                    s
                  </span>
                )}
              </span>
            </div>
          )
        })}

        {playheadFraction !== null && (
          <div className="clip-playhead" style={{ left: `calc(140px + (100% - 240px) * ${playheadFraction})` }} />
        )}
      </div>
    </div>
  )
}

function covers(mapping: ClipPovMapping): boolean {
  return mapping.status === 'available' || mapping.status === 'partial' || mapping.status === 'sync_low_confidence'
}

function coverClass(status: ClipPovMapping['status']): string {
  if (status === 'available') return 'full'
  if (status === 'partial' || status === 'sync_low_confidence') return 'partial'
  return 'none'
}

/**
 * Where a POV's coverage sits within the clip, as percentages of the clip's
 * own span. A POV that joined late starts partway across; one that stopped
 * early ends short. Both are visible without reading a single number.
 */
export function laneBar(mapping: ClipPovMapping): { left: number; width: number } | null {
  if (!covers(mapping)) return null
  const requested = mapping.requestedEndSeconds - mapping.requestedStartSeconds
  if (requested <= 0) return null
  const startOffset = (mapping.vodStartSeconds - mapping.requestedStartSeconds) / requested
  const endOffset = (mapping.vodEndSeconds - mapping.requestedStartSeconds) / requested
  const left = Math.max(0, Math.min(1, startOffset)) * 100
  const right = Math.max(0, Math.min(1, endOffset)) * 100
  const width = Math.max(0.5, right - left)
  return { left, width: Math.min(100 - left, width) }
}

/** Five-ish readable ticks across the clip. */
function tickSeconds(duration: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const step = steps.find((s) => duration / s <= 6) ?? 900
  const out: number[] = []
  for (let t = 0; t < duration - step * 0.25; t += step) out.push(t)
  return out
}
