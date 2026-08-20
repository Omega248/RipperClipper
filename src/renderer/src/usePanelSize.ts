import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A resizable panel dimension, backed by a persisted setting.
 *
 * Drag updates are local-only (instant, no IPC) and only written back to
 * settings once the drag ends — resizing at 60fps is not a reason to hit
 * disk 60 times a second. The clamp is re-applied on every window resize
 * too, so a panel sized generously on a big window cannot leave the video
 * with nowhere to go on a smaller one.
 */
export function usePanelSize(opts: {
  /** Value from settings; undefined means "no override, use the CSS default". */
  persisted: number | undefined
  cssDefault: number
  min: number
  /** Absolute max, further capped by a fraction of the relevant viewport dimension. */
  max: number
  viewportFraction: number
  axis: 'width' | 'height'
  onCommit: (px: number) => void
}): { value: number | undefined; drag: (deltaPx: number) => void; commit: () => void } {
  const { persisted, cssDefault, min, max, viewportFraction, axis, onCommit } = opts
  const [value, setValue] = useState(persisted)
  const pending = useRef(persisted)

  useEffect(() => {
    setValue(persisted)
    pending.current = persisted
  }, [persisted])

  const clamp = useCallback(
    (px: number): number => {
      const viewport = axis === 'width' ? window.innerWidth : window.innerHeight
      return Math.min(Math.max(px, min), Math.min(max, viewport * viewportFraction))
    },
    [axis, min, max, viewportFraction]
  )

  useEffect(() => {
    const onResize = (): void => {
      if (pending.current === undefined) return
      const clamped = clamp(pending.current)
      if (clamped !== pending.current) {
        pending.current = clamped
        setValue(clamped)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const drag = useCallback(
    (deltaPx: number) => {
      const next = clamp((pending.current ?? cssDefault) + deltaPx)
      pending.current = next
      setValue(next)
    },
    [clamp, cssDefault]
  )

  const commit = useCallback(() => {
    if (pending.current !== undefined) onCommit(pending.current)
  }, [onCommit])

  return { value, drag, commit }
}
