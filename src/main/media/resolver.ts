import { AppError, Errors, serializeError } from '../../shared/errors.js'
import type { MediaProtocol, ResolverInfo, StreamInfo } from '../../shared/types.js'
import { run, runChecked } from '../services/process.js'
import type { ProcessPriority } from '../services/process.js'
import type { Logger } from '../services/logger.js'
import { locateExecutable } from '../services/locate.js'

/** Raw shape of the pieces of yt-dlp's JSON we rely on. */
export interface RawFormat {
  format_id?: string
  format_note?: string
  url?: string
  ext?: string
  protocol?: string
  vcodec?: string
  acodec?: string
  width?: number
  height?: number
  fps?: number
  tbr?: number
  vbr?: number
  abr?: number
  asr?: number
  audio_channels?: number
  /** Audio track language, e.g. "en", "de". Absent on single-track sources. */
  language?: string
  /**
   * yt-dlp's own ranking of this track's language: 10 for the default/original
   * track, -1 when it is a dub or when nothing is known. It is the only
   * machine-readable signal that separates an original from a dub.
   */
  language_preference?: number
  filesize?: number
  filesize_approx?: number
  manifest_url?: string
  http_headers?: Record<string, string>
  fragments?: Array<{ url?: string; path?: string; duration?: number }>
}

export interface RawInfo {
  id?: string
  title?: string
  uploader?: string
  channel?: string
  uploader_id?: string
  duration?: number
  upload_date?: string
  timestamp?: number
  release_timestamp?: number
  thumbnail?: string
  is_live?: boolean
  /**
   * This recording is still being written — the broadcast is on air now.
   *
   * Distinct from `is_live`, deliberately. A live channel is opened as the VOD
   * the platform is already making, so the media is an ordinary recording and
   * `is_live` is false: it seeks, it exports, it needs no rolling buffer. But
   * it is still *growing*, and the parts of the app that reason about "where is
   * this angle right now" have to know that its length is a floor, not a limit.
   */
  still_recording?: boolean
  extractor_key?: string
  webpage_url?: string
  /** Platform tags, when the extractor reports them — used to score event relevance. */
  tags?: string[]
  /** Platform category/game, e.g. "Grand Theft Auto V". Same purpose as `tags`. */
  categories?: string[]
  formats?: RawFormat[]
  url?: string
  protocol?: string
  ext?: string
}

/**
 * Which failure a yt-dlp exit actually was.
 *
 * Exported and pure so the ordering can be tested: it is the whole point.
 * DRM messages mention signing in, so DRM has to be decided first — otherwise
 * a DRM-protected video tells people to go and set up browser cookies for
 * something no cookie will ever unlock, which is worse than saying nothing.
 */
export function resolveFailure(stderr: string, platform: string, exitCode: number | null): AppError {
  if (/drm|widevine|playready|protected content/i.test(stderr)) {
    return Errors.drmProtected(stderr.slice(-800))
  }
  if (/private|members-only|sign in|log in|account/i.test(stderr)) {
    return Errors.authRequired(platform, stderr.slice(-800))
  }
  if (/unavailable|not exist|removed|deleted|404|410/i.test(stderr)) {
    return Errors.vodUnavailable(stderr.slice(-800))
  }
  return Errors.resolverFailed(stderr.slice(-1200) || `exit code ${exitCode}`)
}

export class ResolverService {
  private info: ResolverInfo = { available: false, path: null, version: null, error: null }

  /** The override path the current `info` was worked out from. */
  private detectedFor: string | null = null

  constructor(private readonly log: Logger) {}

  current(): ResolverInfo {
    return this.info
  }

  /**
   * Locate + validate yt-dlp. Remembered against the paths it was worked out
   * from, for the same reason as FFmpeg's — see `FfmpegService.detect`.
   */
  async detect(
    overridePath?: string | null,
    bundledDir?: string | null,
    opts: { force?: boolean } = {}
  ): Promise<ResolverInfo> {
    const signature = JSON.stringify([overridePath ?? null, bundledDir ?? null])
    if (!opts.force && this.info.available && this.detectedFor === signature) return this.info
    try {
      const found = await locateYtDlp(overridePath, bundledDir)
      if (!found.path) {
        this.log.debug('resolver', 'yt-dlp not found in any known location', {
          searched: found.searched
        })
        throw Errors.resolverMissing()
      }
      const result = await runChecked(found.path, ['--version'])
      const version = result.stdout.trim().split('\n')[0] ?? 'unknown'
      this.info = { available: true, path: found.path, version, error: null }
      this.detectedFor = signature
      this.log.info('resolver', 'yt-dlp detected', { path: found.path, version })
    } catch (err) {
      this.info = {
        available: false,
        path: null,
        version: null,
        error: serializeError(err instanceof Error ? err : Errors.resolverMissing())
      }
      this.detectedFor = null
      this.log.warn('resolver', 'yt-dlp not available', err)
    }
    return this.info
  }

