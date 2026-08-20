import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import Button from './Button.js'
import IconButton from './IconButton.js'

/**
 * The dialog.
 *
 * One shell for everything modal, from a two-line confirmation to the settings
 * window. It owns the scrim, the escape key, the focus trap and the return of
 * focus to whatever opened it — behaviour that was previously either absent or
 * delegated to `window.confirm`, which cannot be styled, cannot be themed and
 * blocks the whole process while it is open.
 */

export type DialogSize = 'small' | 'medium' | 'large'

interface Props {
  title: string
  /** One sentence under the title. Optional; omit rather than pad. */
  description?: string
  size?: DialogSize
  onClose: () => void
  /** Buttons for the footer. Primary action last, as Windows orders them. */
  footer?: ReactNode
  children?: ReactNode
}

export default function Dialog({
  title,
  description,
  size = 'medium',
  onClose,
  footer,
  children
}: Props): JSX.Element {
  const panel = useRef<HTMLDivElement | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null
    const focusable = panel.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    focusable?.focus()
    return () => returnTo.current?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      // Trap the tab ring inside the dialog.
      const items = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      ].filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="ui-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        className={`ui-dialog is-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="ui-dialog-head">
          <div className="ui-dialog-heading">
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        {children !== undefined && <div className="ui-dialog-body">{children}</div>}
        {footer && <footer className="ui-dialog-foot">{footer}</footer>}
      </div>
    </div>
  )
}

/**
 * The confirmation dialog — the replacement for `window.confirm`.
 *
 * Every "are you sure" in the application goes through this, so they all read
 * the same way: a question as the title, the consequence as the description,
 * cancel then confirm, with the confirm button styled `danger` when the action
 * destroys something.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Dialog
      title={title}
      description={description}
      size="small"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  )
}

/**
 * A dialog that asks for one line of text — the replacement for
 * `window.prompt`. Enter commits, Escape cancels.
 */
export function PromptDialog({
  title,
  description,
  label,
  defaultValue = '',
  confirmLabel = 'OK',
  onConfirm,
  onCancel
}: {
  title: string
  description?: string
  label: string
  defaultValue?: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const input = useRef<HTMLInputElement | null>(null)

  return (
    <Dialog
      title={title}
      description={description}
      size="small"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => onConfirm(input.current?.value.trim() ?? '')}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <label className="ui-field">
        <span className="ui-field-label">{label}</span>
        <input
          ref={input}
          className="ui-input"
          defaultValue={defaultValue}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm((e.target as HTMLInputElement).value.trim())
          }}
        />
      </label>
    </Dialog>
  )
}
