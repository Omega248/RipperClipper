import { Errors, serializeError } from '../../shared/errors.js'
import type { FfmpegInfo, HwAccelPreference } from '../../shared/types.js'
import { run, runChecked } from '../services/process.js'
import type { RunOptions } from '../services/process.js'
import type { Logger } from '../services/logger.js'
import { executableNames, locateExecutable } from '../services/locate.js'

/** Encoders we will consider for hardware-accelerated re-encodes, in preference order. */
const HW_ENCODERS: Array<{ name: string; family: HwAccelPreference }> = [
  { name: 'h264_nvenc', family: 'nvenc' },
  { name: 'hevc_nvenc', family: 'nvenc' },
  { name: 'av1_nvenc', family: 'nvenc' },
  { name: 'h264_qsv', family: 'qsv' },
  { name: 'hevc_qsv', family: 'qsv' },
  { name: 'h264_amf', family: 'amf' },
  { name: 'hevc_amf', family: 'amf' },
  { name: 'h264_videotoolbox', family: 'videotoolbox' },
  { name: 'hevc_videotoolbox', family: 'videotoolbox' },
  { name: 'h264_vaapi', family: 'vaapi' }
]

export interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  start_time?: string
  duration?: string
  bit_rate?: string
  sample_rate?: string
  channels?: number
  nb_frames?: string
  tags?: Record<string, string>
}

export interface FfprobeResult {
  streams: FfprobeStream[]
  format: {
    filename?: string
    format_name?: string
    duration?: string
    size?: string
    bit_rate?: string
  }
}

export interface KeyframeInfo {
  /** Sorted PTS (seconds) of keyframes found in the probed window. */
  times: number[]
}

export class FfmpegService {
  private info: FfmpegInfo = {
    available: false,
    ffmpegPath: null,
    ffprobePath: null,
    version: null,
    hwEncoders: [],
    error: null
  }

  constructor(private readonly log: Logger) {}

  current(): FfmpegInfo {
    return this.info
  }

  /** Locate + validate ffmpeg/ffprobe. Never assumes they exist. */
  async detect(overrides: {
    ffmpegPath?: string | null
    ffprobePath?: string | null
    bundledDir?: string | null
  }): Promise<FfmpegInfo> {
    try {
      const ffmpegFound = await locateExecutable(executableNames('ffmpeg'), {
        override: overrides.ffmpegPath,
        bundledDir: overrides.bundledDir
      })
      const ffprobeFound = await locateExecutable(executableNames('ffprobe'), {
        override: overrides.ffprobePath,
        bundledDir: overrides.bundledDir
      })
      const ffmpegPath = ffmpegFound.path
      const ffprobePath = ffprobeFound.path

      if (!ffmpegPath || !ffprobePath) {
        this.log.debug('ffmpeg', 'FFmpeg not found in any known location', {
          searched: [...new Set([...ffmpegFound.searched, ...ffprobeFound.searched])]
        })
        throw Errors.ffmpegMissing()
      }

      const versionResult = await runChecked(ffmpegPath, ['-hide_banner', '-version'])
      const version = /ffmpeg version (\S+)/.exec(versionResult.stdout)?.[1] ?? 'unknown'

      const encodersResult = await run(ffmpegPath, ['-hide_banner', '-encoders'])
      const listed = HW_ENCODERS.filter((e) =>
        new RegExp(`\\b${e.name}\\b`).test(encodersResult.stdout)
      ).map((e) => e.name)

      // Being listed by `-encoders` only means the build supports the encoder,
      // not that this machine can run it. Each candidate is smoke-tested by
      // actually encoding one frame, so the app never picks a GPU encoder that
      // would fail mid-export.
      const smokeTested = await Promise.all(
        listed.map(async (name) => ((await smokeTestEncoder(ffmpegPath, name)) ? name : null))
      )
      const hwEncoders = smokeTested.filter((name): name is string => name !== null)

      this.info = {
        available: true,
        ffmpegPath,
        ffprobePath,
        version,
        hwEncoders,
        error: null
      }
      this.log.info('ffmpeg', 'FFmpeg detected', { ffmpegPath, ffprobePath, version, hwEncoders })
    } catch (err) {
      this.info = {
        available: false,
        ffmpegPath: null,
        ffprobePath: null,
        version: null,
        hwEncoders: [],
        error: serializeError(err instanceof Error ? err : Errors.ffmpegMissing())
      }
      this.log.warn('ffmpeg', 'FFmpeg not available', err)
    }
    return this.info
  }

