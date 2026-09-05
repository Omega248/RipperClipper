import { useEffect, useMemo, useRef, useState } from 'react'
import { columnsFor, followerTargets, wallSelection } from '@shared/multiPov'
import { povLabel } from '@shared/pov'
import { useStore } from '../store.js'
import FollowerVideo from '../player/FollowerVideo.js'
import { playbackSrc } from '../player/sources.js'
import WatermarkOverlay from './WatermarkOverlay.js'
import { ConfirmDialog, IconButton } from '../ui/index.js'

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
  const clips = useStore((s) => s.project?.clips)
  const currentTime = useStore((s) => s.currentTime)
  const playing = useStore((s) => s.playing)
  const rate = useStore((s) => s.rate)
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const mediaProxyBase = useStore((s) => s.env?.mediaProxyBase)
  const mediaProxyToken = useStore((s) => s.env?.mediaProxyToken)
  const maxLivePovs = useStore((s) => s.settings?.ui.maxLivePovs)
  const removeSource = useStore((s) => s.removeSource)
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string; clips: number } | null>(
    null
  )
  const route = useStore((s) => s.route)
  const page = useStore((s) => s.page)

  const leader = sources.find((s) => s.id === focusId) ?? sources[0]
  const targets = useMemo(
    () => followerTargets(sources, leader, currentTime),
    [sources, leader, currentTime]
  )
  /*
   * Which angles are on screen, and which of those decode.
   *
   * Both questions in one place because they used to be answered by the same
   * number and should not be: the ceiling is what the machine can take, the
   * ticks are what the person wants to watch. An unticked angle gets no tile —
   * the screen is the scarce thing on a wall this wide, and a tile explaining
   * that you turned it off spends exactly what you were trying to reclaim.
   */
  const { shown, decoding } = useMemo(
    () => wallSelection(sources, leader?.id, maxLivePovs),
    [sources, leader, maxLivePovs]
  )
  /*
   * The grid's own shape, measured.
   *
   * Which arrangement makes the tiles biggest depends on the space, not just
   * the number of angles: two side by side waste half the height on a tall
   * stage and half the width on a wide one. Every tile draws a 16:9 picture
   * inside a box the grid stretches, so a mismatch is black bars on the one
   * surface whose job is showing you what you are cutting.
   */
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [stageAspect, setStageAspect] = useState(16 / 9)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect()
      if (width > 0 && height > 0) setStageAspect(width / height)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const columns = columnsFor(layout, shown.length, stageAspect)

  /*
   * Counted once, not once per tile per tick.
   *
   * This ran as a `filter` inside the tile loop while the component also
   * subscribes to the playhead — twenty angles against five hundred clips is
   * ten thousand comparisons and twenty throwaway arrays, several times a
   * second, for a number that only changes when the clips do.
   */
  const clipsBySource = useMemo(() => {
    const counts = new Map<string, number>()
    for (const clip of clips ?? []) {
      counts.set(clip.sourceId, (counts.get(clip.sourceId) ?? 0) + 1)
    }
    return counts
  }, [clips])

  /**
   * The stage is `hidden`, not unmounted, when you navigate away from Watch.
   * Without this check every follower would keep its HLS instance buffering
   * video for a page nobody is looking at — six muted decoders running behind
   * the Backlog is the same cost as six running in front of it.
   */
  const stageVisible = route === 'workspace' && page === 'video'

  const rows = Math.ceil(shown.length / Math.max(1, columns))
  const gridAspect = (columns * 16) / (rows * 9)

  return (
    /*
     * A stretched box that is measured, and a grid sized to the tiles inside it.
     *
     * Every angle draws a 16:9 picture, so unless the grid itself is
     * `columns × 16 : rows × 9` the remainder has to go *somewhere* — and it
     * went inside every cell, as black margins around each picture. Four angles
     * on a wide stage gave 837×335 cells holding 596×335 pictures: a fifth of
     * the wall spent on separate black borders that did not line up.
     *
     * The measured element is this wrapper, never the grid. The grid's size now
     * depends on the measurement, so measuring the grid would be a loop — and
     * that loop, back when the tiles were canvases whose bitmap came from their
     * own measured size, is what made the wall oscillate and overflow the
     * window the last time this was attempted. The wrapper is stretched by the
     * stage and cannot be moved by anything inside it.
     */
    <div ref={gridRef} className="pov-wall">
      <div
        className="pov-grid-equal"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          aspectRatio: `${columns * 16} / ${rows * 9}`,
          // `aspect-ratio` only shapes a box that is free on one axis. Which
          // axis is free depends on the stage, so it is decided here from the
          // measurement rather than left to the stylesheet.
          ...(stageAspect > gridAspect
            ? { height: '100%', width: 'auto' }
            : { width: '100%', height: 'auto' })
        }}
      >
      {shown.map((source) => {
        const isLeader = source.id === leader?.id
        const target = targets.get(source.id) ?? null
        const src = isLeader ? null : playbackSrc(source, mediaProxyBase, mediaProxyToken)
        const name = povLabel(source)
        const ownClips = clipsBySource.get(source.id) ?? 0
        // Whether this tile is actually decoding, which is what the tile's own
        // appearance and its note both have to agree about.
        const live =
          !isLeader &&
          src !== null &&
          target !== null &&
          stageVisible &&
          decoding.has(source.id)

        return (
          <div
            key={source.id}
            className={`pov-tile${isLeader ? ' is-leader' : ''}${!isLeader && !live ? ' dark' : ''}`}
            role="button"
            tabIndex={0}
            title={isLeader ? `${povLabel(source)} — audio plays from here` : `Focus ${povLabel(source)}`}
            onClick={() => !isLeader && onFocus(source.id)}
            onKeyDown={(e) => {
              if (!isLeader && (e.key === 'Enter' || e.key === ' ')) onFocus(source.id)
            }}
          >
            <IconButton
              icon="close"
              size="compact"
              className="pov-tile-remove"
              label={`Remove ${name}`}
              onClick={(e) => {
                e.stopPropagation()
                if (ownClips > 0) setConfirmRemove({ id: source.id, name, clips: ownClips })
                else removeSource(source.id)
              }}
            />
            {isLeader ? (
              children
            ) : live && src ? (
              <FollowerVideo
                src={src}
                progressive={source.playbackKind === 'progressive'}
                targetSeconds={target}
                live={source.isLive === true}
                playing={playing}
                rate={rate}
                muted
                volume={volume}
              />
            ) : (
              // Every angle keeps its tile; only the reason changes. A tile
              // that is not decoding says which of the four reasons it is,
              // because "black rectangle" is not one of them.
              <div className="pov-tile-note">
                {!src
                  ? 'No preview stream for this POV'
                  : target === null
                    ? 'Not recording at this moment'
                    : !stageVisible
                      ? 'Paused while you are on another page'
                      : 'Over your angle ceiling — untick an angle, or raise it in Settings'}
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
      </div>
      {muted && <span className="visually-hidden">Sound is muted</span>}
      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${confirmRemove.name}?`}
          description={`Its ${confirmRemove.clips} clip${
            confirmRemove.clips === 1 ? '' : 's'
          } are removed with it. Undo (Ctrl+Z) brings them back.`}
          confirmLabel="Remove POV"
          destructive
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            removeSource(confirmRemove.id)
            setConfirmRemove(null)
          }}
        />
      )}
    </div>
  )
}
