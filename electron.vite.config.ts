import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Three build channels, one `RIPPER_CHANNEL` env var:
 *
 *   stable        the public release — no Editor, no dev-only code
 *   experimental  same code as `dev`, packaged like `stable` (no Editor) —
 *                 a beta channel for trying upcoming stable-bound changes
 *                 before they're actually promoted to a release
 *   dev           everything, including the Editor
 *
 * `npm run dev`'s live server always behaves as `dev`, unset otherwise
 * defaults to `stable`. Only `dev` gets the Editor: `__EDITOR_ENABLED__` is
 * replaced with a literal `true`/`false` at build time, which lets Rollup
 * prove the Editor's own `import()` is unreachable in the other two channels
 * and drop the whole module graph from the built output — not merely hide
 * it. `__CHANNEL__` is separate and broader: main/index.ts uses it to keep
 * each channel's userData (projects, cache, settings) in its own folder, so
 * testing an experimental build can never touch real production data.
 */
export default defineConfig(({ command }) => {
  const channel: 'stable' | 'experimental' | 'dev' =
    command === 'serve' || process.env.RIPPER_CHANNEL === 'dev' || process.env.RIPPER_EDITOR === '1'
      ? 'dev'
      : process.env.RIPPER_CHANNEL === 'experimental'
        ? 'experimental'
        : 'stable'
  const editorEnabled = channel === 'dev'
  const define = {
    __EDITOR_ENABLED__: JSON.stringify(editorEnabled),
    __CHANNEL__: JSON.stringify(channel)
  }

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