  private require(): string {
    if (!this.info.available || !this.info.path) throw Errors.resolverMissing()
    return this.info.path
  }

  /**
   * Resolve a VOD URL to yt-dlp's metadata document.
   * The URL is passed as a discrete argv entry — never interpolated into a shell string.
   */
  async resolve(
    url: string,
    opts: {
      signal?: AbortSignal
      cookiesFromBrowser?: string | null
      /**
       * How much of the machine this lookup may take. Background crawling
       * asks for `idle`: nobody is waiting on it, and it runs for hours.
       */
      priority?: ProcessPriority
    } = {}
  ): Promise<RawInfo> {
    const bin = this.require()
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--no-progress',
      '--ignore-config'
    ]
    if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser)
    args.push('--', url)

    const result = await run(bin, args, {
      signal: opts.signal,
      idleTimeoutMs: 120_000,
      ...(opts.priority ? { priority: opts.priority } : {})
    })
    if (result.aborted) throw Errors.cancelled()
    // A stall is a failure the person needs told about, not a cancellation
    // they asked for — see RunResult.timedOut.
    if (result.timedOut) {
      throw Errors.resolverFailed('yt-dlp stopped responding and was stopped after two minutes.')
    }

    if (result.code !== 0) {
      const stderr = result.stderr
      this.log.warn('resolver', 'yt-dlp resolve failed', { code: result.code, stderr })
      throw resolveFailure(stderr, guessPlatformName(url), result.code)
    }

    try {
      return JSON.parse(result.stdout) as RawInfo
    } catch (err) {
      throw Errors.resolverFailed(`unparseable JSON from yt-dlp: ${String(err)}`)
    }
  }

  /**
   * List a channel's videos without resolving each one. `--flat-playlist` asks
   * the platform for the listing only, so opening the streamer picker costs one
   * request rather than one per VOD.
   */
  async flatPlaylist(
    url: string,
    opts: { signal?: AbortSignal; limit?: number; priority?: ProcessPriority } = {}
  ): Promise<unknown> {
    const bin = this.require()
    const args = [
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--no-progress',
      '--ignore-config',
      '--playlist-end',
      String(opts.limit ?? 40),
      '--',
      url
    ]

    const result = await run(bin, args, {
      signal: opts.signal,
      idleTimeoutMs: 120_000,
      ...(opts.priority ? { priority: opts.priority } : {})
    })
    if (result.aborted) throw Errors.cancelled()
    // A stall is a failure the person needs told about, not a cancellation
    // they asked for — see RunResult.timedOut.
    if (result.timedOut) {
      throw Errors.resolverFailed('yt-dlp stopped responding and was stopped after two minutes.')
    }
    if (result.code !== 0) {
      this.log.warn('resolver', 'yt-dlp channel listing failed', {
        code: result.code,
        stderr: result.stderr
      })
      /*
       * "This channel does not have a streams tab" is not a failure — it is
       * the answer. A YouTube channel that has never gone live has no streams
       * tab, and treating that as an error marked the channel as broken and
       * had the crawl come back to it every ten minutes forever. An empty
       * listing is the truth.
       */
      if (/does not have a \w+ tab|this channel has no videos/i.test(result.stderr)) {
        return { entries: [] }
      }
      if (/private|sign in|log in|account|bot/i.test(result.stderr)) {
        throw Errors.authRequired('this channel', result.stderr.slice(-800))
      }
      throw Errors.resolverFailed(result.stderr.slice(-1200) || `exit code ${result.code}`)
    }

    try {
      return JSON.parse(result.stdout) as unknown
    } catch (err) {
      throw Errors.resolverFailed(`unparseable JSON from yt-dlp: ${String(err)}`)
    }
  }
}

export function mapProtocol(protocol: string | undefined): MediaProtocol | null {
  if (!protocol) return null
  if (protocol.startsWith('m3u8')) return 'hls'
  if (protocol === 'http_dash_segments') return 'fragmented'
  if (protocol === 'https' || protocol === 'http') return 'http-range'
  return null
}

