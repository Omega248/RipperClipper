import { useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon.js'

/**
 * The dropdown.
 *
 * A native `<select>` cannot be styled consistently across Windows, and the
 * application had nineteen of them, each inheriting whatever Chromium chose.
 * This is one listbox with one surface, one radius, one arrow and one set of
 * keyboard rules: Up/Down move, Home/End jump, Enter and Space commit, Escape
 * closes and returns focus, typing jumps to a matching option.
 *
 * The value contract is the same as the native element it replaces — `value`
 * plus `onChange(value)` — so swapping one in never changes call-site logic.
 */

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  /** Second line in the menu, for options that need a sentence of context. */
  hint?: string
  disabled?: boolean
}

interface Props<T extends string = string> {
  value: T
  options: Array<SelectOption<T>>
  onChange: (value: T) => void
  /** Accessible name. Use when there is no visible <label> pointing here. */
  label?: string
  id?: string
  disabled?: boolean
  size?: 'compact' | 'default'
  /** Widen to the container instead of hugging the current label. */
  block?: boolean
  className?: string
}

export default function Select<T extends string = string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  size = 'default',
  block,
  className
}: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)))
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const typed = useRef({ text: '', at: 0 })
  const generatedId = useId()
  const buttonId = id ?? generatedId
  const current = options.find((o) => o.value === value)

  /*
   * The menu is positioned `fixed` from the trigger's own rect instead of
   * `absolute` inside `.ui-select`. Several places this control is used sit
   * inside a panel that clips overflow for an unrelated reason (the video
   * stage, the top bar) — an `absolute` popup would be cut off by that
   * ancestor's box no matter its z-index, because z-index only wins within
   * the area the ancestor lets its children paint in. Computing the position
   * from the button and rendering it there instead is what keeps a control
   * usable regardless of what it happens to be placed inside.
   */
  const place = (): void => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = Math.max(rect.width, 200)
    const top = Math.min(rect.bottom + 4, window.innerHeight - 8)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    setPos({ top, left, width })
  }

  // Close on an outside click or when the window loses focus, never on a
  // click inside the menu itself. A fixed popup does not track the trigger
  // if the page scrolls or resizes underneath it, so it closes rather than
  // drifting away from what opened it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    const onBlur = (): void => setOpen(false)
    const onReflow = (): void => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    place()
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    // Focus the list so arrow keys work without a further click.
    listRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const commit = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  const move = (delta: number): void => {
    let next = active
    for (let step = 0; step < options.length; step += 1) {
      next = (next + delta + options.length) % options.length
      if (!options[next]?.disabled) break
    }
    setActive(next)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        move(-1)
        break
      case 'Home':
        e.preventDefault()
        setActive(0)
        break
      case 'End':
        e.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        commit(active)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        rootRef.current?.querySelector('button')?.focus()
        break
      case 'Tab':
        setOpen(false)
        break
      default: {
        if (e.key.length !== 1) return
        const now = Date.now()
        typed.current = {
          text: now - typed.current.at > 700 ? e.key : typed.current.text + e.key,
          at: now
        }
        const match = options.findIndex((o) =>
          o.label.toLowerCase().startsWith(typed.current.text.toLowerCase())
        )
        if (match >= 0) setActive(match)
      }
    }
  }

  return (
    <div
      ref={rootRef}
      className={['ui-select', `ui-select-${size}`, block ? 'is-block' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <button
        ref={triggerRef}
        type="button"
        id={buttonId}
        className="ui-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="ui-select-value">{current?.label ?? ''}</span>
        <Icon name="chevron-down" size={14} />
      </button>

      {open && pos && (
        <ul
          ref={listRef}
          className="ui-menu ui-select-menu is-floating"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={buttonId}
          aria-activedescendant={`${buttonId}-opt-${active}`}
          onKeyDown={onKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${buttonId}-opt-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled}
              className={[
                'ui-menu-item',
                index === active ? 'is-active' : '',
                option.value === value ? 'is-selected' : '',
                option.disabled ? 'is-disabled' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(index)}
            >
              <span className="ui-menu-check">{option.value === value ? <Icon name="check" size={14} /> : null}</span>
              <span className="ui-menu-text">
                <span>{option.label}</span>
                {option.hint && <span className="ui-menu-hint">{option.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
