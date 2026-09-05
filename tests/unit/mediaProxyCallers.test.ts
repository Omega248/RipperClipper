import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Nobody writes a media-proxy URL by hand.
 *
 * This has now broken playback twice. The proxy requires a per-run secret and
 * answers 403 *before* fetching anything, so a caller that spells the URL out
 * itself does not fail loudly — the player simply reports the recording as
 * unplayable, which reads like a platform problem and is not one.
 *
 * The first time it was `playbackSrc`, fixed by sharing `mediaProxyUrl` and
 * making the token a required argument so the compiler would find the callers.
 * It found three. The fourth — the main viewport, `usePlayerViewport` — built
 * its own template string and the compiler had nothing to say about it.
 *
 * Types cannot catch a string. This can.
 */
const root = fileURLToPath(new URL('../../src/', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}${name}`
    if (statSync(path).isDirectory()) return sourceFiles(`${path}/`)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('media proxy URLs', () => {
  it('are only ever built by shared/mediaProxyUrl.ts', () => {
    const offenders = sourceFiles(root)
      .filter((path) => !path.endsWith('shared/mediaProxyUrl.ts'))
      .filter((path) => /\/media\/(manifest|segment)|\/media\/\$\{/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(root.length))

    expect(offenders, 'call mediaProxyUrl() or playbackSrc() instead').toEqual([])
  })
})
