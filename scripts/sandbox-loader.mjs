/**
 * Run this repo's TypeScript directly, with no bundler and no node_modules.
 *
 * Why it exists: `node_modules` here is installed for Windows, so on any other
 * machine (a Linux sandbox, CI without a fresh install) Vitest cannot start —
 * Rollup's native binary is missing and the registry may be unreachable. But
 * the main-process code is plain Node with no Electron imports, so it can be
 * run directly if two things are solved:
 *
 *  1. Node's type stripping needs `--experimental-transform-types`, not
 *     `--experimental-strip-types`: this codebase uses constructor parameter
 *     properties, which strip-only mode refuses.
 *  2. The source imports siblings as `./x.js` (correct ESM for the built
 *     output), and those files are `.ts` on disk. This hook maps one to the
 *     other when the `.ts` actually exists.
 *  3. Some of it imports `net` from electron. That is shimmed rather than
 *     stubbed out, so the network calls are real and only the transport
 *     differs.
 *
 * Usage:
 *   node --experimental-transform-types --import ./scripts/sandbox-loader.mjs your-script.mts
 *
 * This is a development aid for verifying behaviour outside a Windows build.
 * It is not part of the app and nothing in `src/` may depend on it.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const electronShim = new URL('./electron-shim.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    // Main-process code that fetches through Chromium's stack imports `net`
    // from electron. Outside the app that module does not exist, and without
    // this the whole file is unloadable — including the parts that have
    // nothing to do with Electron. See scripts/electron-shim.mjs.
    if (specifier === 'electron') return { url: electronShim, shortCircuit: true }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
      const base = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href
      const url = new URL(specifier.replace(/\.js$/, '.ts'), base)
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  }
})
