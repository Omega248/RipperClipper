import { useMemo } from 'react'
import { formatTimecode } from '@shared/time'
import { clipPovRanges } from '@shared/povMapping'
import type { ClipPovRange } from '@shared/povMapping'
import type { ClipSegment } from '@shared/types'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'

interface Props {
  clip: ClipSegment
}

const COVERAGE_LABEL: Record<ClipPovRange['coverage'], string> = {
  full: 'Covered',
  partial: 'Partly covered',
  none: 'Not recording',
  unknown: 'Not aligned'
}

/**
 * Which POVs actually show this clip, and which of them supplies the picture
 * and the sound. The ranges are derived from the event timeline every render —
 * a POV added a minute ago appears here with no backfill step.
 */
export default function PovMatrix({ clip }: Props): JSX.Element | null {
  const sources = useStore((s) => s.project?.sources)
  const setClipPov = useStore((s) => s.setClipPov)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setCurrentTime = useStore((s) => s.setCurrentTime)

  const ranges = useMemo(
    () => (sources ? clipPovRanges(clip, sources) : []),
    [clip, sources]
  )
  if (!sources || sources.length === 0) return null

  const videoId = clip.videoSourceId ?? clip.sourceId
  const audioId = clip.audioSourceId ?? videoId
  const usable = ranges.filter((r) => r.coverage === 'full' || r.coverage === 'partial')

  return (
    <div className="pov-matrix">
      <div className="matrix-head">
        <span>POV coverage</span>
        <span className="hint inline">
          {usable.length} of {ranges.length} cover this moment
        </span>
      </div>

      <table className="matrix">
        <thead>
          <tr>
            <th scope="col">POV</th>
            <th scope="col">Range in that VOD</th>
            <th scope="col">Coverage</th>
            <th scope="col" title="Picture comes from this POV">
              Vid
            </th>
            <th scope="col" title="Sound comes from this POV">
              Aud
            </th>
          </tr>
        </thead>
        <tbody>
          {ranges.map((range, index) => {
            const source = sources[index]
            const covers = range.coverage === 'full' || range.coverage === 'partial'
            return (
              <tr key={range.sourceId} className={covers ? '' : 'dim'}>
                <th scope="row">
                  <button
                    className="linkish"
                    title="Switch to this POV at this moment"
                    disabled={!covers}
                    onClick={() => {
                      setActiveSource(range.sourceId)
                      setCurrentTime(range.localStart)
                    }}
                  >
                    {povLabel(source, index)}
                  </button>
                  {range.authored && <span className="pill">authored</span>}
                </th>
                <td className="mono">
                  {covers
                    ? `${formatTimecode(range.localStart)} → ${formatTimecode(range.localEnd)}`
                    : '—'}
                </td>
                <td>
                  <span className={`cover ${range.coverage}`}>{COVERAGE_LABEL[range.coverage]}</span>
                  {covers && !range.authored && (
                    <span className="pct" title={`Sync confidence via ${range.method.replace(/_/g, ' ')}`}>
                      {Math.round(range.confidence * 100)}%
                    </span>
                  )}
                </td>
                <td>
                  <input
                    type="radio"
                    name={`video-${clip.id}`}
                    aria-label={`Use ${povLabel(source, index)} for video`}
                    checked={videoId === range.sourceId}
                    disabled={!covers}
                    onChange={() => setClipPov(clip.id, 'video', range.sourceId)}
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    name={`audio-${clip.id}`}
                    aria-label={`Use ${povLabel(source, index)} for audio`}
                    checked={audioId === range.sourceId}
                    disabled={!covers}
                    onChange={() => setClipPov(clip.id, 'audio', range.sourceId)}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {clip.eventStartTime === null || clip.eventStartTime === undefined ? (
        <p className="hint">
          This clip has no real-world time yet, because the POV it was made from has no known start
          time. Other POVs stay <strong>Unknown</strong> until one is established.
        </p>
      ) : (
        <p className="hint mono">
          Event time {new Date(clip.eventStartTime * 1000).toLocaleString()}
        </p>
      )}
    </div>
  )
}
