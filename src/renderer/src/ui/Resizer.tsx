import { useCallback, useRef } from 'react'

/**
 * A drag handle between two panels.
 *
 * Reports the raw pointer delta on every move (for live, responsive
 * feedback) and a final call on release (so the caller can persist just
 * once, rather than writing to disk on every pixel of movement).
 */
export default function Resizer(props: {
  axis: 'horizontal' | 'vertical'
  onDrag: (deltaPx: number) => void
  onDragEnd?: () => void
  title?: string
}): JSX.Element {
  const { axis, onDrag, onDragEnd } = props
  const last = useRef(0)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      last.current = axis === 'horizontal' ? e.clientX : e.clientY
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)

      const move = (ev: PointerEvent): void => {
        const pos = axis === 'horizontal' ? ev.clientX : ev.clientY
        const delta = pos - last.current
        last.current = pos
        if (delta !== 0) onDrag(delta)
      }
      const up = (ev: PointerEvent): void => {
        target.releasePointerCapture(ev.pointerId)
        target.removeEventListener('pointermove', move)
        target.removeEventListener('pointerup', up)
        onDragEnd?.()
      }
      target.addEventListener('pointermove', move)
      target.addEventListener('pointerup', up)
    },
    [axis, onDrag, onDragEnd]
  )

  return (
    <div
      className={`ui-resizer ${axis}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={axis === 'horizontal' ? 'vertical' : 'horizontal'}
      title={props.title}
    />
  )
}
