/**
 * Just enough `electron` to run main-process code outside Electron.
 *
 * Several services reach the network through `net.fetch` rather than global
 * fetch, because inside the app that routes through Chromium's stack and picks
 * up its proxy and TLS handling. Outside the app there is no Chromium, but the
 * *logic* around those calls is exactly what a sandbox run wants to exercise —
 * so `net.fetch` becomes plain `fetch` here and everything above it is real.
 *
 * A development aid, like the loader that installs it. Nothing in `src/` may
 * depend on this file.
 */
export const net = {
  fetch: (...args) => globalThis.fetch(...args)
}

export const app = {
  getPath: () => process.cwd(),
  getVersion: () => '0.0.0-sandbox',
  getAppMetrics: () => []
}

export const shell = { openPath: async () => '', openExternal: async () => undefined }
export const ipcMain = { handle: () => undefined, on: () => undefined }
export const BrowserWindow = class {}
export const dialog = {}
export default { net, app, shell, ipcMain, BrowserWindow, dialog }
