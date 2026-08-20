import { formatTimecode } from '@shared/time'
import { useActiveClips, useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import { povLabel } from './PovBar.js'
import { useEffect, useRef } from 'react'
import { Button, IconButton, Select, Slider } from '../ui/index.js'

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => ({
  value: String(r),
  label: `${r}×`
}))

/**
 * Playback and clip marking.
 *
 * Grouped rather than laid out in one long row: transport on the left, the POV
 * being watched next to it, then the marking controls — which are what the
 * page is actually for, so "Add clip" is the only primary-weighted button on
 * the bar — and the incidental controls (speed, volume, fullscreen) pushed to
 * the far end where they stay out of the way.
 */
export default function Transport(): JSX.Element {
  const clips = useActiveClips()
  const playing = useStore((s) => s.playing)
  const currentTime = useStore((s) => s.currentTime)
  const duration = useStore((s) => s.duration)
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const rate = useStore((s) => s.rate)
  const loop = useStore((s) => s.loopSelection)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const inPoint = useStore((s) => s.inPoint)
  const outPoint = useStore((s) => s.outPoint)
  const sequenceIndex = useStore((s) => s.sequenceIndex)
  const setVolume = useStore((s) => s.setVolume)
  const setMuted = useStore((s) => s.setMuted)
  const setRate = useStore((s) => s.setRate)
  const setLoop = useStore((s) => s.setLoopSelection)
  const selectClip = useStore((s) => s.selectClip)
  const setSequenceIndex = useStore((s) => s.setSequenceIndex)
  const setInPoint = useStore((s) => s.setInPoint)
  const setOutPoint = useStore((s) => s.setOutPoint)
  const createClip = useStore((s) => s.createClip)
  const hasSource = useStore((s) => s.activeSourceId !== null)
  const sources = useStore((s) => s.project?.sources)
  const activeSourceId = useStore((s) => s.activeSourceId)
  const setActiveSource = useStore((s) => s.setActiveSource)

  const selected = clips.find((c) => c.id === selectedClipId) ?? null
  const loopRange = selected
    ? { start: selected.startSeconds, end: selected.endSeconds }
    : inPoint !== null && outPoint !== null
      ? { start: Math.min(inPoint, outPoint), end: Math.max(inPoint, outPoint) }
      : null

  // Loop playback of the active selection.
  const loopRef = useRef(loopRange)
  loopRef.current = loopRange
  useEffect(() => {
    if (!loop) return
    const id = setInterval(() => {
      const range = loopRef.current
      if (!range) return
      const t = playerBus.currentTime()
      if (t > range.end || t < range.start - 0.5) playerBus.seek(range.start)
    }, 150)
    return () => clearInterval(id)
  }, [loop])

  // Sequence preview: play each clip in order without exporting anything.
  useEffect(() => {
    if (sequenceIndex === null) return
    const clip = clips[sequenceIndex]
    if (!clip) {
      setSequenceIndex(null)
      return
    }
    playerBus.seek(clip.startSeconds)
    playerBus.play()
    const id = setInterval(() => {
      if (playerBus.currentTime() >= clip.endSeconds) {
        if (sequenceIndex + 1 < clips.length) setSequenceIndex(sequenceIndex + 1)
        else {
          playerBus.pause()
          setSequenceIndex(null)
        }
      }
    }, 120)
    return () => clearInterval(id)
  }, [sequenceIndex, clips, setSequenceIndex])

  const gotoClip = (delta: number): void => {
    if (clips.length === 0) return
    const index = selected ? clips.findIndex((c) => c.id === selected.id) : -1
    const next = Math.max(0, Math.min(clips.length - 1, index + delta))
    const clip = clips[next]
    if (!clip) return
    selectClip(clip.id)
    playerBus.seek(clip.startSeconds)
  }

  return (
    <div className="transport">
      <div className="transport-group">
        <IconButton icon="skip-back" label="Previous clip (J)" onClick={() => gotoClip(-1)} />
        <IconButton
          icon="rewind"
          label="Back 30 seconds (Shift+←)"
          onClick={() => playerBus.seek(currentTime - 30)}
        />
        <IconButton
          icon={playing ? 'pause' : 'play'}
          variant="secondary"
          label={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => (playing ? playerBus.pause() : playerBus.play())}
        />
        <IconButton
          icon="forward"
          label="Forward 30 seconds (Shift+→)"
          onClick={() => playerBus.seek(currentTime + 30)}
        />
        <IconButton icon="skip-forward" label="Next clip (L)" onClick={() => gotoClip(1)} />
      </div>

      <span className="time">
        {formatTimecode(currentTime)} <span className="dim">/ {formatTimecode(duration)}</span>
      </span>

      {sources && sources.length > 1 && (
        <span className="watching" role="group" aria-label="Point of view">
          <span className="watching-label">Watching</span>
          {sources.map((source, index) => (
            <Button
              key={source.id}
              size="compact"
              variant="ghost"
              selected={source.id === activeSourceId}
              title={`Watch ${source.title} at the same moment`}
              onClick={() => setActiveSource(source.id)}
            >
              {povLabel(source, index)}
            </Button>
          ))}
        </span>
      )}

      <span className="divider" />

      <Button
        icon="mark-in"
        selected={inPoint !== null}
        disabled={!hasSource}
        onClick={() => setInPoint(currentTime)}
        title="Mark the start of a clip at the playhead (I)"
      >
        Mark in
        {inPoint !== null && (
          <span className="time dim">{formatTimecode(inPoint, { millis: false })}</span>
        )}
      </Button>
      <Button
        icon="mark-out"
        selected={outPoint !== null}
        disabled={!hasSource}
        onClick={() => setOutPoint(currentTime)}
        title="Mark the end of a clip at the playhead (O)"
      >
        Mark out
        {outPoint !== null && (
          <span className="time dim">{formatTimecode(outPoint, { millis: false })}</span>
        )}
      </Button>
      <Button
        variant="primary"
        icon="plus"
        disabled={!hasSource}
        onClick={() => createClip()}
        title="Add the marked range to your clip list (Enter)"
      >
        Add clip
      </Button>

      {loopRange && (
        <>
          <span className="divider" />
          <IconButton
            icon="chevron-left"
            label="Jump to the start of the selection"
            onClick={() => playerBus.seek(loopRange.start)}
          />
          <IconButton
            icon="loop"
            label="Loop the selected range (P)"
            selected={loop}
            onClick={() => setLoop(!loop)}
          />
          <IconButton
            icon="chevron-right"
            label="Jump to the end of the selection"
            onClick={() => playerBus.seek(loopRange.end)}
          />
        </>
      )}

      <span className="spacer" />

      <Select
        size="compact"
        label="Playback speed"
        value={String(rate)}
        options={RATES}
        onChange={(value) => {
          setRate(Number(value))
          playerBus.setRate(Number(value))
        }}
      />
      <IconButton
        icon={muted ? 'volume-off' : 'volume'}
        label={muted ? 'Unmute' : 'Mute'}
        selected={muted}
        onClick={() => {
          setMuted(!muted)
          playerBus.setMuted(!muted)
        }}
      />
      <Slider
        label="Volume"
        min={0}
        max={1}
        step={0.01}
        width={72}
        value={volume}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => {
          setVolume(value)
          playerBus.setVolume(value)
        }}
      />
      <IconButton icon="fullscreen" label="Fullscreen" onClick={() => playerBus.fullscreen()} />
    </div>
  )
}
