import { useEffect, useRef } from 'react'
import { DEFAULT_SHORTCUTS } from '@shared/defaults'
import { useStore } from '../store.js'
import { playerBus } from '../player/controller.js'

/** Serialise a KeyboardEvent into the same notation used by the settings store. */
export function bindingOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.code)
  return parts.join('+')
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

/**
 * Global editing shortcuts. They never fire while the user is typing into a
 * field, so renaming a clip cannot accidentally delete it.
 *
 * `onFindInPovs`/`onCommandPalette` are callbacks rather than store actions
 * because opening those dialogs is App-local UI state, the same as every
 * other dialog's open/close flag.
 */
export function useShortcuts(onFindInPovs: () => void, onCommandPalette: () => void): void {
  // Refs, not dependencies: an inline arrow prop would otherwise re-attach
  // the window listener on every render that passes a fresh closure.
  const onFindInPovsRef = useRef(onFindInPovs)
  onFindInPovsRef.current = onFindInPovs
  const onCommandPaletteRef = useRef(onCommandPalette)
  onCommandPaletteRef.current = onCommandPalette

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const state = useStore.getState()
      const shortcuts = state.settings?.shortcuts ?? DEFAULT_SHORTCUTS
      const binding = bindingOf(e)

      const match = (action: keyof typeof DEFAULT_SHORTCUTS): boolean =>
        shortcuts[action] === binding

      // Fixed, not user-remappable — the same convention as every other app's
      // command palette, so it's never a surprise which key opens it.
      if (binding === 'Ctrl+KeyK') {
        e.preventDefault()
        onCommandPaletteRef.current()
        return
      }

      const time = state.currentTime

      if (match('playPause') || match('playPauseAlt')) {
        e.preventDefault()
        if (state.playing) playerBus.pause()
        else playerBus.play()
        return
      }
      if (match('seekBack')) {
        e.preventDefault()
        playerBus.seek(time - 5)
        return
      }
      if (match('seekForward')) {
        e.preventDefault()
        playerBus.seek(time + 5)
        return
      }
      if (match('seekBackLarge')) {
        e.preventDefault()
        playerBus.seek(time - 30)
        return
      }
      if (match('seekForwardLarge')) {
        e.preventDefault()
        playerBus.seek(time + 30)
        return
      }
      if (match('setIn')) {
        e.preventDefault()
        state.setInPoint(time)
        return
      }
      if (match('setOut')) {
        e.preventDefault()
        state.setOutPoint(time)
        return
      }
      if (match('addClip')) {
        e.preventDefault()
        state.requestCreateClip()
        return
      }
      if (match('deleteClip')) {
        if (!state.selectedClipId) return
        e.preventDefault()
        state.deleteClip(state.selectedClipId)
        return
      }
      if (match('prevClip') || match('nextClip')) {
        e.preventDefault()
        const clips = state.project?.clips.filter((c) => c.sourceId === state.activeSourceId) ?? []
        if (clips.length === 0) return
        const ordered = clips.slice().sort((a, b) => a.order - b.order)
        const index = ordered.findIndex((c) => c.id === state.selectedClipId)
        const next = Math.max(
          0,
          Math.min(ordered.length - 1, index + (match('prevClip') ? -1 : 1))
        )
        state.selectClip(ordered[next].id)
        playerBus.seek(ordered[next].startSeconds)
        return
      }
      if (match('addMarker')) {
        e.preventDefault()
        state.addMarker()
        return
      }
      if (match('findInPovs')) {
        e.preventDefault()
        onFindInPovsRef.current()
        return
      }
      if (match('undo')) {
        e.preventDefault()
        state.undo()
        return
      }
      if (match('redo')) {
        e.preventDefault()
        state.redo()
        return
      }
      if (match('loopSelection')) {
        e.preventDefault()
        state.setLoopSelection(!state.loopSelection)
        return
      }
      if (match('zoomIn')) {
        e.preventDefault()
        state.zoomBy(0.6, state.currentTime)
        return
      }
      if (match('zoomOut')) {
        e.preventDefault()
        state.zoomBy(1.6, state.currentTime)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
