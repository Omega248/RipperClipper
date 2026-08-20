import type { ButtonHTMLAttributes } from 'react'
import Icon from './Icon.js'
import type { IconName } from './Icon.js'
import Tooltip from './Tooltip.js'
import type { ButtonSize, ButtonVariant } from './Button.js'

/**
 * A button whose whole content is an icon.
 *
 * `label` is mandatory: it becomes the accessible name *and* the tooltip, so
 * an icon-only control can never ship without an explanation of what it does.
 */
interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: IconName
  label: string
  variant?: ButtonVariant
  size?: ButtonSize
  selected?: boolean
}

export default function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'default',
  selected,
  className,
  ...rest
}: Props): JSX.Element {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        className={[
          'ui-btn',
          'is-icon-only',
          `ui-btn-${variant}`,
          `ui-btn-${size}`,
          selected ? 'is-selected' : '',
          className ?? ''
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  )
}