  private require(): { ffmpeg: string; ffprobe: string } {
    if (!this.info.available || !this.info.ffmpegPath || !this.info.ffprobePath) {
      throw Errors.ffmpegMissing()
    }
    return { ffmpeg: this.info.ffmpegPath, ffprobe: this.info.ffprobePath }
  }

  /** Best hardware encoder for the requested family, or null for software. */
  pickHwEncoder(preference: HwAccelPreference, targetCodec: 'h264' | 'hevc' | 'av1'): string | null {
    if (preference === 'none') return null
    const candidates = HW_ENCODERS.filter(
      (e) =>
        this.info.hwEncoders.includes(e.name) &&
        e.name.startsWith(targetCodec) &&
        (preference === 'auto' || e.family === preference)
    )
    return candidates[0]?.name ?? null
  }

  async probe(target: string, extraArgs: string[] = []): Promise<FfprobeResult> {
    const { ffprobe } = this.require()
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      ...extraArgs,
      target
    ]
    const result = await runChecked(ffprobe, args, { idleTimeoutMs: 120_000 })
    try {
      return JSON.parse(result.stdout) as FfprobeResult
    } catch (err) {
      throw Errors.ffmpegFailed(`ffprobe returned unparseable JSON: ${String(err)}`)
    }
  }

  /**
   * List keyframe timestamps in a local file. Used to decide whether a
   * stream-copy cut can hit the requested start accurately.
   */
  async keyframes(file: string, fromSeconds = 0, windowSeconds = 30): Promise<KeyframeInfo> {
    const { ffprobe } = this.require()
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-select_streams',
      'v:0',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
      '-read_intervals',
      `${fromSeconds.toFixed(3)}%+${windowSeconds.toFixed(3)}`,
      '-print_format',
      'json',
      file
    ]
    const result = await runChecked(ffprobe, args, { idleTimeoutMs: 120_000 })
    let parsed: { frames?: Array<{ pts_time?: string }> }
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return { times: [] }
    }
    const times = (parsed.frames ?? [])
      .map((f) => Number(f.pts_time))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    return { times }
  }

  /**
   * Run ffmpeg with machine-readable progress on stdout.
   * `onProgress` receives out_time in seconds and total bytes written so far.
   */
  async exec(
    args: string[],
    opts: {
      signal?: AbortSignal
      onProgress?: (p: { outTimeSeconds: number; totalSizeBytes: number; speed: number }) => void
      label: string
    }
  ): Promise<void> {
    const { ffmpeg } = this.require()
    const fullArgs = ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args]

    this.log.debug('ffmpeg', `run ${opts.label}`, { args: fullArgs })

    let stdoutBuffer = ''
    const runOpts: RunOptions = {
      signal: opts.signal,
      idleTimeoutMs: 5 * 60_000,
      onStdout: (chunk) => {
        if (!opts.onProgress) return
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        let outTime: number | null = null
        let totalSize: number | null = null
        let speed = 0
        for (const line of lines) {
          const [key, value] = line.split('=')
          if (key === 'out_time_us' || key === 'out_time_ms') {
            const n = Number(value)
            // ffmpeg's out_time_ms is actually microseconds; both keys are µs.
            if (Number.isFinite(n)) outTime = n / 1_000_000
          } else if (key === 'total_size') {
            const n = Number(value)
            if (Number.isFinite(n)) totalSize = n
          } else if (key === 'speed') {
            const n = Number(String(value).replace('x', ''))
            if (Number.isFinite(n)) speed = n
          }
        }
        if (outTime !== null || totalSize !== null) {
          opts.onProgress({
            outTimeSeconds: outTime ?? 0,
            totalSizeBytes: totalSize ?? 0,
            speed
          })
        }
      }
    }

    const result = await run(ffmpeg, fullArgs, runOpts)
    if (result.aborted) throw Errors.cancelled()
    if (result.code !== 0) {
      this.log.error('ffmpeg', `${opts.label} failed`, {
        code: result.code,
        stderr: result.stderr.slice(-4000),
        args: fullArgs
      })
      throw Errors.ffmpegFailed(result.stderr.slice(-2000) || `exit code ${result.code}`)
    }
  }
}


/**
 * Encode a single frame to /dev/null to prove the encoder really works here.
 * `ffmpeg -encoders` only says the build supports it, not that this machine
 * has the driver or hardware to run it.
 */
async function smokeTestEncoder(ffmpegPath: string, encoder: string): Promise<boolean> {
  try {
    const result = await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:r=25:d=0.2',
        '-c:v',
        encoder,
        '-frames:v',
        '1',
        '-f',
        'null',
        '-'
      ],
      { idleTimeoutMs: 20_000 }
    )
    return result.code === 0
  } catch {
    return false
  }
}
