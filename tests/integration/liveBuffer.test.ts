import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { LiveBuffer } from '../../src/main/media/liveBuffer.js'
import { bufferedSeconds } from '../../src/shared/live.js'
import type { StreamInfo } from '../../src/shared/types.js'

/**
 * The rolling buffer against a real socket.
 *
 * Real live network testing is impossible in a suite, so this drives a fixture
 * origin that behaves the way a platform does: a sliding-window playlist with
 * a media sequence that advances, PROGRAM-DATE-TIME on the first segment, no
 * ENDLIST until the broadcast finishes — and the ability to start refusing
 * connections mid-run, which is the case the feature exists to survive.
 *
 * The segments are not real media. Nothing here decodes: the buffer holds
 * bytes, bounds them and maps them onto the event clock, and those are the
 * properties under test.
 */

const SEGMENT_SECONDS = 2
const SEGMENT_BYTES = 4096
const EPOCH = Date.parse('2026-08-29T14:00:00.000Z') / 1000

/** A fixture origin whose broadcast advances only when a test says so. */
class FakeOrigin {
  private server: Server | null = null
  /** Segments published so far. The window shown is the last `windowLength`. */
  published = 6
  windowLength = 6
  endList = false
  /** When true every request is refused, standing in for a dropped connection. */
  offline = false
  requests = 0
  url = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.requests += 1
      if (this.offline) {
        res.destroy()
        return
      }
      if ((req.url ?? '').endsWith('.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
        res.end(this.playlist())
        return
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end(Buffer.alloc(SEGMENT_BYTES, 7))
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const addr = this.server!.address()
    if (typeof addr === 'string' || addr === null) throw new Error('no address')
    this.url = `http://127.0.0.1:${addr.port}`
  }

  /** Publish `count` more segments, as the broadcast continuing. */
  advance(count: number): void {
    this.published += count
  }

  /** Some encoders publish no PROGRAM-DATE-TIME at all; see the test below. */
  stampDates = true

  playlist(): string {
    const first = Math.max(0, this.published - this.windowLength)
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`
    ]
    if (this.stampDates) {
      lines.push(
        `#EXT-X-PROGRAM-DATE-TIME:${new Date((EPOCH + first * SEGMENT_SECONDS) * 1000).toISOString()}`
      )
    }
    for (let i = first; i < this.published; i++) {
      lines.push(`#EXTINF:${SEGMENT_SECONDS}.000,`, `${i}.ts`)
    }
    if (this.endList) lines.push('#EXT-X-ENDLIST')
    return lines.join('\n') + '\n'
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

let origin: FakeOrigin
let log: Logger
let dir: string
let buffer: LiveBuffer | null = null

function stream(): StreamInfo {
  return {
    id: 'live',
    protocol: 'hls',
    label: 'source',
    url: `${origin.url}/live.m3u8`,
    hasVideo: true,
    hasAudio: true
  }
}

/** Wait until `check` holds, or fail — never a bare sleep. */
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('condition was never reached')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vodclip-live-'))
  log = new Logger(join(dir, 'logs'))
  origin = new FakeOrigin()
  await origin.start()
})

afterEach(async () => {
  buffer?.stop()
  buffer = null
  await origin.close()
  await log.close()
  await rm(dir, { recursive: true, force: true })
})

describe('a live source', () => {
  it('ingests the window and reports it as live', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    expect(buffer.state.state).toBe('live')
    expect(buffer.state.bufferedSeconds).toBe(12)
    expect(buffer.buffered.map((s) => s.sequence)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('puts held media on the event clock from PROGRAM-DATE-TIME, not the wall clock', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    // The fixture's broadcast started in the past. A buffer that timestamped
    // media by arrival would place all of this "now" and every clip cut
    // against it would be minutes wrong.
    expect(buffer.buffered[0].startEpoch).toBe(EPOCH)
    expect(buffer.buffered[5].startEpoch).toBe(EPOCH + 10)
  })

  it('still places media on a rising clock when the playlist carries no dates', async () => {
    /*
     * Not every encoder publishes PROGRAM-DATE-TIME, and the fallback used to
     * be `now - bufferedSeconds(held)` evaluated per segment before the push
     * — the start of the *oldest* held segment, not the newest.
     *
     * `lastSequence` starts at -1, so the first poll ingests the whole
     * playlist as one batch with `now` effectively constant while the held
     * total grows. The stamps therefore went backwards across the batch, and
     * `segments[0].startEpoch` ended up greater than the live edge, which
     * makes `covers` unsatisfiable for every range: each live clip failed
     * with "Clip it sooner" for a moment sitting in memory.
     */
    origin.stampDates = false
    const clock = EPOCH + 1000
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60, now: () => clock })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    const held = buffer.buffered
    // Strictly rising with sequence — the contract on startEpoch.
    for (let i = 1; i < held.length; i++) {
      expect(held[i].startEpoch, `segment ${i} vs ${i - 1}`).toBeGreaterThan(held[i - 1].startEpoch)
    }

    // The newest segment sits at the live edge, not the oldest.
    const last = held[held.length - 1]
    expect(last.startEpoch + last.durationSeconds).toBeCloseTo(clock, 3)

    // And the buffer can therefore actually answer for what it is holding.
    expect(buffer.covers(held[0].startEpoch, last.startEpoch + last.durationSeconds)).toBe(true)
    expect(buffer.covers(held[0].startEpoch + 1, last.startEpoch)).toBe(true)
  })

  it('never holds more than the configured window, however long the stream runs', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 10 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length > 0)

    // Twenty minutes of broadcast through a ten-second buffer.
    for (let i = 0; i < 10; i++) {
      origin.advance(60)
      await until(() => buffer!.buffered.some((s) => s.sequence >= origin.published - 6), 8000)
      expect(bufferedSeconds(buffer.buffered)).toBeLessThanOrEqual(10 + SEGMENT_SECONDS)
    }
  }, 60_000)

  it('identifies the same media across refreshes after the window slides', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    origin.advance(3)
    await until(() => buffer!.buffered.length >= 9)

    // Nine distinct segments, not six re-ingested because their positions moved.
    expect(new Set(buffer.buffered.map((s) => s.sequence)).size).toBe(9)
  })
})

