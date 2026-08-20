import type { ReactNode } from 'react'
import Icon from './Icon.js'
import type { IconName } from './Icon.js'
import Button from './Button.js'

/**
 * The states a panel can be in other than "showing content": loading, empty,
 * and error. They are components rather than ad-hoc markup because these are
 * exactly the states that get written in a hurry and end up as a blank pane or
 * an exit code on screen.
 */

/** Measurable work. Anything with a fraction should show one of these. */
export function ProgressBar({
  value,
  tone = 'accent',
  label
}: {
  /** 0–1. Pass `undefined` for work whose length is not known. */
  value?: number
  tone?: 'accent' | 'success' | 'danger'
  label?: string
}): JSX.Element {
  const pct = value === undefined ? undefined : Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      className={`ui-progress is-${tone}${pct === undefined ? ' is-indeterminate' : ''}`}
      role="progressbar"
      aria-valuenow={pct === undefined ? undefined : Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={pct === undefined ? undefined : { width: `${pct}%` }} />
    </div>
  )
}

/** Work whose length is not known. */
export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span className="ui-spinner" role="status">
      <Icon name="spinner" />
      {label && <span>{label}</span>}
    </span>
  )
}

/** A block of placeholder shapes while real content is fetched. */
export function Skeleton({ rows = 3 }: { rows?: number }): JSX.Element {
  return (
    <div className="ui-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  )
}

/**
 * An empty state says three things: what is empty, why it might be, and the
 * one thing to do about it. A blank panel says none of them.
 */
export function EmptyState({
  icon = 'info',
  title,
  description,
  action
}: {
  icon?: IconName
  title: string
  description?: string
  action?: { label: string; onClick: () => void; icon?: IconName }
}): JSX.Element {
  return (
    <div className="ui-empty">
      <Icon name={icon} size={22} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && (
        <Button variant="primary" icon={action.icon} onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

/**
 * An error the editor can act on. The plain sentence is the message; anything
 * with an exit code, a codec name or a stack in it belongs behind the
 * disclosure, not in front of someone trying to cut a clip.
 */
export function ErrorState({
  title,
  description,
  details,
  actions
}: {
  title: string
  description?: string
  details?: string
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="ui-error-state">
      <Icon name="alert" size={22} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actions && <div className="ui-error-actions">{actions}</div>}
      {details && (
        <details className="ui-details">
          <summary>Show technical details</summary>
          <pre>{details}</pre>
        </details>
      )}
    </div>
  )
}

/** An inline notice inside a page — not a toast, not a dialog. */
export function Notice({
  tone = 'info',
  title,
  children,
  actions
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success'
  title?: string
  children?: ReactNode
  actions?: ReactNode
}): JSX.Element {
  const icon: IconName = tone === 'info' || tone === 'success' ? 'info' : 'alert'
  return (
    <div className={`ui-notice is-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon} size={16} />
      <div className="ui-notice-body">
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {actions && <div className="ui-notice-actions">{actions}</div>}
    </div>
  )
}
