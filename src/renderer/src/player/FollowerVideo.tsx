import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

/**
 * A POV that follows the canonical playhead instead of owning it.
 *
 * Followers never tell the application what time it is — they are told. Each
 * one is nudged back into line when it drifts past the tolerance, which is what
 * keeps six angles of the same moment on the same frame instead of six players
 * quietly going their own way.
 */

/** Past this, a correction is worth the visible seek. */
const DRIFT_TOLERANCE = 0.35
/** Small drift is smoothed with playback rate rather than a jump. */
const NUDGE_TOLERANCE = 0.12

interface Props {
  src: string
  progressive: boolean
  /** Where this POV should be, in its own local time. Null = not recording. */
  targetSeconds: number | null
  playing: boolean
  rate: number
  /** The focused POV carries the sound; the rest are muted. */
  muted: boolean
  volume: number
}

export default function FollowerVideo({
  src,
  progressive,
  targetSeconds,
  playing,
  rate,
  muted,
  volume
}: Props): JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    let hls: Hls | null = null
    setFailed(null)

    const start = targetSeconds ?? 0
    if (progressive || (video.canPlayType('application/vnd.apple.mpegurl') !== '' && !Hls.isSupported())) {
      video.src = start > 0.05 ? `${src}#t=${start.toFixed(3)}` : src
    } else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Followers are small and there may be six of them: keep buffers tight
        // so the machine is not holding a minute of video per angle.
        backBufferLength: 15,
        maxBufferLength: 12,
        maxMaxBufferLength: 30,
        startPosition: start > 0.05 ? start : -1
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad()
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError()
        else setFailed('This angle could not be played here.')
      })
    } else {
      video.src = src
    }

    return () => {
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, progressive])

  // Follow the canonical playhead.
  useEffect(() => {
    const video = ref.current
    if (!video || targetSeconds === null) return
    const drift = video.currentTime - targetSeconds
    if (Math.abs(drift) > DRIFT_TOLERANCE) {
      video.currentTime = targetSeconds
      video.playbackRate = rate
    } else if (Math.abs(drift) > NUDGE_TOLERANCE) {
      // Catch up or ease off gently: a 4% rate change is inaudible on a muted
      // follower and avoids a visible jump every second.
      video.playbackRate = Math.max(0.5, Math.min(2.5, rate * (drift > 0 ? 0.96 : 1.04)))
    } else if (video.playbackRate !== rate) {
      video.playbackRate = rate
    }
  }, [targetSeconds, rate])

  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.muted = muted
    video.volume = muted ? 0 : volume
  }, [muted, volume])

  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (playing && targetSeconds !== null) void video.play().catch(() => undefined)
    else video.pause()
  }, [playing, targetSeconds])

  return (
    <>
      <video ref={ref} playsInline preload="auto" />
      {failed && <div className="pov-tile-note">{failed}</div>}
    </>
  )
}
