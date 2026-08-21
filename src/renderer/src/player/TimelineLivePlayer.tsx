import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import Hls from 'hls.js'
import { DEFAULT_PIP_TRANSFORM, isIdentityTransform, pipCompositionAt } from '@shared/timeline'
import type { EditorTimeline, TimelineTransform } from '@shared/types'
import { useStore } from '../store.js'
import { playerBus } from './controller.js'
import type { PlayerController } from './controller.js'
import { playbackSrc } from './sources.js'
import FollowerVideo from './FollowerVideo.js'

/**
 * Live sequence playback: cuts show instantly instead of waiting on a
 * rebuilt preview file.
 *
 * One `<video>` + hls.js instance is kept warm per POV referenced anywhere
 * on the timeline — the same "several players alive at once" pattern
 * `PovGrid`/`FollowerVideo` already prove works, just used here to swap
 * which one is on screen rather than to show them all at once. A cut
 * reattaches `playerBus` to the POV that's now on top and seeks it to the
 * matching local time; nothing is torn down or rebuilt, so scrubbing across
 * a boundary is as instant as scrubbing within one clip.
 *
 * A picture-in-picture inset (see `pipCompositionAt`) is shown the same way
 * `PovGrid`'s followers already work: a muted `FollowerVideo` told where to
 * be, CSS-positioned over the background using the exact same fractional
 * math as the export filter graph (`main/media/pipFilter.ts`), so what's
 * previewed here lines up with what actually renders.
 *
 * Sources the built-in player can't decode at all (see `playbackSrc`) never
 * get a warm slot — `setActive` returns false for those, and the caller
 * falls back to the existing built-a-local-proxy path.
 */

export interface TimelineLivePlayerHandle {
  /**
   * Makes `sourceId` the visible, audible, playerBus-driven picture, seeked
   * to `localSeconds` — synchronous and immediate, safe to call from the
   * same tick that decided a cut happened. Returns false (and touches
   * nothing) when `sourceId` isn't a source this player can play live.
   */
  setActive: (sourceId: string, localSeconds: number) => boolean
}

interface Props {
  timeline: EditorTimeline | undefined
  playheadSeconds: number
}

/** Percentage-based inset box matching `buildPipFilter`'s pixel math exactly, so the live preview lines up with the export. */
function insetBoxStyle(transform: TimelineTransform | undefined): React.CSSProperties {
  const t = transform && !isIdentityTransform(transform) ? transform : DEFAULT_PIP_TRANSFORM
  const scale = Math.max(0.05, Math.min(1, t.scale))
  return {
    position: 'absolute',
    width: `${scale * 100}%`,
    height: `${scale * 100}%`,
    left: `${((1 - scale) / 2) * 100 + t.x * 50}%`,
    top: `${((1 - scale) / 2) * 100 + t.y * 50}%`,
    overflow: 'hidden',
    boxShadow: '0 2px 12px rgba(0,0,0,0.5)',
    zIndex: 2
  }
}

