import { Errors, serializeError } from '../../shared/errors.js'
import type { MediaProtocol, ResolverInfo, StreamInfo } from '../../shared/types.js'
import { run, runChecked } from '../services/process.js'
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

export class ResolverService {
  private info: ResolverInfo = { available: false, path: null, version: null, error: null }

  constructor(private readonly log: Logger) {}

  current(): ResolverInfo {
    return this.info
  }

  async detect(overridePath?: string | null, bundledDir?: string | null): Promise<ResolverInfo> {
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
      this.log.info('resolver', 'yt-dlp detected', { path: found.path, version })
    } catch (err) {
      this.info = {
        available: false,
        path: null,
        version: null,
        error: serializeError(err instanceof Error ? err : Errors.resolverMissing())
      }
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
    opts: { signal?: AbortSignal; cookiesFromBrowser?: string | null } = {}
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

    const result = await run(bin, args, { signal: opts.signal, idleTimeoutMs: 120_000 })
    if (result.aborted) throw Errors.cancelled()

    if (result.code !== 0) {
      const stderr = result.stderr
      this.log.warn('resolver', 'yt-dlp resolve failed', { code: result.code, stderr })
      if (/private|members-only|sign in|log in|account/i.test(stderr)) {
        throw Errors.authRequired(guessPlatformName(url), stderr.slice(-800))
      }
      if (/unavailable|not exist|removed|deleted|404|410/i.test(stderr)) {
        throw Errors.vodUnavailable(stderr.slice(-800))
      }
      throw Errors.resolverFailed(stderr.slice(-1200) || `exit code ${result.code}`)
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
    opts: { signal?: AbortSignal; limit?: number } = {}
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

    const result = await run(bin, args, { signal: opts.signal, idleTimeoutMs: 120_000 })
    if (result.aborted) throw Errors.cancelled()
    if (result.code !== 0) {
      this.log.warn('resolver', 'yt-dlp channel listing failed', {
        code: result.code,
        stderr: result.stderr
      })
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
