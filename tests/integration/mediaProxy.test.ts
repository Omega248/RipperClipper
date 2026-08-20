import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { startLocalServer } from '../../src/main/localServer.js'
import type { LocalServer } from '../../src/main/localServer.js'
import { CHUNKS, buildFixture, chunkIndexAt, sampleColor } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * The preview player fetches through the app's own loopback proxy so that
 * playback is always same-origin. These tests use FFmpeg as an independent,
 * strict HLS client: if it can play the proxied manifest end to end, a browser
 * player can too.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let origin: MediaServer
let local: LocalServer

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-proxy-'))
  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  const info = await ffmpeg.detect({})
  if (!info.available) throw new Error('FFmpeg is required to run the proxy tests')

  const fixture = await buildFixture(root)
  origin = await startMediaServer(fixture.root)
  local = await startLocalServer(null)
}, 300_000)

afterAll(async () => {
  await local?.close()
  await origin?.close()
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

const proxied = (kind: 'manifest' | 'segment', target: string): string =>
  `${local.loopbackUrl}/media/${kind}?u=${encodeURIComponent(target)}`

describe('media proxy', () => {
  it('serves the rewritten manifest same-origin with permissive CORS', async () => {
    const res = await fetch(proxied('manifest', `${origin.url}/hls/master.m3u8`))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('content-type')).toContain('mpegurl')

    const body = await res.text()
    expect(body.startsWith('#EXTM3U')).toBe(true)
    // Every referenced URI now points back at the proxy, not at the CDN.
    const uris = body.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
    expect(uris.length).toBeGreaterThan(0)
    for (const uri of uris) expect(uri.startsWith(`${local.loopbackUrl}/media/`)).toBe(true)
  })

  it('answers CORS preflight', async () => {
    const res = await fetch(proxied('manifest', `${origin.url}/hls/master.m3u8`), {
      method: 'OPTIONS'
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('plays end to end through the proxy — a real HLS client can read it', async () => {
    const out = join(root, 'through-proxy.mp4')
    await ffmpeg.exec(
      [
        '-y',
        '-ss',
        '25',
        '-i',
        proxied('manifest', `${origin.url}/hls/master.m3u8`),
        '-t',
        '4',
        '-c',
        'copy',
        out
      ],
      { label: 'proxy playback' }
    )

    const size = await stat(out)
    expect(size.size).toBeGreaterThan(1000)

    const probe = await ffmpeg.probe(out)
    expect(probe.streams.some((s) => s.codec_type === 'video')).toBe(true)
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true)

    // The media that came through really is the right part of the VOD.
    expectColorNear(await sampleColor(out, 0.3), CHUNKS[chunkIndexAt(25)].rgb)
  })

  it('passes Range requests through to the origin', async () => {
    const res = await fetch(proxied('segment', `${origin.url}/source.mp4`), {
      headers: { Range: 'bytes=100-199' }
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toMatch(/^bytes 100-199\//)
    expect((await res.arrayBuffer()).byteLength).toBe(100)
  })

  it('refuses anything that is not a plain http(s) target', async () => {
    for (const target of ['file:///etc/passwd', 'not-a-url', '']) {
      const res = await fetch(
        `${local.loopbackUrl}/media/segment?u=${encodeURIComponent(target)}`
      )
      expect(res.status, target).toBe(400)
    }
  })

  it('reports an unreachable origin instead of hanging', async () => {
    const res = await fetch(proxied('manifest', 'http://127.0.0.1:1/nothing.m3u8'))
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('Upstream request failed')
  })

  it('does not serve files when no renderer directory is configured', async () => {
    const res = await fetch(`${local.loopbackUrl}/index.html`)
    expect(res.status).toBe(404)
  })
})

function expectColorNear(actual: [number, number, number], expected: readonly number[]): void {
  const distance = Math.sqrt(
    (actual[0] - expected[0]) ** 2 + (actual[1] - expected[1]) ** 2 + (actual[2] - expected[2]) ** 2
  )
  expect(
    distance,
    `expected rgb(${actual.join(',')}) to be close to rgb(${expected.join(',')})`
  ).toBeLessThan(60)
}