/** Convert yt-dlp formats into the app's StreamInfo model. Unusable entries are dropped. */
export function toStreamInfos(raw: RawInfo): StreamInfo[] {
  const formats = raw.formats ?? []
  const out: StreamInfo[] = []

  for (const f of formats) {
    const url = f.url
    if (!url) continue
    const protocol = mapProtocol(f.protocol)
    if (!protocol) continue

    const hasVideo = Boolean(f.vcodec && f.vcodec !== 'none')
    const hasAudio = Boolean(f.acodec && f.acodec !== 'none')
    if (!hasVideo && !hasAudio) continue

    const bitrate =
      (hasVideo ? (f.vbr ?? f.tbr) : (f.abr ?? f.tbr)) !== undefined
        ? Math.round(((hasVideo ? (f.vbr ?? f.tbr) : (f.abr ?? f.tbr)) as number) * 1000)
        : undefined

    out.push({
      id: f.format_id ?? `${f.ext ?? 'fmt'}-${out.length}`,
      container: f.ext,
      codec: hasVideo ? f.vcodec : f.acodec,
      width: f.width,
      height: f.height,
      fps: f.fps,
      bitrate,
      sampleRate: f.asr,
      channels: f.audio_channels,
      language: f.language,
      originalAudio: isOriginalAudio(f),
      filesize: f.filesize ?? f.filesize_approx,
      protocol,
      label: formatLabel(f, hasVideo, hasAudio),
      url,
      httpHeaders: f.http_headers,
      hasVideo,
      hasAudio
    })
  }

  return out
}

/**
 * Is this the track the video was actually recorded in?
 *
 * `language_preference` is the field to trust: yt-dlp sets it to 10 for the
 * default/original audio track and leaves it at -1 for dubs. `format_note` is
 * checked as a fallback only — it carries the same claim in words ("English
 * original (default)") and survives on extractors that do not set the numeric
 * preference, but it is display text and cannot be the primary signal.
 *
 * Undefined preference is NOT treated as original: on a single-track source
 * every format is unmarked, and calling them all original would be a claim the
 * data does not make. Nothing downstream needs it to — ranking only changes
 * when at least one track is positively marked.
 */
function isOriginalAudio(f: RawFormat): boolean | undefined {
  if (typeof f.language_preference === 'number' && f.language_preference >= 10) return true
  if (f.format_note && /\boriginal\b/i.test(f.format_note)) return true
  return undefined
}

function formatLabel(f: RawFormat, hasVideo: boolean, hasAudio: boolean): string {
  if (hasVideo) {
    const res = f.height ? `${f.height}p` : (f.format_note ?? f.format_id ?? 'video')
    const fps = f.fps && f.fps >= 50 ? String(Math.round(f.fps)) : ''
    const codec = shortCodec(f.vcodec)
    const av = hasAudio ? ' +audio' : ''
    return `${res}${fps}${codec ? ` ${codec}` : ''}${av}`
  }
  const abr = f.abr ? `${Math.round(f.abr)} kbps` : (f.format_note ?? 'audio')
  const codec = shortCodec(f.acodec)
  return `${codec ? `${codec} ` : ''}${abr}`
}

export function shortCodec(codec: string | undefined): string {
  if (!codec || codec === 'none') return ''
  if (codec.startsWith('avc1') || codec.startsWith('h264')) return 'H.264'
  if (codec.startsWith('hev1') || codec.startsWith('hvc1') || codec.startsWith('h265')) return 'HEVC'
  if (codec.startsWith('av01')) return 'AV1'
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 'VP9'
  if (codec.startsWith('mp4a')) return 'AAC'
  if (codec.startsWith('opus')) return 'Opus'
  if (codec.startsWith('vorbis')) return 'Vorbis'
  return codec.split('.')[0]
}

function guessPlatformName(url: string): string {
  if (/twitch\.tv/i.test(url)) return 'Twitch'
  if (/kick\.com/i.test(url)) return 'Kick'
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube'
  return 'the platform'
}

async function locateYtDlp(
  override: string | null | undefined,
  bundledDir: string | null | undefined
): Promise<{ path: string | null; searched: string[] }> {
  // yt-dlp ships under several names depending on how it was installed.
  const names =
    process.platform === 'win32'
      ? ['yt-dlp.exe', 'yt-dlp.cmd', 'yt-dlp_x86.exe', 'yt-dlp_min.exe']
      : ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos']
  return locateExecutable(names, { override, bundledDir })
}
