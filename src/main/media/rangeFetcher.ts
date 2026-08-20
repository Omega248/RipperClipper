import { createWriteStream } from 'node:fs'
import { readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { toFfmpegTime } from '../../shared/time.js'
import type { StreamInfo } from '../../shared/types.js'
import type { Logger } from '../services/logger.js'
import type { CacheManager } from '../services/cache.js'
import type { FfmpegService } from './ffmpeg.js'
import { fetchBuffer, fetchText } from './http.js'
import { parsePlaylist, selectSegments, sortVariants } from './hls.js'
import type { HlsMediaPlaylist } from './hls.js'

/**
 * Fetches ONLY the media covering a requested time window.
 *
 * HLS sources are handled by parsing the media playlist's #EXTINF timeline and
 * downloading the covering segments — never the whole VOD. Plain HTTP sources
 * are handled by asking FFmpeg to seek into the remote file, which issues HTTP
 * Range requests for the needed bytes only.
 */

export interface FetchWindowRequest {
  stream: StreamInfo
  /** Requested clip range, in source timeline seconds. */
  startSeconds: number
  endSeconds: number
  /** Destination file (extension chosen by the caller). */
  destination: string
  signal?: AbortSignal
  onProgress?: (p: { receivedBytes: number; totalBytes: number | null; fraction: number }) => void
}

export interface FetchedWindow {
  file: string
  /** Source-timeline time corresponding to the first frame of `file`. */
  windowStartSeconds: number
  windowEndSeconds: number
  bytes: number
  /** Segments served from the cache rather than the network. */
  cachedSegments: number
  totalSegments: number
}

/** Seconds of lead-in requested for HTTP-range sources so a keyframe precedes the cut. */
const HTTP_LEAD_IN_SECONDS = 12
const HTTP_LEAD_OUT_SECONDS = 2

export class RangeFetcher {
  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly cache: CacheManager,
    private tempDir: string
  ) {}

  setTempDir(dir: string): void {
    this.tempDir = dir
  }

  async fetchWindow(req: FetchWindowRequest): Promise<FetchedWindow> {
    switch (req.stream.protocol) {
      case 'hls':
        return this.fetchHlsWindow(req)
      case 'http-range':
        return this.fetchHttpWindow(req)
      case 'fragmented':
        // Fragmented DASH is exposed by the resolver as an ordinary HTTP
        // resource with Range support; FFmpeg handles both identically.
        return this.fetchHttpWindow(req)
      default:
        throw Errors.rangeUnsupported(
          'This source',
          `Unsupported media protocol "${String(req.stream.protocol)}".`
        )
    }
  }

  // ---------------------------------------------------------------- HLS ----

  private async resolveMediaPlaylist(stream: StreamInfo): Promise<{
    playlist: HlsMediaPlaylist
    url: string
  }> {
    const headers = stream.httpHeaders
    const text = await fetchText(stream.url, { headers })
    const parsed = parsePlaylist(text, stream.url)

    if (parsed.kind === 'media') return { playlist: parsed, url: stream.url }

    // Master playlist: pick the variant that matches the chosen format.
    const ranked = sortVariants(parsed.variants)
    const preferred =
      ranked.find(
        (v) =>
          stream.height !== undefined &&
          v.height === stream.height &&
          (stream.fps === undefined || Math.round(v.frameRate ?? 0) === Math.round(stream.fps))
      ) ??
      ranked.find((v) => stream.height !== undefined && v.height === stream.height) ??
      ranked[0]

    if (!preferred) throw Errors.qualityUnavailable('any HLS variant', 'master playlist was empty')

    const mediaText = await fetchText(preferred.uri, { headers })
    const mediaParsed = parsePlaylist(mediaText, preferred.uri)
    if (mediaParsed.kind !== 'media') {
      throw Errors.resolverFailed('HLS master playlist pointed at another master playlist')
    }
    return { playlist: mediaParsed, url: preferred.uri }
  }

  private async fetchHlsWindow(req: FetchWindowRequest): Promise<FetchedWindow> {
    const { playlist } = await this.resolveMediaPlaylist(req.stream)
    if (playlist.segments.length === 0) {
      throw Errors.vodUnavailable('HLS media playlist contained no segments')
    }

    const selection = selectSegments(playlist, req.startSeconds, req.endSeconds, 0)
    if (selection.segments.length === 0) {
      throw Errors.invalidRange('The selected range falls outside this VOD.')
    }

    this.log.info('range', 'HLS window selected', {
      requested: [req.startSeconds, req.endSeconds],
      window: [selection.windowStartSeconds, selection.windowEndSeconds],
      segments: selection.segments.length,
      ofTotal: playlist.segments.length
    })

    await this.cache.ensure()
    const out = createWriteStream(req.destination)
    let bytes = 0
    let cachedSegments = 0
    const total = selection.segments.length

    const write = (buf: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()))
      })

    try {
      if (selection.mapUri) {
        const init = await this.getSegment(
          selection.mapUri,
          undefined,
          req.stream.httpHeaders,
          req.signal
        )
        await write(init.data)
        bytes += init.data.length
      }

      for (let i = 0; i < selection.segments.length; i++) {
        if (req.signal?.aborted) throw Errors.cancelled()
        const segment = selection.segments[i]
        const result = await this.getSegment(
          segment.uri,
          segment.byteRange,
          req.stream.httpHeaders,
          req.signal
        )
        if (result.fromCache) cachedSegments++
        await write(result.data)
        bytes += result.data.length
        req.onProgress?.({
          receivedBytes: bytes,
          totalBytes: null,
          fraction: (i + 1) / total
        })
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve))
    }

    if (bytes === 0) {
      await unlink(req.destination).catch(() => undefined)
      throw Errors.downloadFailed('no media bytes were received for the selected range')
    }

    return {
      file: req.destination,
      windowStartSeconds: selection.windowStartSeconds,
      windowEndSeconds: selection.windowEndSeconds,
      bytes,
      cachedSegments,
      totalSegments: total
    }
  }

  private async getSegment(
    uri: string,
    byteRange: { length: number; offset: number } | undefined,
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined
  ): Promise<{ data: Buffer; fromCache: boolean }> {
    const key = this.cache.keyFor(byteRange ? `${uri}#${byteRange.offset}+${byteRange.length}` : uri)
    const cachedSize = await this.cache.has(key)
    if (cachedSize) {
      try {
        return { data: await readFile(this.cache.pathFor(key)), fromCache: true }
      } catch {
        // fall through to a fresh download
      }
    }

    const requestHeaders: Record<string, string> = { ...(headers ?? {}) }
    if (byteRange) {
      requestHeaders.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`
    }

    const data = await fetchBuffer(uri, { headers: requestHeaders, signal })
    await this.cache.put(key, data).catch((err) => {
      this.log.warn('cache', 'Could not cache segment', err)
      return ''
    })
    return { data, fromCache: false }
  }

  // -------------------------------------------------------- HTTP range ----

  private async fetchHttpWindow(req: FetchWindowRequest): Promise<FetchedWindow> {
    const leadIn = Math.min(HTTP_LEAD_IN_SECONDS, req.startSeconds)
    const windowStart = Math.max(0, req.startSeconds - leadIn)
    const windowEnd = req.endSeconds + HTTP_LEAD_OUT_SECONDS
    const windowDuration = windowEnd - windowStart

    const headerArgs: string[] = []
    if (req.stream.httpHeaders && Object.keys(req.stream.httpHeaders).length > 0) {
      const joined = Object.entries(req.stream.httpHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')
      headerArgs.push('-headers', `${joined}\r\n`)
    }

    // -copyts keeps source timestamps so we can learn exactly where the
    // downloaded window starts on the VOD timeline.
    const args = [
      '-y',
      '-progress',
      'pipe:1',
      '-nostats',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '10',
      '-multiple_requests',
      '1',
      '-seekable',
      '1',
      // Bound the container-analysis read so opening a multi-gigabyte VOD
      // costs a few megabytes rather than a full sequential download.
      '-probesize',
      '5M',
      '-analyzeduration',
      '5M',
      ...headerArgs,
      '-ss',
      toFfmpegTime(windowStart),
      '-to',
      toFfmpegTime(windowEnd),
      '-copyts',
      '-i',
      req.stream.url,
      '-map',
      '0',
      '-c',
      'copy',
      req.destination
    ]

    await this.ffmpeg.exec(args, {
      signal: req.signal,
      label: `fetch window ${req.stream.id}`,
      onProgress: (p) => {
        // With -copyts, out_time is an absolute source timestamp.
        const done = Math.max(0, p.outTimeSeconds - windowStart)
        req.onProgress?.({
          receivedBytes: p.totalSizeBytes,
          totalBytes: null,
          fraction: windowDuration > 0 ? Math.min(1, done / windowDuration) : 0
        })
      }
    })

    const size = await stat(req.destination)
    const firstPts = await this.probeStartTime(req.destination)

    this.log.info('range', 'HTTP window fetched', {
      requested: [req.startSeconds, req.endSeconds],
      window: [firstPts, windowEnd],
      bytes: size.size
    })

    return {
      file: req.destination,
      windowStartSeconds: Number.isFinite(firstPts) ? firstPts : windowStart,
      windowEndSeconds: windowEnd,
      bytes: size.size,
      cachedSegments: 0,
      totalSegments: 1
    }
  }

  private async probeStartTime(file: string): Promise<number> {
    const probe = await this.ffmpeg.probe(file, ['-show_entries', 'format=start_time'])
    const raw = (probe.format as unknown as { start_time?: string }).start_time
    const value = Number(raw)
    return Number.isFinite(value) ? value : 0
  }

  tempPath(name: string): string {
    return join(this.tempDir, name)
  }
}