const TimelineLivePlayer = forwardRef<TimelineLivePlayerHandle, Props>(function TimelineLivePlayer(
  { timeline, playheadSeconds },
  ref
) {
  const sources = useStore((s) => s.project?.sources) ?? []
  const mediaProxyBase = useStore((s) => s.env?.mediaProxyBase)
  const muted = useStore((s) => s.muted)
  const volume = useStore((s) => s.volume)
  const rate = useStore((s) => s.rate)
  const playing = useStore((s) => s.playing)

  // Every POV a video item on the timeline points at, restricted to ones the
  // built-in player can actually stream directly — the same handful already
  // proven warm-playable together in the multi-POV grid.
  const liveSourceIds = useMemo(() => {
    if (!timeline) return []
    const ids = new Set(timeline.items.filter((i) => i.kind === 'video').map((i) => i.sourceId))
    return [...ids].filter((id) => {
      const source = sources.find((s) => s.id === id)
      return Boolean(source && playbackSrc(source, mediaProxyBase))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline?.items, sources, mediaProxyBase])

  const [activeSourceId, setActiveSourceId] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const pool = useRef<Map<string, { video: HTMLVideoElement; controller: PlayerController }>>(new Map())

  useImperativeHandle(
    ref,
    () => ({
      setActive(sourceId, localSeconds) {
        const entry = pool.current.get(sourceId)
        if (!entry) return false
        if (activeIdRef.current === sourceId) {
          entry.video.currentTime = localSeconds
          return true
        }
        const previous = activeIdRef.current ? pool.current.get(activeIdRef.current) : null
        if (previous) {
          playerBus.detach(previous.controller)
          previous.video.pause()
        }
        entry.video.currentTime = localSeconds
        entry.video.muted = muted
        entry.video.volume = volume
        entry.video.playbackRate = rate
        playerBus.attach(entry.controller)
        if (playing) void entry.video.play().catch(() => undefined)
        activeIdRef.current = sourceId
        setActiveSourceId(sourceId)
        return true
      }
    }),
    [muted, volume, rate, playing]
  )

  const composition = timeline ? pipCompositionAt(timeline, playheadSeconds) : null
  const insetItem = composition?.inset ?? null
  const insetSource = insetItem ? sources.find((s) => s.id === insetItem.sourceId) : undefined
  const insetSrc = insetSource ? playbackSrc(insetSource, mediaProxyBase) : null
  const insetLocalSeconds = insetItem
    ? insetItem.sourceStartSeconds + (playheadSeconds - insetItem.timelineStartSeconds)
    : null

  return (
    <div className="timeline-live-player">
      {liveSourceIds.map((id) => {
        const source = sources.find((s) => s.id === id)
        const src = source ? playbackSrc(source, mediaProxyBase) : null
        if (!source || !src) return null
        return (
          <WarmVideo
            key={id}
            sourceId={id}
            src={src}
            progressive={source.playbackKind === 'progressive'}
            active={id === activeSourceId}
            onReady={(sourceId, video, controller) => pool.current.set(sourceId, { video, controller })}
            onGone={(sourceId, controller) => {
              // A POV that just left the pool entirely (its last timeline
              // reference was deleted) must not leave playerBus attached to
              // a video that's about to be torn down — a no-op if it wasn't
              // actually the attached one.
              playerBus.detach(controller)
              pool.current.delete(sourceId)
              if (activeIdRef.current === sourceId) {
                activeIdRef.current = null
                setActiveSourceId(null)
              }
            }}
          />
        )
      })}
      {insetItem && insetSrc && insetSource && (
        <div className="timeline-live-pip-inset" style={insetBoxStyle(insetItem.transform)}>
          <FollowerVideo
            src={insetSrc}
            progressive={insetSource.playbackKind === 'progressive'}
            targetSeconds={insetLocalSeconds}
            playing={playing}
            rate={rate}
            muted
            volume={volume}
          />
        </div>
      )}
    </div>
  )
})

export default TimelineLivePlayer

/**
 * One warm POV in the pool: mounted once per distinct source and left alone
 * across cuts, so switching which one is "active" is a visibility/attach
 * change, never a remount. Only the active instance's events feed the shared
 * `currentTime`/`playing`/`duration` store fields Transport reads — an
 * inactive one buffering quietly in the background must never overwrite
 * them with its own unrelated position.
 */
function WarmVideo({
  sourceId,
  src,
  progressive,
  active,
  onReady,
  onGone
}: {
  sourceId: string
  src: string
  progressive: boolean
  active: boolean
  onReady: (sourceId: string, video: HTMLVideoElement, controller: PlayerController) => void
  onGone: (sourceId: string, controller: PlayerController) => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setPlaying = useStore((s) => s.setPlaying)
  const setDuration = useStore((s) => s.setDuration)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let hls: Hls | null = null
    const useNative = progressive || video.canPlayType('application/vnd.apple.mpegurl') !== ''
    if (progressive || (useNative && !Hls.isSupported())) {
      video.src = src
    } else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Several of these may be alive at once — the same tight buffers
        // FollowerVideo uses, so idle POVs don't hold minutes of video each.
        backBufferLength: 15,
        maxBufferLength: 15,
        maxMaxBufferLength: 45
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      let networkRetries = 0
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal || !hls) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
          networkRetries += 1
          hls.startLoad()
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError()
        }
      })
    } else {
      video.src = src
    }

    const controller: PlayerController = {
      play: () => void video.play().catch(() => undefined),
      pause: () => video.pause(),
      seek: (seconds) => {
        video.currentTime = seconds
      },
      getCurrentTime: () => video.currentTime,
      getDuration: () => (Number.isFinite(video.duration) ? video.duration : 0),
      setVolume: (v) => {
        video.volume = v
      },
      setMuted: (v) => {
        video.muted = v
      },
      setRate: (v) => {
        video.playbackRate = v
      },
      requestFullscreen: () => void video.requestFullscreen?.().catch(() => undefined),
      seekPrecisionSeconds: 0.001
    }
    onReady(sourceId, video, controller)

    return () => {
      onGone(sourceId, controller)
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, progressive])

  // Only the active instance is allowed to drive the shared transport state.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !active) return
    const onTime = (): void => setCurrentTime(video.currentTime)
    const onLoaded = (): void => {
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration)
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeked', onTime)
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeked', onTime)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [active, setCurrentTime, setDuration, setPlaying])

  return (
    <video
      ref={videoRef}
      playsInline
      preload="auto"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: active ? 'block' : 'none'
      }}
    />
  )
}
