import { useMemo } from 'react'
import { columnsFor, followerTargets } from '@shared/multiPov'
import { povLabel } from '@shared/pov'
import { useStore } from '../store.js'
import FollowerVideo from '../player/FollowerVideo.js'
import { playbackSrc } from '../player/sources.js'
import WatermarkOverlay from './WatermarkOverlay.js'

/**
 * Every angle of the same moment, at the same moment.
 *
 * Every tile is the same size — this is meant to be watched like a wall of
 * cameras, not one dominant picture with an afterthought strip beneath it.
 * There is still one clock and one voice: the focused POV owns the playhead
 * and its audio plays; every other tile is told where to be, in its own
 * VOD's time, through that POV's sync mapping, and stays muted. A POV that
 * was not recording is labelled rather than seeked to a time it does not
 * have.
 */

import type { GridLayout } from '@shared/multiPov'

export type { GridLayout }

interface Props {
  /** The POV whose audio plays and whose clock the rest follow. */
  focusId: string | null
  onFocus: (sourceId: string) => void
  layout: GridLayout
  /** The focused POV's own player — rendered as one of the equal-sized tiles. */
  children: React.ReactNode
}

export default function PovGrid({ focusId, onFocus, layout, children }: Props): JSX.Element {
  const sources = useStore((s) => s.project?.sources) ?? []
  const currentTime = useStore((s) => s.currentTime)
  const playing = useStore((s) => s.playing)
  const rate = useStore((s) => s.rate)
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const mediaProxyBase = useStore((s) => s.env?.mediaProxyBase)

  const leader = sources.find((s) => s.id === focusId) ?? sources[0]
  const targets = useMemo(
    () => followerTargets(sources, leader, currentTime),
    [sources, leader, currentTime]
  )
  const columns = columnsFor(layout, sources.length)

  return (
    <div className="pov-grid-equal" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {sources.map((source) => {
        const isLeader = source.id === leader?.id
        const target = targets.get(source.id) ?? null
        const src = isLeader ? null : playbackSrc(source, mediaProxyBase)

        return (
          <div
            key={source.id}
            className={`pov-tile${isLeader ? ' is-leader' : ''}${!isLeader && target === null ? ' dark' : ''}`}
            role="button"
            tabIndex={0}
            title={isLeader ? `${povLabel(source)} — audio plays from here` : `Focus ${povLabel(source)}`}
            onClick={() => !isLeader && onFocus(source.id)}
            onKeyDown={(e) => {
              if (!isLeader && (e.key === 'Enter' || e.key === ' ')) onFocus(source.id)
            }}
          >
            {isLeader ? (
              children
            ) : src && target !== null ? (
              <FollowerVideo
                src={src}
                progressive={source.playbackKind === 'progressive'}
                targetSeconds={target}
                playing={playing}
                rate={rate}
                muted
                volume={volume}
              />
            ) : (
              <div className="pov-tile-note">
                {src ? 'Not recording at this moment' : 'No preview stream for this POV'}
              </div>
            )}
            {/* Every visible angle carries its own watermark, not just the
                focused one — "5 POVs at once" means all 5. The leader's own
                watermark is already drawn by {children} (the real player),
                which resolves it from the same activeSourceId this tile is
                for, so it is not duplicated here. */}
            {!isLeader && <WatermarkOverlay sourceId={source.id} />}
            <span className="pov-tile-name">
              {povLabel(source)}
              {isLeader && (
                <span className="pov-tile-audio" title="Audio plays from this angle" aria-hidden="true">
                  ♪
                </span>
              )}
            </span>
          </div>
        )
      })}
      {muted && <span className="visually-hidden">Sound is muted</span>}
    </div>
  )
}
