import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { playerBus } from './controller.js'
import type { PlayerController } from './controller.js'
import { describeSource } from './diagnose.js'
import { useStore } from '../store.js'

interface Props {
  src: string
  progressive: boolean
  onFatalError: (message: string) => void
}

/**
 * Streaming preview. Nothing is written to disk: hls.js buffers only the parts
 * of the VOD being watched, exactly like a browser player would.
 */
export default function HlsPlayer({ src, progressive, onFatalError }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [ready, setReady] = useState(false)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setPlaying = useStore((s) => s.setPlaying)
  const setDuration = useStore((s) => s.setDuration)
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const rate = useStore((s) => s.rate)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let hls: Hls | null = null
    setReady(false)

    // Where the editor wants to be. On a POV switch this is the matching
    // real-world moment, and telling hls.js up front means it fetches *that*
    // part of the VOD — loading from zero first and seeking afterwards throws
    // away bandwidth and stalls the picture for seconds on a long VOD.
    const startAt = useStore.getState().currentTime

    const useNative = progressive || video.canPlayType('application/vnd.apple.mpegurl') !== ''
    if (progressive || (useNative && !Hls.isSupported())) {
      video.src = startAt > 0.05 ? `${src}#t=${startAt.toFixed(3)}` : src
    } else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 90,
        /*
         * Start at a believable bitrate instead of the bottom rung.
         *
         * hls.js's default first guess is 500 kbps, which on any real ladder
         * picks the smallest rendition for the opening segments and then climbs
         * — the "loads blurry and slowly recovers" that made a freshly focused
         * angle look broken. The estimate is only the *first* guess: measured
         * throughput replaces it within a segment or two, so an actually slow
         * connection still ends up where it belongs, just from above rather
         * than from below.
         */
        abrEwmaDefaultEstimate: 5_000_000,
        // Fetch the next fragment while the current one plays, rather than
        // waiting for the buffer to run down first.
        startFragPrefetch: true,
        // Drop a rung if the decoder cannot keep up, rather than stuttering.
        capLevelOnFPSDrop: true,
        startPosition: startAt > 0.05 ? startAt : -1
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      /**
       * A long VOD dropped over a home connection throws the odd fatal error:
       * a segment times out, or the decoder chokes after a seek. hls.js can
       * carry on from both, so retry before giving up — tearing the player
       * down on the first hiccup is what made playback look like it broke at
       * random. Give up only when retries stop helping.
       */
      let networkRetries = 0
      let mediaRetries = 0
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal || !hls) return
        const status = data.response?.code
        const refused = status === 403 || status === 401
        const gone = status === 404 || status === 410

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !refused && !gone && networkRetries < 3) {
          networkRetries += 1
          hls.startLoad()
          return
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
          mediaRetries += 1
          hls.recoverMediaError()
          return
        }

        const reason = refused
          ? 'the platform refused the request — the VOD may need an account'
          : gone
            ? 'the stream is no longer available at that address'
            : status
              ? `the server answered HTTP ${status}`
              : 'the connection kept dropping'
        onFatalError(`Could not keep the preview playing: ${reason} (${data.details}).`)
      })
    } else {
      video.src = src
    }

    const onLoaded = (): void => {
      setReady(true)
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration)
      // The store already holds where the editor wants to be — after a POV
      // switch that is the matching real-world moment, not zero.
      const wanted = useStore.getState().currentTime
      if (wanted > 0.05 && Math.abs(video.currentTime - wanted) > 0.05) {
        video.currentTime = wanted
      }
      // Switching angle mid-playback should keep playing. Without this the
      // fresh element sits paused while the transport still reads "playing",
      // so the next click on Play *pauses* and nothing happens.
      if (useStore.getState().playing) {
        void video.play().catch(() => setPlaying(false))
      }
    }
    /*
     * A fresh element reports 0 before it has loaded anything.
     *
     * `timeupdate` and `seeked` both fire during setup, and writing that zero
     * into the store loses the position the *next* initialisation would have
     * started from — which is how a re-init at the end of a stream turned into
     * a jump back to the beginning. Nothing is believed until metadata is in.
     */
    const onTime = (): void => {
      if (video.readyState < 1) return
      setCurrentTime(video.currentTime)
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    // A <video> error says only "src not supported", which is also what a 403
    // from the platform's CDN looks like. Ask the source itself what happened
    // so the message names the real cause.
    const onError = (): void => {
      const code = video.error?.code
      void describeSource(src).then((detail) =>
        onFatalError(
          code === 4
            ? `The preview stream could not be played. ${detail}`
            : `The preview stream stopped: ${video.error?.message || 'the player reported a decode error'}. ${detail}`
        )
      )
    }

    /*
     * What the player is doing, in the log rather than only on screen.
     *
     * Quality changes, playlist reloads and stalls are the three things that
     * explain "it went blurry", "it stopped at the end" and "it keeps
     * buffering", and none of them were visible after the fact.
     */
    if (hls) {
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const level = hls?.levels?.[data.level]
        if (!level) return
        void window.api.logEvent('info', 'player', 'Quality changed', {
          src: src.slice(0, 120),
          height: level.height,
          fps: level.frameRate,
          kbps: Math.round(level.bitrate / 1000)
        })
      })
      hls.on(Hls.Events.LEVEL_UPDATED, (_e, data) => {
        // A growing recording: the playlist gained segments, which is the
        // mechanism that keeps a live angle playing past where it was loaded.
        const details = data.details
        if (!details.live) return
        void window.api.logEvent('debug', 'player', 'Playlist re-read', {
          src: src.slice(0, 120),
          segments: details.fragments.length,
          endSeconds: Math.round(details.totalduration),
          live: details.live
        })
      })
    }
    const onWaiting = (): void =>
      void window.api.logEvent('debug', 'player', 'Waiting for data', {
        src: src.slice(0, 120),
        at: Math.round(video.currentTime),
        buffered: video.buffered.length ? Math.round(video.buffered.end(video.buffered.length - 1)) : 0
      })
    const onStalled = (): void =>
      void window.api.logEvent('warn', 'player', 'Playback stalled', {
        src: src.slice(0, 120),
        at: Math.round(video.currentTime)
      })
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('stalled', onStalled)

    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('seeked', onTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)

    const controller: PlayerController = {
      play: () => void video.play().catch(() => undefined),
      pause: () => video.pause(),
      seek: (seconds) => {
        video.currentTime = seconds
        setCurrentTime(seconds)
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
    playerBus.attach(controller)

    return () => {
      playerBus.detach(controller)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('seeked', onTime)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('error', onError)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('stalled', onStalled)
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [src, progressive, onFatalError, setCurrentTime, setDuration, setPlaying])

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume
  }, [volume, ready])
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted
  }, [muted, ready])
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate
  }, [rate, ready])

  return (
    <div className="player-frame">
      <video ref={videoRef} playsInline preload="metadata" />
      {!ready && (
        <div className="player-loading" role="status">
          Loading this POV at the matching moment…
        </div>
      )}
    </div>
  )
}
