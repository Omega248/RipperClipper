import { useEffect, useState } from 'react'
import { resolveWatermark, streamerFor, watermarkBox } from '@shared/watermark'
import type { WatermarkImage } from '@shared/watermark'
import { useStore } from '../store.js'
import { watermarkUrl } from '../watermarkUrl.js'

/**
 * The watermark, drawn over the player.
 *
 * Positioned with the same `watermarkBox` the export filter uses, against a
 * nominal frame, then expressed as percentages — so what the editor sees here
 * is where FFmpeg will put it, at any resolution. Switching POV switches the
 * configuration, because a watermark belongs to the angle the picture comes
 * from and not to the project.
 */
export default function WatermarkOverlay({ sourceId }: { sourceId?: string } = {}): JSX.Element | null {
  const project = useStore((s) => s.project)
  const activeSourceId = useStore((s) => s.activeSourceId)
  const streamers = useStore((s) => s.streamers)
  const mediaBase = useStore((s) => s.env?.mediaProxyBase)
  const [images, setImages] = useState<WatermarkImage[]>([])

  useEffect(() => {
    void window.api.listWatermarkImages().then(setImages).catch(() => undefined)
  }, [])

  // Defaults to the focused POV so every existing call site — the single-POV
  // player, Show All's own focused tile — needs no change. Show All's
  // follower tiles pass their own id explicitly, because each angle has its
  // own watermark, not the focused one's.
  const source = project?.sources.find((s) => s.id === (sourceId ?? activeSourceId)) ?? null
  if (!source) return null

  const streamer = streamerFor(streamers, source)

  const resolved = resolveWatermark(source.watermark, streamer?.watermark)
  const image = resolved ? images.find((i) => i.id === resolved.config.imageId) : null
  if (!resolved || !image) return null

  const frame = { width: 1920, height: 1080 }
  const box = watermarkBox(resolved.config, frame, {
    width: image.width || 1,
    height: image.height || 1
  })

  return (
    <div className="watermark-overlay" aria-hidden="true">
      <img
        src={watermarkUrl(image, mediaBase)}
        alt=""
        style={{
          left: `${(box.left / frame.width) * 100}%`,
          top: `${(box.top / frame.height) * 100}%`,
          width: `${(box.width / frame.width) * 100}%`,
          height: `${(box.height / frame.height) * 100}%`,
          transform: `rotate(${resolved.config.rotation}deg)`,
          opacity: resolved.config.opacity
        }}
      />
    </div>
  )
}
