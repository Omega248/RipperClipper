import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.js'
import type { IconName } from './Icon.js'

/**
 * The menu: a button that opens a list of commands.
 *
 * Shares its surface, padding, typography, hover and keyboard rules with
 * `Select` — an application menu and a dropdown should not look like they came
 * from different products. `ContextMenu` below reuses the same markup for
 * right-click, so the two are the same thing shown from different places.
 */

export interface MenuItem {
  id: string
  label: string
  icon?: IconName
  /** Shown right-aligned, e.g. "Ctrl+Z". */
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
  /** Draws a rule above this item, to group commands. */
  separatorBefore?: boolean
}

export function MenuList({
  items,
  onDone
}: {
  items: MenuItem[]
  onDone: () => void
}): JSX.Element {
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const move = (delta: number): void => {
    let next = active
    for (let step = 0; step < items.length; step += 1) {
      next = (next + delta + items.length) % items.length
      if (!items[next]?.disabled) break
    }
    setActive(next)
  }

  return (
    <ul
      ref={ref}
      className="ui-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          const item = items[active]
          if (item && !item.disabled) {
            item.onSelect()
            onDone()
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onDone()
        }
      }}
    >
      {items.map((item, index) => (
        <li key={item.id} className={item.separatorBefore ? 'ui-menu-group' : undefined}>
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={[
              'ui-menu-item',
              index === active ? 'is-active' : '',
              item.danger ? 'is-danger' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              item.onSelect()
              onDone()
            }}
          >
            <span className="ui-menu-check">{item.icon && <Icon name={item.icon} size={14} />}</span>
            <span className="ui-menu-text">{item.label}</span>
            {item.shortcut && <span className="ui-menu-shortcut">{item.shortcut}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Where the popup should sit, in viewport coordinates.
 *
 * The popup is positioned `fixed` and computed from the trigger button's own
 * rect rather than laid out `absolute` inside `.ui-menu-root`. A menu that
 * lives inside a container which clips overflow for an unrelated reason (the
 * top bar clips so a long project name cannot push controls past the window
 * edge — see `.topbar { overflow: hidden }`) would otherwise have its own
 * dropdown clipped along with it: the button stays clickable but the popup
 * that is supposed to appear below it is cut off by the ancestor's box,
 * regardless of z-index, because z-index only wins within the visible area a
 * `fixed`/`absolute` box is allowed to paint in. `ContextMenu` below already
 * solved this the same way for the right-click menu; this makes the ordinary
 * dropdown immune to the same failure wherever it is used, not just here.
 */
function popupPosition(
  trigger: HTMLElement,
  align: 'start' | 'end',
  estimatedWidth = 220
): { top: number; left: number } {
  const rect = trigger.getBoundingClientRect()
  const top = Math.min(rect.bottom + 4, window.innerHeight - 8)
  const rawLeft = align === 'end' ? rect.right - estimatedWidth : rect.left
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - estimatedWidth - 8))
  return { top, left }
}

export default function Menu({
  label,
  icon,
  items,
  align = 'start'
}: {
  label: string
  icon?: IconName
  items: MenuItem[]
  align?: 'start' | 'end'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // The trigger is outside the popup's own DOM subtree once the popup is
      // fixed-positioned at the document root, so both are checked here.
      if (root.current?.contains(target)) return
      setOpen(false)
    }
    // A fixed popup does not track the button if the page scrolls or the
    // window resizes underneath it, so it closes instead of drifting away
    // from what opened it — the same rule ContextMenu already uses.
    const onReflow = (): void => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open])

  return (
    <div className="ui-menu-root" ref={root}>
      <button
        ref={buttonRef}
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-default"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open && buttonRef.current) setPos(popupPosition(buttonRef.current, align))
          setOpen((v) => !v)
        }}
      >
        {icon && <Icon name={icon} />}
        <span className="ui-btn-label">{label}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && pos && (
        <div className="ui-menu-pop is-floating" style={{ top: pos.top, left: pos.left }}>
          <MenuList items={items} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

/** Right-click menu. Same list, positioned at the pointer. */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  // Keep the menu on screen when opened near an edge.
  const left = Math.min(x, window.innerWidth - 220)
  const top = Math.min(y, window.innerHeight - (items.length * 30 + 16))

  return (
    <div className="ui-menu-pop is-floating is-context" ref={root} style={{ left, top }}>
      <MenuList items={items} onDone={onClose} />
    </div>
  )
}
