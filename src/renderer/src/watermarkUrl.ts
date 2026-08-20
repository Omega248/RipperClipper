import type { WatermarkImage } from '@shared/watermark'

/**
 * Where the renderer loads a watermark image from.
 *
 * Deliberately not `file://` — the renderer is served over http and a
 * `file://` image is cross-origin, so it is blocked outright and the watermark
 * simply does not appear.
 *
 * It has to be the *absolute* loopback URL rather than a relative path.  A
 * relative path works in a packaged build, where the page and `/watermark/`
 * are served by the same loopback server — but under `npm run dev` the page
 * comes from the Vite dev server on a different port, and a relative
 * `/watermark/…` asks Vite for a file it has never heard of.  Same symptom,
 * only in dev: a picked image that never shows up.
 *
 * The page's Content-Security-Policy has to allow loopback http for this;
 * see `img-src` in `src/renderer/index.html`.
 *
 * The renderer still never learns a filesystem path — only the file's name.
 */
export function watermarkUrl(image: WatermarkImage, base: string | undefined): string {
  // The library owns the folder; only the name is ever needed, and only the
  // name is ever sent, so nothing here can point outside it.
  const name = image.path.replace(/\\/g, '/').split('/').pop() ?? ''
  const path = `/watermark/${encodeURIComponent(name)}`
  return base ? `${base.replace(/\/$/, '')}${path}` : path
}
