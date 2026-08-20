import { useEffect, useRef, useState } from 'react'
import { formatTimecode, parseTimecode } from '@shared/time'

/**
 * A timecode field.
 *
 * Editing a moment in a six-hour VOD is not the same job as typing a name, so
 * this does not behave like a plain text box:
 *
 *   • it always displays HH:MM:SS.mmm, and says so under itself;
 *   • Up/Down nudge the value by a unit, Shift+Up/Down by a second, so the
 *     playhead can be walked without retyping;
 *   • it validates on commit and shows what was wrong rather than silently
 *     reverting;
 *   • it commits on blur and on Enter, and abandons the edit on Escape.
 *
 * It is deliberately uncontrolled while focused: reformatting under the caret
 * as someone types is the thing that makes time fields infuriating.
 */
interface Props {
  seconds: number
  onCommit: (seconds: number) => void
  /** Upper bound — usually the POV's duration. Rejected above this. */
  max?: number
  readOnly?: boolean
  id?: string
  label?: string
  className?: string
}

export default function TimeInput({
  seconds,
  onCommit,
  max,
  readOnly,
  id,
  label,
  className
}: Props): JSX.Element {
  const [text, setText] = useState(() => formatTimecode(seconds))
  const [error, setError] = useState<string | null>(null)
  const editing = useRef(false)

  // Follow the model while the field is not being typed into.
  useEffect(() => {
    if (!editing.current) setText(formatTimecode(seconds))
  }, [seconds])

  const commit = (raw: string): void => {
    const parsed = parseTimecode(raw)
    if (parsed === null) {
      setError('Use HH:MM:SS.mmm')
      return
    }
    if (parsed < 0) {
      setError('Cannot be negative')
      return
    }
    if (max !== undefined && parsed > max) {
      setError(`Later than the end of this recording (${formatTimecode(max, { millis: false })})`)
      return
    }
    setError(null)
    setText(formatTimecode(parsed))
    onCommit(parsed)
  }

  const nudge = (delta: number): void => {
    const parsed = parseTimecode(text)
    if (parsed === null) return
    const next = Math.max(0, max === undefined ? parsed + delta : Math.min(max, parsed + delta))
    setText(formatTimecode(next))
    onCommit(next)
  }

  return (
    <span className={`ui-time${error ? ' is-invalid' : ''}${className ? ` ${className}` : ''}`}>
      <input
        id={id}
        aria-label={label}
        className="ui-input is-mono ui-time-input"
        value={text}
        readOnly={readOnly}
        inputMode="numeric"
        aria-invalid={error !== null || undefined}
        onFocus={() => {
          editing.current = true
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          editing.current = false
          commit(text)
        }}
        onKeyDown={(e) => {
          if (readOnly) return
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setText(formatTimecode(seconds))
            setError(null)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            nudge(e.shiftKey ? 1 : 0.1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(e.shiftKey ? -1 : -0.1)
          }
        }}
      />
      <span className="ui-time-format" aria-hidden="true">
        hh:mm:ss.ms
      </span>
      {error && <span className="ui-field-error">{error}</span>}
    </span>
  )
}
