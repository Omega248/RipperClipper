import type { ButtonHTMLAttributes, ReactNode } from 'react'
import Icon from './Icon.js'
import type { IconName } from './Icon.js'

/**
 * The button.
 *
 * There is one of these in the application. Height, padding, radius, type,
 * hover, active, focus, disabled and loading are decided here and nowhere
 * else, so two buttons that do the same kind of work cannot end up looking
 * different because they were written on different days.
 *
 * Variants carry meaning rather than decoration:
 *   primary   — the one action a screen is about. At most one per region.
 *   secondary — supporting actions.
 *   ghost     — low-priority actions that should recede until wanted.
 *   danger    — destructive. Always visually distinct, never primary-styled.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'compact' | 'default' | 'large'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  /** Icon after the label — for "opens a menu" or "goes forward" senses. */
  iconAfter?: IconName
  /** Shows a spinner and blocks input without changing the button's width. */
  loading?: boolean
  /** Pressed state for toggles; also sets aria-pressed. */
  selected?: boolean
  fullWidth?: boolean
  children?: ReactNode
}

export default function Button({
  variant = 'secondary',
  size = 'default',
  icon,
  iconAfter,
  loading = false,
  selected,
  fullWidth,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={[
        'ui-btn',
        `ui-btn-${variant}`,
        `ui-btn-${size}`,
        selected ? 'is-selected' : '',
        loading ? 'is-loading' : '',
        fullWidth ? 'is-block' : '',
        children === undefined ? 'is-icon-only' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      aria-pressed={selected}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Icon name="spinner" /> : icon ? <Icon name={icon} /> : null}
      {children !== undefined && <span className="ui-btn-label">{children}</span>}
      {iconAfter && !loading && <Icon name={iconAfter} />}
    </button>
  )
}
