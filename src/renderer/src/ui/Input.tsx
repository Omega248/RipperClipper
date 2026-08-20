import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import Icon from './Icon.js'

/**
 * Text input, and the field wrapper that gives every labelled control in the
 * application the same label position, gap and error treatment.
 */

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Renders the invalid styling and links the message for screen readers. */
  invalid?: boolean
  mono?: boolean
  size?: 'compact' | 'default'
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, size = 'default', className, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      className={[
        'ui-input',
        `ui-input-${size}`,
        mono ? 'is-mono' : '',
        invalid ? 'is-invalid' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  )
})

export default Input

/** Label + control + optional hint and error, laid out identically everywhere. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  layout = 'row'
}: {
  label: string
  hint?: string
  error?: string
  htmlFor?: string
  children: ReactNode
  /** `row` puts the label to the left; `stack` puts it above. */
  layout?: 'row' | 'stack'
}): JSX.Element {
  return (
    <div className={`ui-field is-${layout}`}>
      <label className="ui-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="ui-field-control">
        {children}
        {hint && !error && <p className="ui-field-hint">{hint}</p>}
        {error && (
          <p className="ui-field-error">
            <Icon name="alert" size={13} />
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

/** A checkbox with its label, as one control. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <label className={`ui-checkbox${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

/** A labelled slider. The value is always shown — a bare track is unreadable. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format,
  width = 120
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  label: string
  format?: (value: number) => string
  width?: number
}): JSX.Element {
  return (
    <label className="ui-slider">
      <span className="ui-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ width }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="ui-slider-value">{format ? format(value) : String(value)}</span>
    </label>
  )
}
