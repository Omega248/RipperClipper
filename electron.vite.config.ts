import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * The Editor is a development-only feature. `npm run dev`'s live server
 * always has it; a packaged build only does when explicitly asked for one
 * with `RIPPER_EDITOR=1` (see `package:win:dev` in package.json) — a plain
 * `npm run package:win` never sets it, so the production installer's bundle
 * never contains the Editor's code at all, not merely a build that hides it.
 */
export default defineConfig(({ command }) => {
  const editorEnabled = command === 'serve' || process.env.RIPPER_EDITOR === '1'
  const define = { __EDITOR_ENABLED__: JSON.stringify(editorEnabled) }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': resolve('src/shared'),
          '@main': resolve('src/main')
        }
      },
      define,
      build: {
        rollupOptions: {
          input: { index: resolve('src/main/index.ts') }
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: { '@shared': resolve('src/shared') }
      },
      build: {
        rollupOptions: {
          input: { index: resolve('src/preload/index.ts') }
        }
      }
    },
    renderer: {
      root: resolve('src/renderer'),
      resolve: {
        alias: {
          '@shared': resolve('src/shared'),
          '@renderer': resolve('src/renderer/src')
        }
      },
      define,
      plugins: [react()],
      build: {
        rollupOptions: {
          input: { index: resolve('src/renderer/index.html') }
        }
      }
    }
  }
})
