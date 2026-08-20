import { cloneElement, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'

/**
 * Tooltips.
 *
 * Deliberately plain: a short delay, no animation beyond a fade, and it
 * describes the control rather than repeating its label. Hover and keyboard
 * focus both open it, and it is wired with aria-describedby so a screen reader
 * gets the same sentence a mouse user does.
 */
interface Props {
  content: string
  /** Where the bubble sits relative to the control. */
  placement?: 'top' | 'bottom'
  children: ReactElement
}

export default function Tooltip({ content, placement = 'top', children }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const show = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 350)
  }
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
  }

  if (!content) return children

  return (
    <span className="ui-tooltip-anchor" onMouseEnter={show} onMouseLeave={hide}>
      {cloneElement(children, {
        'aria-describedby': open ? id : undefined,
        onFocus: show,
        onBlur: hide
      })}
      {open && (
        <span role="tooltip" id={id} className={`ui-tooltip ui-tooltip-${placement}`}>
          {content}
        </span>
      )}
    </span>
  )
}
