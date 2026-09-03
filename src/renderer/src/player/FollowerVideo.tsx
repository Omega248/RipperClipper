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
  /** This angle is a broadcast in progress: it starts at its live edge, not at an offset. */
  live?: boolean
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
  live = false,
  playing,
  rate,
  muted,
  volume
}: Props): JSX.Element {
  const ref = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  /** Read by the visibility observer, which must not re-subscribe per tick. */
  const hasTarget = useRef(targetSeconds !== null)
  hasTarget.current = targetSeconds !== null
  const playingRef = useRef(playing)
  playingRef.current = playing
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const video = ref.current
    if (!video) return
    let hls: Hls | null = null
    setFailed(null)

    // A live angle opens at its live edge. An offset into a broadcast that is
    // still going is not a position its playlist has — see the clamp below.
    const start = live ? 0 : (targetSeconds ?? 0)
    if (progressive || (video.canPlayType('application/vnd.apple.mpegurl') !== '' && !Hls.isSupported())) {
      video.src = start > 0.05 ? `${src}#t=${start.toFixed(3)}` : src
    } else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Followers are small and there may be twenty of them: keep buffers
        // tight so the machine is not holding a minute of video per angle.
        backBufferLength: 15,
        maxBufferLength: 12,
        maxMaxBufferLength: 30,
        // 8 MB of buffered media per angle, whatever that works out to in
        // seconds — a bitrate cap as well as a time one, which is what stops
        // twenty tiles from between them holding a gigabyte.
        maxBufferSize: 8 * 1000 * 1000,
        /*
         * This is what makes "every angle at once" affordable.
         *
         * Without it every follower picks a rendition by bandwidth alone, so a
         * 300px tile happily decodes the 1080p60 ladder rung — twenty of those
         * is twenty full-size decodes for twenty postage stamps, and the whole
         * window stops responding. Capped to the element's own size each tile
         * decodes roughly what it can actually show, and the FPS-drop cap
         * walks the whole wall down a rung if the machine still cannot keep
         * up rather than letting it stutter.
         */
        capLevelToPlayerSize: true,
        capLevelOnFPSDrop: true,
        startPosition: start > 0.05 ? start : -1
      })
      hlsRef.current = hls
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
      hlsRef.current = null
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, progressive, live])

  /*
   * An angle scrolled out of the stage costs nothing.
   *
   * Twenty tiles do not all fit on screen at once, and the ones below the fold
   * were still fetching segments and decoding them for nobody. Segment loading
   * stops while a tile is out of view and resumes when it comes back — the
   * follow effect below re-seeks it to the right moment either way, so coming
   * back into view lands on the playhead rather than wherever it left off.
   */
  useEffect(() => {
    const video = ref.current
    if (!video || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        const hls = hlsRef.current
        if (entry.isIntersecting) {
          hls?.startLoad()
          if (playingRef.current && hasTarget.current) void video.play().catch(() => undefined)
        } else {
          video.pause()
          hls?.stopLoad()
        }
      },
      { threshold: 0.01 }
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  // Follow the canonical playhead.
  useEffect(() => {
    const video = ref.current
    if (!video || targetSeconds === null) return

    /*
     * Chase only as far as this angle can actually go.
     *
     * A live playlist has no absolute timeline to seek in — the media element
     * holds a sliding DVR window, not the whole broadcast. Asking it for
     * "one hour in" is outside `seekable`, so the seek clamps or is ignored,
     * the drift never closes, and the follower re-seeks on every tick and
     * sits there stuttering. Clamping to the live edge is the right answer
     * anyway: every angle at its own live edge is every angle showing the
     * same real moment, which is what a wall of live POVs is for.
     *
     * On a finished VOD the target is always inside `seekable`, so this
     * changes nothing there.
     */
    const ranges = video.seekable
    const target =
      ranges.length === 0
        ? targetSeconds
        : Math.min(Math.max(targetSeconds, ranges.start(0)), ranges.end(ranges.length - 1))

    const drift = video.currentTime - target
    if (Math.abs(drift) > DRIFT_TOLERANCE) {
      video.currentTime = target
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

  /*
   * Play state only, not the playhead.
   *
   * `targetSeconds` changes several times a second, and having it as a
   * dependency meant calling `play()` on every already-playing follower on
   * every tick — twenty tiles, eighty promises a second, for a state that had
   * not changed. It is only needed as a "do we have a position at all" guard,
   * which a ref answers without re-running the effect.
   */
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (playing && hasTarget.current) void video.play().catch(() => undefined)
    else video.pause()
  }, [playing])

  return (
    <>
      <video ref={ref} playsInline preload="auto" />
      {failed && <div className="pov-tile-note">{failed}</div>}
    </>
  )
}
