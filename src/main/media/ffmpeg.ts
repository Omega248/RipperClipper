import { Errors, serializeError } from '../../shared/errors.js'
import type { FfmpegInfo, HwAccelPreference } from '../../shared/types.js'
import { run, runChecked } from '../services/process.js'
import type { ProcessPriority, RunOptions } from '../services/process.js'
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
    start_time?: string
    size?: string
    bit_rate?: string
  }
}

export interface KeyframeInfo {
  /** Sorted PTS (seconds) of keyframes found in the probed window. */
  times: number[]
}

export interface SceneChangeInfo {
  /** Sorted timestamps (seconds) where the picture changed enough to look like a cut. */
  times: number[]
}

export class FfmpegService {
  private info: FfmpegInfo = {
    available: false,
    ffmpegPath: null,
    ffprobePath: null,
    version: null,
    hwEncoders: [],
    cudaOverlay: false,
    error: null
  }

  /** The override paths the current `info` was worked out from. */
  private detectedFor: string | null = null

  constructor(private readonly log: Logger) {}

  current(): FfmpegInfo {
    return this.info
  }

  /**
   * Locate + validate ffmpeg/ffprobe. Never assumes they exist.
   *
   * The answer is remembered against the paths it was worked out from,
   * because working it out is not cheap: two executable searches, two version
   * reads, an encoder listing, and then a real one-frame encode per hardware
   * encoder candidate to prove the machine can actually run it — up to a
   * dozen child processes. That is the right price to pay at startup and
   * after installing a tool. It is the wrong price to pay every time someone
   * changes a setting, which is what used to happen: flipping the theme
   * re-ran the whole thing and the interface waited for it.
   *
   * A failed detection is not remembered, so a tool that appears later is
   * found without anyone having to ask. `force` re-runs regardless — for
   * after an install, or when the person explicitly asks to re-check.
   */
  async detect(
    overrides: {
      ffmpegPath?: string | null
      ffprobePath?: string | null
      bundledDir?: string | null
    },
    opts: { force?: boolean } = {}
  ): Promise<FfmpegInfo> {
    const signature = JSON.stringify([
      overrides.ffmpegPath ?? null,
      overrides.ffprobePath ?? null,
      overrides.bundledDir ?? null
    ])
    if (!opts.force && this.info.available && this.detectedFor === signature) return this.info
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

      // Only worth asking if there is an NVIDIA encoder to end the chain with:
      // a CUDA overlay feeding a software encoder would download every frame
      // anyway, which is the cost this exists to avoid.
      const cudaOverlay = hwEncoders.some((e) => e.includes('nvenc'))
        ? await smokeTestCudaOverlay(ffmpegPath)
        : false

      this.info = {
        available: true,
        ffmpegPath,
        ffprobePath,
        version,
        hwEncoders,
        cudaOverlay,
        error: null
      }
      this.detectedFor = signature
      this.log.info('ffmpeg', 'FFmpeg detected', {
        ffmpegPath,
        ffprobePath,
        version,
        hwEncoders,
        cudaOverlay
      })
    } catch (err) {
      this.info = {
        available: false,
        ffmpegPath: null,
        ffprobePath: null,
        version: null,
        hwEncoders: [],
        cudaOverlay: false,
        error: serializeError(err instanceof Error ? err : Errors.ffmpegMissing())
      }
      this.detectedFor = null
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
    /*
     * Read PACKETS carrying the keyframe flag, not decoded frames.
     *
     * The obvious spelling — `-skip_frame nokey -show_entries frame=pts_time`
     * — is version-dependent in a way that fails silently: ffprobe 5 and
     * later report a frame's timestamp as `pts_time`, while ffprobe 4 and
     * earlier call it `pkt_pts_time` and emit `{}` for every frame when asked
     * for the newer name. The caller then sees no keyframes at all, decides a
     * smart cut is impossible, and quietly re-encodes whole clips — slow, and
     * with nothing anywhere saying why. The app bundles its own ffmpeg, but
     * the FFmpeg path is a setting, so an older binary is a real possibility.
     *
     * A packet's `pts_time` and `flags` have been spelled the same way for as
     * long as this matters, and a keyframe packet is exactly what the splice
     * needs to know about. It is also cheaper: no decoding at all.
     */
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,flags',
      '-read_intervals',
      `${fromSeconds.toFixed(3)}%+${windowSeconds.toFixed(3)}`,
      '-print_format',
      'json',
      file
    ]
    const result = await runChecked(ffprobe, args, { idleTimeoutMs: 120_000 })
    let parsed: { packets?: Array<{ pts_time?: string; flags?: string }> }
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      return { times: [] }
    }
    const times = (parsed.packets ?? [])
      .filter((p) => (p.flags ?? '').includes('K'))
      .map((p) => Number(p.pts_time))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    return { times }
  }

  /**
   * Timestamps where the picture actually changes — a cut to a different
   * camera, a scene transition — rather than just gameplay motion. FFmpeg's
   * own `scene` metric (0..1, how different this frame is from the last)
   * does the comparison; anything over `threshold` is reported. Used to
   * suggest clip in/out points, not to decide anything on its own.
   *
   * There is no structured-output form of this (unlike `keyframes`, which
   * ffprobe can report as JSON) — `select`+`showinfo` only ever announces a
   * match through its own log line, so this is the one place in the service
   * that reads `stderr` text instead of parsing JSON, and needs its own
   * `-loglevel` (the shared `exec()` helper hides info-level logs, which is
   * exactly where `showinfo` writes).
   */
  async sceneChanges(
    file: string,
    fromSeconds = 0,
    windowSeconds = 30,
    threshold = 0.35
  ): Promise<SceneChangeInfo> {
    const { ffmpeg } = this.require()
    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'info',
      '-ss',
      fromSeconds.toFixed(3),
      '-i',
      file,
      '-t',
      windowSeconds.toFixed(3),
      '-vf',
      `select='gt(scene,${threshold})',showinfo`,
      '-an',
      '-f',
      'null',
      '-'
    ]
    // A full decode of the range to measure how different each frame is from
    // the last — the most expensive thing in here that nobody explicitly
    // asked for, so it runs where it cannot be felt.
    const result = await runChecked(ffmpeg, args, { idleTimeoutMs: 120_000, priority: 'idle' })
    const times: number[] = []
    for (const match of result.stderr.matchAll(/pts_time:\s*([\d.]+)/g)) {
      const t = fromSeconds + Number(match[1])
      if (Number.isFinite(t)) times.push(t)
    }
    times.sort((a, b) => a - b)
    return { times }
  }

  /**
   * What ffmpeg prints for an informational query — `-hwaccels`, `-filters`.
   *
   * These describe the *build*, never the machine, and the difference is the
   * whole reason `producesFrame` exists below.
   */
  async textOutput(args: string[]): Promise<string> {
    const { ffmpeg } = this.require()
    const result = await run(ffmpeg, ['-hide_banner', ...args], { maxBufferBytes: 1 << 24 })
    return result.stdout
  }

  /**
   * Does this argument list actually produce picture on this machine?
   *
   * Bytes on stdout, not an exit code: a hardware pipeline that cannot create
   * its device fails in ways that still exit zero, and the symptom is a black
   * tile with nothing anywhere saying why. Asking "did any frame come out"
   * is the only question whose answer cannot be wrong.
   */
  async producesFrame(
    args: string[],
    opts: { signal?: AbortSignal; label: string; timeoutMs?: number } = { label: 'probe' }
  ): Promise<boolean> {
    const { ffmpeg } = this.require()
    let produced = 0
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
    try {
      await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        signal: controller.signal,
        priority: 'background',
        onStdout: (chunk) => (produced += chunk.length)
      })
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    this.log.debug('ffmpeg', `${opts.label}: ${produced > 0 ? 'produced frames' : 'produced nothing'}`)
    return produced > 0
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
      /**
       * How much of the machine this run may take. Every caller states it,
       * because "how urgent is this" is knowledge the call site has and this
       * service does not: an export is work someone is waiting on, a
       * filmstrip is not. Defaults to `background` — of the things that run
       * through here, nothing should outrank the foreground window.
       */
      priority?: ProcessPriority
    }
  ): Promise<void> {
    const { ffmpeg } = this.require()
    const fullArgs = ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args]

    this.log.debug('ffmpeg', `run ${opts.label}`, { args: fullArgs })

    let stdoutBuffer = ''
    const runOpts: RunOptions = {
      signal: opts.signal,
      priority: opts.priority ?? 'background',
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
/**
 * Can this machine composite on the GPU?
 *
 * The whole chain is exercised, not just the filter's presence: a synthetic
 * frame is uploaded to CUDA, a second one is overlaid onto it there, and the
 * result is encoded with NVENC. Anything short of that — the filter listed but
 * not built with nvcc, a driver too old for the surface format, an encoder
 * session the machine will not give — shows up here as a non-zero exit rather
 * than as a failed export twenty minutes into someone's afternoon.
 */
async function smokeTestCudaOverlay(ffmpegPath: string): Promise<boolean> {
  try {
    const result = await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-init_hw_device',
        'cuda=cu:0',
        '-filter_hw_device',
        'cu',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:r=25:d=0.2',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:s=64x64:r=25:d=0.2',
        '-filter_complex',
        '[0:v]format=nv12,hwupload[bg];[1:v]format=yuva420p,hwupload[fg];[bg][fg]overlay_cuda=x=8:y=8[v]',
        '-map',
        '[v]',
        '-c:v',
        'h264_nvenc',
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
