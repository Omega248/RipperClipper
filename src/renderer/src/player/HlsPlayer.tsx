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
    const onTime = (): void => setCurrentTime(video.currentTime)
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
