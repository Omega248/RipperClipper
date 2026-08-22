import { defaultWatermark } from '@shared/watermark'
import { povLabel } from '@shared/pov'
import type { VodSource } from '@shared/types'
import { useStore } from '../store.js'
import { drawNameBadge } from './nameBadge.js'

/**
 * Give a freshly loaded POV a watermark that says whose angle it is.
 *
 * The point of watermarking a multi-POV export is answering exactly that, and
 * the app already knows the answer — so the badge is generated rather than
 * demanded. Ten POVs used to mean ten image imports before a ten-POV export.
 *
 * Two things it deliberately will not do: replace a watermark the editor
 * already chose (theirs always wins), and interrupt anyone if it fails. This
 * runs uninvited on every load, so a failure just means no badge, which is
 * exactly where things stood before.
 */
export async function ensureNameBadge(source: VodSource): Promise<void> {
  const state = useStore.getState()

  // Anything the editor has already decided takes precedence — both a
  // per-VOD override and this streamer's saved default.
  if (source.watermark) return
  const streamer = state.streamers.find(
    (s) =>
      s.platform === source.platform &&
      s.handle.toLowerCase() === (source.channelHandle ?? '').toLowerCase()
  )
  if (streamer?.watermark) return

  // shared/pov.ts's povLabel: character, POV name, creator, then title.
  const label = povLabel(source)
  if (!label || label.trim() === '') return

  try {
    const png = drawNameBadge(label)
    if (!png) return
    const image = await window.api.addWatermarkPng(png, label)
    state.setSourceWatermark(source.id, { ...defaultWatermark(image.id), width: 0.16 })
  } catch {
    // No badge is a fine outcome; this was never asked for.
  }
}
