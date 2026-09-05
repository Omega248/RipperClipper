import { createWriteStream } from 'node:fs'
import { utimes, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { toFfmpegTime } from '../../shared/time.js'
import type { StreamInfo } from '../../shared/types.js'
import type { Logger } from '../services/logger.js'
import type { CacheManager } from '../services/cache.js'
import { ConcurrencyLimiter } from '../services/limiter.js'
import type { FfmpegService } from './ffmpeg.js'
import { assertHttpUrl, fetchBuffer, fetchText, headerArgs } from './http.js'
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

/** Segments of one window fetched at once. */
export const DEFAULT_SEGMENT_PARALLELISM = 8

/**
 * Total segment requests in flight across the whole application.
 *
 * A per-window figure on its own multiplies by however many exports the queue
 * is running: thirty jobs each holding eight segments is thirty times the
 * sockets aimed at one CDN and thirty times the memory, which is how a
 * "download faster" change turns into rate limiting and swapping. The window
 * below bounds one job; this bounds all of them together.
 */
export const segmentLimiter = new ConcurrencyLimiter(48)

/**
 * Segment downloads currently in flight, by cache key.
 *
 * The disk cache dedupes across time; this dedupes across *consumers*. Without
 * it, a player, a queued export and a prefetch that all want the same segment
 * at the same moment issue three identical requests, because none of them has
 * written the cache entry the others would have hit.
 */
const inFlightSegments = new Map<string, Promise<{ data: Buffer; fromCache: boolean }>>()

/**
 * Above this many segments a window is an archive of the broadcast rather
 * than a clip, and the segment cache stops being written to.
 *
 * The cache exists so two overlapping *clip* selections share the media they
 * have in common. A four-hour window shares nothing with anything, so caching
 * it only writes every byte to disk a second time, then evicts it all again —
 * pure IO and hashing for no reuse. Reads still consult the cache, so a clip
 * pulled earlier is still free.
 */
const CACHE_BYPASS_SEGMENT_COUNT = 240

export class RangeFetcher {
  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly cache: CacheManager,
    private tempDir: string
  ) {}

  private segmentParallelism = DEFAULT_SEGMENT_PARALLELISM

  setTempDir(dir: string): void {
    this.tempDir = dir
  }

  /** How many segments of a single window are fetched at once. */
  setSegmentParallelism(value: number): void {
    this.segmentParallelism = Math.max(1, Math.min(64, Math.round(value)))
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

  /**
   * A finished VOD's media playlist, fetched once.
   *
   * Every window goes through here — the exporter's video pass, its audio
   * pass, thumbnails, waveforms, scene detection, the preview builder — and a
   * four-hour Twitch playlist is a couple of hundred kilobytes of text with
   * over a thousand entries. Re-fetching and re-parsing it per window was
   * hundreds of megabytes and a serialised round trip in front of every
   * download, for a document that cannot change: `endList` means the
   * broadcast is over and the list is final.
   *
   * Only finished playlists are held. A live one is a moving target and must
   * be read fresh every time, which is the whole reason `endList` is checked
   * rather than the URL being cached blindly.
   */
  private readonly playlists = new Map<string, { playlist: HlsMediaPlaylist; url: string }>()

  /**
   * How many finished playlists to keep.
   *
   * The map had no bound at all, and this service is one long-lived instance:
   * every window request routes through it, including the ones ordinary
   * browsing makes — filmstrips, waveforms, scene marks, previews — not just
   * exports. A four-hour rendition parses to well over a thousand segment
   * objects, each holding a long signed CDN URL, so roughly a megabyte of
   * retained heap per playlist that was never released for the life of the
   * session.
   *
   * It could not converge either: the key is the media-playlist URL, which
   * Twitch and Kick sign freshly on every resolve, so re-opening the same VOD
   * added a second entry for identical media rather than hitting the first.
   *
   * Sixteen keeps what the cache is actually for — one export reads the same
   * playlist for its video pass, its audio pass, the filmstrip and the
   * waveform — while putting a ceiling on a session that browses a library.
   */
  private static readonly MAX_PLAYLISTS = 16

  private async resolveMediaPlaylist(stream: StreamInfo): Promise<{
    playlist: HlsMediaPlaylist
    url: string
  }> {
    const cached = this.playlists.get(stream.url)
    if (cached) return cached

    const resolved = await this.readMediaPlaylist(stream)
    if (resolved.playlist.endList) {
      this.playlists.set(stream.url, resolved)
      // Map iteration is insertion-ordered, so the first key is the oldest.
      while (this.playlists.size > RangeFetcher.MAX_PLAYLISTS) {
        const oldest = this.playlists.keys().next().value
        if (oldest === undefined) break
        this.playlists.delete(oldest)
      }
    }
    return resolved
  }

  private async readMediaPlaylist(stream: StreamInfo): Promise<{
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
    // A megabyte of write buffer, not the default 64KB: several segments can
    // finish while the writer is between awaits, and a small buffer turns
    // that into a syscall per chunk.
    const out = createWriteStream(req.destination, { highWaterMark: 1 << 20 })
    let bytes = 0
    let cachedSegments = 0
    const total = selection.segments.length
    const writeThrough = total <= CACHE_BYPASS_SEGMENT_COUNT

    const write = (buf: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()))
      })

    /*
     * Segments have to reach the file in playlist order, but nothing says they
     * have to be *fetched* in that order — and fetching them in order was the
     * single biggest limit on throughput here. Awaiting each segment before
     * asking for the next one capped a download at one segment per round trip:
     * a four-hour VOD is roughly 1,400 segments, so 80ms of latency alone cost
     * about two minutes of doing nothing, and the connection sat idle for the
     * whole gap between "last byte in" and "next request out".
     *
     * So a sliding window of `parallel` requests stays in flight while the
     * writer consumes them strictly in index order. The window also bounds
     * memory: at most `parallel` segments are held at once, however long the
     * VOD is.
     */
    const parallel = Math.max(1, Math.min(this.segmentParallelism, total))
    const inFlight = new Map<number, Promise<{ data: Buffer; fromCache: boolean }>>()

    const begin = (i: number): void => {
      if (i >= total) return
      const segment = selection.segments[i]
      const pending = this.getSegment(
        segment.uri,
        segment.byteRange,
        req.stream.httpHeaders,
        req.signal,
        writeThrough
      )
      // The writer surfaces this rejection when it reaches index `i`. Until
      // then the promise needs a handler, or a segment failing ahead of the
      // writer is an unhandled rejection — which takes the process down.
      pending.catch(() => undefined)
      inFlight.set(i, pending)
    }

    try {
      if (selection.mapUri) {
        const init = await this.getSegment(
          selection.mapUri,
          undefined,
          req.stream.httpHeaders,
          req.signal,
          writeThrough
        )
        await write(init.data)
        bytes += init.data.length
      }

      for (let i = 0; i < parallel; i++) begin(i)

      for (let i = 0; i < total; i++) {
        if (req.signal?.aborted) throw Errors.cancelled()
        const pending = inFlight.get(i)
        if (!pending) throw Errors.downloadFailed(`segment ${i} was never requested`)
        inFlight.delete(i)
        const result = await pending
        // Refill as soon as a slot frees, so the window stays full rather
        // than draining while this segment is written.
        begin(i + parallel)
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
      // On the error path the window is still full of live requests. They are
      // already individually handled by `begin`, and their AbortSignal is the
      // caller's, so there is nothing to await — just drop the references.
      inFlight.clear()
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

  /**
   * One segment, from the cache if it is there and the network otherwise.
   *
   * `store` is what separates a clip from an archive: a clip's segments are
   * worth keeping because the next clip may overlap them, whereas a whole
   * broadcast's are written once and never asked for again.
   */
  private getSegment(
    uri: string,
    byteRange: { length: number; offset: number } | undefined,
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
    store = true
  ): Promise<{ data: Buffer; fromCache: boolean }> {
    const key = this.cache.keyFor(byteRange ? `${uri}#${byteRange.offset}+${byteRange.length}` : uri)

    const pending = inFlightSegments.get(key)
    if (pending) {
      return pending.then(
        ({ data }) => ({ data, fromCache: true }),
        () => {
          // The owner failed, or was cancelled by *its* consumer — which says
          // nothing about this one. Ask again rather than failing a job that
          // was never cancelled.
          return this.getSegment(uri, byteRange, headers, signal, store)
        }
      )
    }

    // Deliberately not `async`: the entry has to be registered in the same
    // synchronous turn as the lookup above. With an `await` between the two —
    // even the cache lookup — two consumers both find the map empty, both
    // miss the cache, and both download. That window is small enough to pass
    // a test most of the time, which is worse than not deduping at all.
    const request = this.loadSegment(key, uri, byteRange, headers, signal, store)
    inFlightSegments.set(key, request)
    // A joiner may attach later; without a handler now, a rejection is
    // unhandled until then, which takes the process down.
    request.catch(() => undefined)
    void request.finally(() => {
      if (inFlightSegments.get(key) === request) inFlightSegments.delete(key)
    })
    return request
  }

  /**
   * One segment, from the cache if it is there and the network otherwise.
   *
   * `store` is what separates a clip from an archive: a clip's segments are
   * worth keeping because the next clip may overlap them, whereas a whole
   * broadcast's are written once and never asked for again.
   */
  private async loadSegment(
    key: string,
    uri: string,
    byteRange: { length: number; offset: number } | undefined,
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
    store: boolean
  ): Promise<{ data: Buffer; fromCache: boolean }> {
    const cachedSize = await this.cache.has(key)
    if (cachedSize) {
      try {
        const data = await readFile(this.cache.pathFor(key))
        /*
         * Touch it, so a hit counts as a use.
         *
         * Eviction sorts by modified time, and reading a file does not change
         * it — so a segment shared by five overlapping clips looked strictly
         * older than one written once and never wanted again, and the cache
         * threw out precisely the media it exists to keep. Best-effort: a
         * failed touch costs a re-download later, never the read happening now.
         */
        void utimes(this.cache.pathFor(key), new Date(), new Date()).catch(() => undefined)
        return { data, fromCache: true }
      } catch {
        // fall through to a fresh download
      }
    }

    const requestHeaders: Record<string, string> = { ...(headers ?? {}) }
    if (byteRange) {
      requestHeaders.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`
    }

    // Only the transfer is limited. A cache hit above never touches the
    // network and must not queue behind thirty jobs' worth of downloads.
    const data = await segmentLimiter.run(() =>
      fetchBuffer(uri, { headers: requestHeaders, signal })
    )
    if (store) {
      await this.cache.put(key, data).catch((err) => {
        this.log.warn('cache', 'Could not cache segment', err)
        return ''
      })
    }
    return { data, fromCache: false }
  }

  // -------------------------------------------------------- HTTP range ----

  private async fetchHttpWindow(req: FetchWindowRequest): Promise<FetchedWindow> {
    const leadIn = Math.min(HTTP_LEAD_IN_SECONDS, req.startSeconds)
    const windowStart = Math.max(0, req.startSeconds - leadIn)
    const windowEnd = req.endSeconds + HTTP_LEAD_OUT_SECONDS
    const windowDuration = windowEnd - windowStart

    // The stream and its headers come from the renderer, so neither is trusted
    // here: a `file:///` or `concat:` URL after `-i` reads local files, and a
    // line break inside a header value injects headers of its own.
    assertHttpUrl(req.stream.url)
    const headers = headerArgs(req.stream.httpHeaders)

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
      ...headers,
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
    const value = Number(probe.format.start_time)
    return Number.isFinite(value) ? value : 0
  }

  tempPath(name: string): string {
    return join(this.tempDir, name)
  }
}
