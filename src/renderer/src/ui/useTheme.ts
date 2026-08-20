import { useEffect } from 'react'
import type { ThemeMode } from '@shared/types'

/**
 * Resolve the theme mode to an actual theme and put it on <html>.
 *
 * `system` is the default, so the hook listens to the OS preference and
 * re-resolves when it changes — the whole interface repaints at once because
 * every colour in the application comes from one variable block keyed on
 * `data-theme`. There is no per-page theme state to fall out of step.
 */
export function useTheme(mode: ThemeMode | undefined): void {
  useEffect(() => {
    const resolved = mode ?? 'system'
    const query = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const theme = resolved === 'system' ? (query.matches ? 'dark' : 'light') : resolved
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
    }

    apply()
    if (resolved !== 'system') return
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [mode])
}
