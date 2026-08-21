import { useEffect } from 'react'
import { useStore } from '../store.js'
import { Button, Icon, IconButton } from '../ui/index.js'
import type { IconName } from '../ui/index.js'

/**
 * Notifications.
 *
 * Four kinds, one shape, one position. Everything except an error dismisses
 * itself, because a toast the editor has to clear is a toast that interrupts
 * them twice. The icon carries the kind as well as the colour does.
 */
const ICONS: Record<string, IconName> = {
  success: 'check',
  error: 'alert',
  warning: 'alert',
  info: 'info'
}

export default function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts
      .filter((t) => t.kind !== 'error')
      .map((t) => setTimeout(() => dismiss(t.id), 6000))
    return () => timers.forEach(clearTimeout)
  }, [toasts, dismiss])

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <Icon name={ICONS[toast.kind] ?? 'info'} />
          <strong>{toast.title}</strong>
          <IconButton
            icon="close"
            label="Dismiss"
            size="compact"
            onClick={() => dismiss(toast.id)}
          />
          <p>{toast.message}</p>
          {toast.action && (
            <Button
              size="compact"
              variant="ghost"
              className="toast-action"
              onClick={() => {
                toast.action!.onClick()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
