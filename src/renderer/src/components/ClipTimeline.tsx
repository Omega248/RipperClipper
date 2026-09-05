import { useMemo } from 'react'
import { formatTimecode } from '@shared/time'
import {
  MAX_POV_OFFSET_SECONDS,
  POV_STATUS_LABEL,
  audioCapablePovs,
  bestPovFor,
  clipPovRanges,
  nudgedPovOffset,
  videoCapablePovs
} from '@shared/povMapping'
import { povColor } from '@shared/povColors'
import { povLabel } from '@shared/pov'
import type { ClipPovMapping, ClipSegment, VodSource } from '@shared/types'
import { useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import { Button, Icon, IconButton } from '../ui/index.js'

interface Props {
  clip: ClipSegment
  /** Opens the waveform aligner for this clip. Absent where there is no room for it. */
  onAlignClip?: () => void
  /** Drops the ruler and the head, for panels that already have their own. */
  compact?: boolean
}

/**
 * Everything about a clip, POV by POV — and every control for it.
 *
 * A clip is not one recording, it is the same moment seen from however many
 * angles were rolling, and this is where the editor decides what happens to
 * each of them: which angle supplies the exported picture, which supplies the
 * sound, how far each one has to be nudged to line up, which ones have been
 * used, and where each one actually is in its own VOD. All of that already
 * existed in the project file and in the store; none of it except the two
 * radio buttons was reachable from the interface, and what was reachable was
 * spread over a table in one panel and a set of read-only lanes in another.
 *
 * The lanes are positioned by real-world timing on the clip's own clock (00:00
 * is the start of the clip, not of anyone's VOD), so who covers the whole
 * moment, who joined late and who was not recording is legible before reading
 * a single number.
 */
export default function ClipTimeline({ clip, onAlignClip, compact = false }: Props): JSX.Element | null {
  const sources = useStore((s) => s.project?.sources) ?? []
  const activeSourceId = useStore((s) => s.activeSourceId)
  const currentTime = useStore((s) => s.currentTime)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setClipPov = useStore((s) => s.setClipPov)
  const setClipPovOffset = useStore((s) => s.setClipPovOffset)
  const setClipPovUsed = useStore((s) => s.setClipPovUsed)

  const duration = Math.max(0.001, clip.endSeconds - clip.startSeconds)
  const mappings = clip.povMappings ?? []

  const ranges = useMemo(() => clipPovRanges(clip, sources), [clip, sources])
  const rangeById = useMemo(() => new Map(ranges.map((r) => [r.sourceId, r])), [ranges])
  const videoCapable = useMemo(() => new Set(videoCapablePovs(clip, sources).map((s) => s.id)), [clip, sources])
  const audioCapable = useMemo(() => new Set(audioCapablePovs(clip, sources).map((s) => s.id)), [clip, sources])

  const videoId = clip.videoSourceId ?? clip.sourceId
  const audioId = clip.audioSourceId ?? videoId

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

  const offsetsSet = Object.values(clip.povOffsets ?? {}).filter((v) => Math.abs(v) > 0.001).length
  const covering = mappings.filter(covers).length
  const videoRange = rangeById.get(videoId) ?? null
  const audioRange = rangeById.get(audioId) ?? null

  const useBest = (): void => {
    const video = bestPovFor(videoCapablePovs(clip, sources), ranges)
    if (video) setClipPov(clip.id, 'video', video)
    const audio = bestPovFor(audioCapablePovs(clip, sources), ranges)
    if (audio) setClipPov(clip.id, 'audio', audio)
  }

  const resetAllOffsets = (): void => {
    for (const [sourceId, value] of Object.entries(clip.povOffsets ?? {})) {
      if (Math.abs(value) > 0.001) setClipPovOffset(clip.id, sourceId, 0)
    }
  }

  const ticks = tickSeconds(duration)

  return (
    <div className="clip-timeline">
      {!compact && (
        <div className="clip-timeline-head">
          <strong className="ellipsis">{clip.name}</strong>
          <span className="hint inline mono">
            {formatTimecode(0)} → {formatTimecode(duration)} · clip time
          </span>
          <span className="topbar-divider" />
          <span className="hint inline">
            {covering} of {mappings.length} POVs cover this clip
          </span>
          <span className="spacer" />
          <Button
            size="compact"
            icon="target"
            onClick={useBest}
            title="Pick the best-covered, best-aligned angle for the picture and for the sound"
          >
            Use best
          </Button>
          <Button
            size="compact"
            icon="undo"
            disabled={offsetsSet === 0}
            onClick={resetAllOffsets}
            title="Clear every hand-alignment on this clip"
          >
            Reset alignment{offsetsSet > 0 ? ` (${offsetsSet})` : ''}
          </Button>
          {onAlignClip && (
            <Button
              size="compact"
              icon="waveform"
              onClick={onAlignClip}
              disabled={mappings.length < 2}
              title="Line a POV up against this clip's sound — this clip only"
            >
              Align by sound
            </Button>
          )}
        </div>
      )}

      {/* What the export will actually be, said in words rather than left to
          be inferred from two radio columns. */}
      <div className="clip-plan">
        <span className="clip-plan-part">
          <Icon name="grid" size={12} />
          Picture from <strong>{labelOf(sources, videoId)}</strong>
          {videoRange && videoRange.coverage === 'partial' && (
            <span className="warn"> — only part of this moment</span>
          )}
          {videoRange && videoRange.coverage === 'none' && (
            <span className="warn"> — not recording here</span>
          )}
        </span>
        <span className="clip-plan-part">
          <Icon name="volume" size={12} />
          Sound from <strong>{labelOf(sources, audioId)}</strong>
          {audioId !== videoId && <span className="pill">separate</span>}
          {audioRange && audioRange.coverage === 'partial' && (
            <span className="warn"> — only part of this moment</span>
          )}
        </span>
      </div>

      {!compact && (
        <div className="clip-ruler" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="clip-tick" style={{ left: `${(t / duration) * 100}%` }}>
              {formatTimecode(t, { millis: false })}
            </span>
          ))}
        </div>
      )}

      <div className="clip-lane-headings" aria-hidden="true">
        <span>POV</span>
        <span>Coverage of this clip</span>
        <span title="Where this clip falls in that POV's own recording">In VOD</span>
        <span>Align</span>
        <span title="Which angle supplies the exported picture and sound">Pic / Snd</span>
        <span title="Mark an angle you have already used">Used</span>
      </div>

      <div className="clip-lanes">
        {/*
         * The lanes and the playhead share an inner box, and that is what makes
         * the line reach the bottom row.
         *
         * `.clip-lanes` scrolls, so an absolutely-positioned line inside it is
         * measured against the *visible* box rather than the content: with two
         * lanes in view and five loaded, the playhead stopped after the second
         * one. The inner box has no overflow of its own, so its height is the
         * height of every lane there is.
         */}
        <div className="clip-lanes-inner">
          {mappings.map((mapping) => {
          const source = sources.find((s) => s.id === mapping.sourceId)
          if (!source) return null
          const range = rangeById.get(mapping.sourceId) ?? null
          const bar = laneBar(mapping)
          const active = mapping.sourceId === activeSourceId
          const usable = covers(mapping)
          const offset = clip.povOffsets?.[mapping.sourceId] ?? 0
          const used = (clip.usedPovIds ?? []).includes(mapping.sourceId)
          const isVideo = mapping.sourceId === videoId
          const isAudio = mapping.sourceId === audioId

          return (
            <div key={mapping.sourceId} className={`clip-lane${active ? ' active' : ''}`}>
              <button
                className="lane-name"
                title={`Watch ${source.title} at this moment`}
                disabled={!usable}
                onClick={() => seekTo(mapping, playheadFraction === null ? 0 : playheadFraction * duration)}
              >
                <span className="lane-swatch" style={{ background: povColor(mapping.sourceId) }} />
                <span className="ellipsis">{povLabel(source)}</span>
                {range?.authored && <span className="pill" title="The angle this clip was marked in">marked in</span>}
              </button>

              <div
                className="lane-track"
                role="presentation"
                onClick={(e) => onLaneClick(mapping, e)}
                title={
                  usable
                    ? `${formatTimecode(mapping.vodStartSeconds)} → ${formatTimecode(mapping.vodEndSeconds)} in this VOD — click to watch from here`
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

              <span className="lane-range mono" title={POV_STATUS_LABEL[mapping.status]}>
                {usable ? formatTimecode(mapping.vodStartSeconds, { millis: false }) : '—'}
              </span>

              {/*
               * The per-clip correction, finally reachable.
               *
               * It has been in the data model and the store the whole time and
               * the only way to set it was the waveform dialog — so a POV that
               * was half a second out could not simply be nudged. Shift takes
               * whole seconds; the value itself resets on click.
               */}
              <span className="lane-offset">
                <IconButton
                  icon="chevron-left"
                  size="compact"
                  label={`Nudge ${povLabel(source)} earlier`}
                  disabled={!usable}
                  onClick={(e) =>
                    setClipPovOffset(clip.id, mapping.sourceId, nudgedPovOffset(offset, e.shiftKey ? -1 : -0.1))
                  }
                />
                <button
                  className={`lane-offset-value mono${offset !== 0 ? ' on' : ''}`}
                  disabled={!usable || offset === 0}
                  title={
                    offset === 0
                      ? `Aligned as found (up to ±${MAX_POV_OFFSET_SECONDS}s of correction available)`
                      : 'Click to clear this correction'
                  }
                  onClick={() => setClipPovOffset(clip.id, mapping.sourceId, 0)}
                >
                  {offset === 0 ? '0.00' : `${offset > 0 ? '+' : ''}${offset.toFixed(2)}`}
                </button>
                <IconButton
                  icon="chevron-right"
                  size="compact"
                  label={`Nudge ${povLabel(source)} later`}
                  disabled={!usable}
                  onClick={(e) =>
                    setClipPovOffset(clip.id, mapping.sourceId, nudgedPovOffset(offset, e.shiftKey ? 1 : 0.1))
                  }
                />
              </span>

              <span className="lane-roles">
                <IconButton
                  icon="grid"
                  size="compact"
                  label={`Take the picture from ${povLabel(source)}`}
                  selected={isVideo}
                  disabled={!usable || !videoCapable.has(mapping.sourceId)}
                  onClick={() => setClipPov(clip.id, 'video', mapping.sourceId)}
                />
                <IconButton
                  icon="volume"
                  size="compact"
                  label={`Take the sound from ${povLabel(source)}`}
                  selected={isAudio}
                  disabled={!usable || !audioCapable.has(mapping.sourceId)}
                  onClick={() => setClipPov(clip.id, 'audio', mapping.sourceId)}
                />
              </span>

              <IconButton
                icon="check"
                size="compact"
                label={used ? `Mark ${povLabel(source)} unused` : `Mark ${povLabel(source)} used`}
                selected={used}
                disabled={!usable}
                onClick={() => setClipPovUsed(clip.id, mapping.sourceId, !used)}
              />
            </div>
          )
        })}

          {playheadFraction !== null && (
            <div
              className="clip-playhead"
              style={{
                left: `calc(var(--lane-name-w) + (100% - var(--lane-gutters)) * ${playheadFraction})`
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function labelOf(sources: VodSource[], sourceId: string): string {
  const source = sources.find((s) => s.id === sourceId)
  return source ? povLabel(source) : 'an angle that is no longer loaded'
}

function covers(mapping: ClipPovMapping): boolean {
  return mapping.status === 'available' || mapping.status === 'partial' || mapping.status === 'sync_low_confidence'
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
