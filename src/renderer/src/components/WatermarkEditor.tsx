import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ANCHOR_LABEL,
  WATERMARK_ANCHORS,
  anchorPosition,
  defaultWatermark,
  positionFromBox,
  resolveWatermark,
  streamerFor,
  watermarkBox
} from '@shared/watermark'
import type { WatermarkAnchor, WatermarkConfig, WatermarkImage } from '@shared/watermark'
import { useStore } from '../store.js'
import { watermarkUrl } from '../watermarkUrl.js'
import { message, title } from './QualityPanel.js'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Notice,
  Select,
  Slider
} from '../ui/index.js'

/**
 * Positioning a watermark, by dragging it.
 *
 * The editor works on a 16:9 stage standing in for the frame, and everything
 * it produces is normalised — a fraction of the frame, never a pixel count —
 * so the same configuration lands in the same visual place whatever the export
 * resolution turns out to be. The geometry comes from `watermarkBox`, the same
 * function the export filter uses, which is what stops the preview and the
 * output ever disagreeing.
 *
 * Precedence is visible rather than implied: the dialog says whether what is on
 * screen came from this VOD or from the streamer's default, and saving one
 * never silently writes the other.
 */
export default function WatermarkEditor({ onClose }: { onClose: () => void }): JSX.Element {
  const project = useStore((s) => s.project)
  const activeSourceId = useStore((s) => s.activeSourceId)
  const streamers = useStore((s) => s.streamers)
  const setSourceWatermark = useStore((s) => s.setSourceWatermark)
  const setStreamers = useStore((s) => s.setStreamers)
  const toast = useStore((s) => s.toast)
  const mediaBase = useStore((s) => s.env?.mediaProxyBase)

  const source = project?.sources.find((s) => s.id === activeSourceId) ?? project?.sources[0] ?? null
  const streamer = source ? streamerFor(streamers, source) : null

  const [images, setImages] = useState<WatermarkImage[]>([])
  const [config, setConfig] = useState<WatermarkConfig | null>(null)
  const [origin, setOrigin] = useState<'vod' | 'streamer' | 'new'>('new')
  const [confirmDefault, setConfirmDefault] = useState(false)
  const stage = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; box: ReturnType<typeof watermarkBox> } | null>(null)

  useEffect(() => {
    void window.api.listWatermarkImages().then(setImages)
  }, [])

  // Load whatever currently applies to this VOD, and say where it came from.
  useEffect(() => {
    if (!source) return
    const resolved = resolveWatermark(source.watermark, streamer?.watermark)
    if (resolved) {
      setConfig(resolved.config)
      setOrigin(resolved.from)
    } else {
      setConfig(source.watermark ?? streamer?.watermark ?? defaultWatermark(null))
      setOrigin(source.watermark ? 'vod' : streamer?.watermark ? 'streamer' : 'new')
    }
  }, [source?.id, streamer?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const image = images.find((i) => i.id === config?.imageId) ?? null

  const patch = useCallback((next: Partial<WatermarkConfig>) => {
    setConfig((current) => (current ? { ...current, ...next } : current))
  }, [])

  if (!source) {
    return (
      <Dialog title="Watermark" onClose={onClose}>
        <EmptyState icon="file" title="No POV loaded" description="Load a VOD to give it a watermark." />
      </Dialog>
    )
  }

  const frame = { width: 1920, height: 1080 }
  const box =
    config && image
      ? watermarkBox(config, frame, { width: image.width || 1, height: image.height || 1 })
      : null

  const onPointerDown = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!box) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { mode, x: e.clientX, y: e.clientY, box }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const state = drag.current
    const element = stage.current
    if (!state || !element || !config || !image) return
    const rect = element.getBoundingClientRect()
    // Screen pixels → frame pixels, so the maths is the same at any zoom.
    const scale = frame.width / rect.width
    const dx = (e.clientX - state.x) * scale
    const dy = (e.clientY - state.y) * scale

    if (state.mode === 'move') {
      const moved = { ...state.box, left: state.box.left + dx, top: state.box.top + dy }
      patch(positionFromBox(moved, frame, config.anchor))
      return
    }

    // Resizing changes the width only; the height follows the image while the
    // aspect ratio is locked, which is what most people mean by "make it bigger".
    const width = Math.max(24, state.box.width + dx)
    patch({ width: Math.min(1, width / frame.width) })
  }

  const endDrag = (): void => {
    drag.current = null
  }

  const importImage = async (): Promise<void> => {
    try {
      const added = await window.api.importWatermarkImage()
      if (!added) return
      setImages(await window.api.listWatermarkImages())
      setConfig((current) => ({ ...(current ?? defaultWatermark()), imageId: added.id, enabled: true }))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not add that image'), message: message(err) })
    }
  }

  const saveToVod = (): void => {
    if (!config) return
    setSourceWatermark(source.id, config)
    setOrigin('vod')
    toast({
      kind: 'success',
      title: 'Saved for this VOD',
      message: `${source.title} now has its own watermark. Other broadcasts are unchanged.`
    })
  }

  const saveAsDefault = async (): Promise<void> => {
    if (!config || !streamer) return
    setConfirmDefault(false)
    try {
      setStreamers(await window.api.setStreamerWatermark(streamer.id, config))
      // The VOD's own override is cleared so it follows the default it just
      // became — otherwise the two would immediately disagree.
      setSourceWatermark(source.id, null)
      setOrigin('streamer')
      toast({
        kind: 'success',
        title: `Saved as ${streamer.displayName}'s default`,
        message: 'Every VOD of theirs inherits this unless it has its own.'
      })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not save the default'), message: message(err) })
    }
  }

  return (
    <Dialog
      title="Watermark"
      description={`Drag it where you want it on ${source.title}. The position is stored as a fraction of the frame, so it lands in the same place at any export quality.`}
      size="large"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={!source.watermark}
            onClick={() => {
              setSourceWatermark(source.id, null)
              setConfig(streamer?.watermark ?? defaultWatermark(null))
              setOrigin(streamer?.watermark ? 'streamer' : 'new')
            }}
          >
            Reset to streamer default
          </Button>
          <span className="spacer" />
          <Button disabled={!streamer || !config} onClick={() => setConfirmDefault(true)}>
            Save as {streamer?.displayName ?? 'streamer'} default
          </Button>
          <Button variant="primary" disabled={!config} onClick={saveToVod}>
            Save for this VOD
          </Button>
        </>
      }
    >
      <div className="watermark-layout">
        <div>
          <div
            className="watermark-stage"
            ref={stage}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="watermark-frame-note">Preview of a 16:9 frame</div>
            {image && config && box && config.enabled && (
              <div
                className="watermark-box"
                role="button"
                tabIndex={0}
                style={{
                  left: `${(box.left / frame.width) * 100}%`,
                  top: `${(box.top / frame.height) * 100}%`,
                  width: `${(box.width / frame.width) * 100}%`,
                  height: `${(box.height / frame.height) * 100}%`,
                  transform: `rotate(${config.rotation}deg)`,
                  opacity: config.opacity
                }}
                onPointerDown={onPointerDown('move')}
                onKeyDown={(e) => {
                  // Keyboard nudging, because dragging is not available to
                  // everyone and 0.5 % is a usable step at any resolution.
                  const step = e.shiftKey ? 0.05 : 0.005
                  if (e.key === 'ArrowLeft') patch({ x: Math.max(0, config.x - step) })
                  if (e.key === 'ArrowRight') patch({ x: Math.min(1, config.x + step) })
                  if (e.key === 'ArrowUp') patch({ y: Math.max(0, config.y - step) })
                  if (e.key === 'ArrowDown') patch({ y: Math.min(1, config.y + step) })
                }}
              >
                <img src={watermarkUrl(image, mediaBase)} alt="" draggable={false} />
                <span
                  className="watermark-handle"
                  onPointerDown={onPointerDown('resize')}
                  aria-hidden="true"
                />
              </div>
            )}
          </div>
          <div className="hint">
            Drag to move, drag the corner to resize, or use the arrow keys. Hold Shift for bigger steps.
          </div>
        </div>

        <div className="watermark-controls">
          {origin !== 'new' && (
            <Notice tone="info">
              {origin === 'vod'
                ? 'This VOD has its own watermark. The streamer default is not affected by changes here.'
                : `Inherited from ${streamer?.displayName ?? 'the streamer'}'s default. Saving for this VOD creates an override.`}
            </Notice>
          )}

          {config?.imageId && !images.some((i) => i.id === config.imageId) && (
            <Notice tone="warning">
              The image this watermark points at is not in Ripper Clipper&rsquo;s folder any more, so
              nothing would be drawn. Pick another image, or add it again.
            </Notice>
          )}

          {images.length === 0 && (
            <EmptyState
              icon="file"
              title="No images yet"
              description="Add a logo and it stays in Ripper Clipper's own folder, so moving the original later cannot break an export."
              action={{ label: 'Add an image', icon: 'plus', onClick: () => void importImage() }}
            />
          )}

          {images.length > 0 && config && (
            <div className="rows">
              <Field label="Image" htmlFor="wm-image">
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Select
                    id="wm-image"
                    block
                    value={config.imageId ?? ''}
                    options={[
                      { value: '', label: 'None' },
                      ...images.map((i) => ({ value: i.id, label: i.name }))
                    ]}
                    onChange={(value) => patch({ imageId: value === '' ? null : value, enabled: value !== '' })}
                  />
                  <IconButton icon="plus" label="Add an image" onClick={() => void importImage()} />
                  <IconButton
                    icon="trash"
                    label="Remove this image from the library"
                    disabled={!config.imageId}
                    onClick={async () => {
                      if (!config.imageId) return
                      setImages(await window.api.removeWatermarkImage(config.imageId))
                      patch({ imageId: null, enabled: false })
                    }}
                  />
                </div>
              </Field>

              <Field label="Show it">
                <Checkbox
                  checked={config.enabled}
                  label="Draw this watermark on exports from this POV"
                  onChange={(enabled) => patch({ enabled })}
                />
              </Field>

              <Field label="Corner" htmlFor="wm-anchor" hint="Which part of the logo is pinned where.">
                <Select
                  id="wm-anchor"
                  block
                  value={config.anchor}
                  options={WATERMARK_ANCHORS.map((a) => ({ value: a, label: ANCHOR_LABEL[a] }))}
                  onChange={(value) => patch(anchorPosition(value as WatermarkAnchor))}
                />
              </Field>

              <Field label="Size">
                <Slider
                  label="Size"
                  min={2}
                  max={60}
                  value={Math.round(config.width * 100)}
                  format={(v) => `${v}% of width`}
                  width={180}
                  onChange={(value) => patch({ width: value / 100 })}
                />
              </Field>

              <Field label="Rotation">
                <Slider
                  label="Rotation"
                  min={-180}
                  max={180}
                  value={config.rotation > 180 ? config.rotation - 360 : config.rotation}
                  format={(v) => `${v}°`}
                  width={180}
                  onChange={(value) => patch({ rotation: (value + 360) % 360 })}
                />
              </Field>

              <Field label="Opacity">
                <Slider
                  label="Opacity"
                  min={5}
                  max={100}
                  value={Math.round(config.opacity * 100)}
                  format={(v) => `${v}%`}
                  width={180}
                  onChange={(value) => patch({ opacity: value / 100 })}
                />
              </Field>

              <Field label="Proportions">
                <Checkbox
                  checked={config.lockAspect}
                  label="Keep the image's own shape"
                  onChange={(lockAspect) => patch({ lockAspect })}
                />
              </Field>
            </div>
          )}
        </div>
      </div>

      {confirmDefault && (
        <ConfirmDialog
          title={`Make this ${streamer?.displayName}'s default watermark?`}
          description="Every VOD of theirs that has no watermark of its own will use this, including ones loaded in future. VODs with their own override keep it."
          confirmLabel="Save as default"
          onCancel={() => setConfirmDefault(false)}
          onConfirm={() => void saveAsDefault()}
        />
      )}
    </Dialog>
  )
}
