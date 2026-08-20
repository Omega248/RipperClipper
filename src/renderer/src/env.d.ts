/// <reference types="vite/client" />
import type { RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
  /** Compile-time flag — see electron.vite.config.ts. False strips the Editor from the build entirely. */
  const __EDITOR_ENABLED__: boolean
}

export {}