describe('a live source that drops', () => {
  it('goes to reconnecting and keeps every byte it had', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)
    const beforeDrop = buffer.buffered.length

    origin.offline = true
    await until(() => buffer!.state.state === 'reconnecting')

    expect(buffer.state.state).toBe('reconnecting')
    expect(buffer.buffered.length).toBe(beforeDrop)
    expect(buffer.state.bufferedSeconds).toBe(12)
  })

  it('comes back to live, and clears the retry count, when the origin returns', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    origin.offline = true
    await until(() => buffer!.state.state === 'reconnecting')
    origin.offline = false

    await until(() => buffer!.state.state === 'live', 10_000)
    expect(buffer.state.retries).toBe(0)
  }, 20_000)
})

describe('a broadcast that finishes', () => {
  it('goes to awaiting-vod rather than to an error, and keeps its media', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    origin.endList = true
    await until(() => buffer!.state.state === 'awaiting-vod')

    expect(buffer.buffered.length).toBeGreaterThan(0)
    expect(buffer.state.archivedVodId).toBeUndefined()
  })

  it('completes when the archive resolves, without touching what is held', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)
    origin.endList = true
    await until(() => buffer!.state.state === 'awaiting-vod')

    const startEpochs = buffer.buffered.map((s) => s.startEpoch)
    buffer.archiveResolved('v1234')

    expect(buffer.state.state).toBe('ended')
    expect(buffer.state.archivedVodId).toBe('v1234')
    // The event range a clip was stored against never moved, so nothing about
    // the held media is recomputed when the archive appears.
    expect(buffer.buffered.map((s) => s.startEpoch)).toEqual(startEpochs)
  })

  it('stops asking the origin for new media once the broadcast is over', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)
    origin.endList = true
    await until(() => buffer!.state.state === 'awaiting-vod')

    const settled = origin.requests
    await new Promise((r) => setTimeout(r, 400))
    // The archive poll is on a minutes clock, so nothing at all in 400ms.
    expect(origin.requests).toBe(settled)
  })
})

describe('reading the buffer', () => {
  it('serves a range it holds, and refuses one it does not', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    expect(buffer.covers(EPOCH + 2, EPOCH + 8)).toBe(true)
    // Before the held band — media the app does not have.
    expect(buffer.covers(EPOCH - 60, EPOCH + 2)).toBe(false)

    const out = join(dir, 'recent.ts')
    const held = await buffer.writeRange(EPOCH + 2, EPOCH + 8, out)
    expect(held).not.toBeNull()
    expect((await readFile(out)).length).toBeGreaterThan(0)
    // Whole segments, so the file starts on a boundary rather than mid-GOP.
    expect(held!.windowStartEpoch).toBeLessThanOrEqual(EPOCH + 2)
    expect(held!.windowEndEpoch).toBeGreaterThanOrEqual(EPOCH + 8)

    expect(await buffer.writeRange(EPOCH - 60, EPOCH + 2, out)).toBeNull()
  })
})

describe('an idle app', () => {
  it('runs no timers once a source is stopped', async () => {
    buffer = new LiveBuffer(log, 'src:1', { windowSeconds: 60 })
    await buffer.start(stream())
    await until(() => buffer!.buffered.length >= 6)

    buffer.stop()
    const settled = origin.requests
    await new Promise((r) => setTimeout(r, 400))

    expect(origin.requests).toBe(settled)
    expect(buffer.buffered).toHaveLength(0)
  })
})
