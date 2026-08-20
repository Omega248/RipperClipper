import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Errors } from '../../shared/errors.js'
import { roundMs, toFfmpegTime } from '../../shared/time.js'
import type {
  CutMode,
  ExportSettings,
  JobStage,
  StreamInfo,
  TimelineTransform,
  VerificationReport,
  VodSource
} from '../../shared/types.js'
import { buildWatermarkFilter } from './watermarkFilter.js'
import { buildTransformFilter, isIdentityTransform } from './transformFilter.js'
import type { ResolvedWatermark } from '../../shared/watermark.js'
import { buildAudioFilter } from '../../shared/audioEdits.js'
import type { AudioEdit } from '../../shared/audioEdits.js'
import type { Logger } from '../services/logger.js'
import type { FfmpegService } from './ffmpeg.js'
import type { RangeFetcher } from './rangeFetcher.js'
import type { ContainerPlan, SelectedStreams } from './formats.js'
import { planContainer } from './formats.js'

export interface ExportProgressEvent {
  stage: JobStage
  fraction: number
  message: string
  bytes?: number
}

export interface ExportClipRequest {
  clipId: string
  clipName: string
  startSeconds: number
  endSeconds: number
  source: VodSource
  streams: SelectedStreams
  /**
   * Sound from a different POV. Its range is in *that* POV's local time — the
   * two POVs share the event, not a clock — so it is fetched and offset
   * independently of the picture.
   */
  audioOverride?: {
    stream: StreamInfo
    startSeconds: number
    endSeconds: number
  }
  /**
   * The watermark belonging to the POV supplying the picture. Drawing one means
   * the video is being changed, so a stream copy stops being possible — the
   * cut decision below accounts for that rather than silently producing a file
   * without the logo.
   */
  watermark?: ResolvedWatermark
  /**
   * Position/scale/rotation for this clip's picture. Like the watermark,
   * applying anything other than the identity transform means the video is
   * being redrawn, not just cut — a stream copy stops being possible.
   */
  transform?: TimelineTransform
  /** 0..1. Same re-render implication as `transform`. */
  opacity?: number
  /**
   * Hand-drawn mute/bleep/duck ranges for this clip's chosen sound POV, in the
   * clip's own timeline. Like the watermark, applying one means the audio can
   * no longer be stream-copied.
   */
  audioEdits?: AudioEdit[]
  /** Flat volume multiplier for the whole clip's sound. 1 = unchanged. */
  audioGain?: number
  /** Bleep tone, so what was previewed is what gets written. */
  bleep?: { hz: number; amplitude: number }
  settings: ExportSettings
  /** Absolute path of the file to create (extension may be corrected). */
  outputPath: string
  workDir: string
  signal?: AbortSignal
  onProgress: (e: ExportProgressEvent) => void
}

export interface ExportClipResult {
  outputPath: string
  verification: VerificationReport
  /** Difference between the requested start and the actual first frame. */
  startDriftSeconds: number
  reEncoded: boolean
  notes: string[]
  bytesDownloaded: number
  cachedSegments: number
  totalSegments: number
}

export class Exporter {
  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher
  ) {}

  async exportClip(req: ExportClipRequest): Promise<ExportClipResult> {
    const notes: string[] = [...req.streams.notes]
    const duration = roundMs(req.endSeconds - req.startSeconds)
    if (duration <= 0) throw Errors.invalidRange('End must be later than Start.')

    const work = join(req.workDir, safeWorkName(req.clipId))
    await mkdir(work, { recursive: true })

    try {
      // ---------------------------------------------------- fetch video ----
      const videoStream = req.streams.video
      const audioStream = req.audioOverride?.stream ?? req.streams.audio
      const audioStart = req.audioOverride?.startSeconds ?? req.startSeconds
      const audioEnd = req.audioOverride?.endSeconds ?? req.endSeconds
      if (!videoStream && !audioStream) throw Errors.qualityUnavailable('any stream')

      let bytesDownloaded = 0
      let cachedSegments = 0
      let totalSegments = 0

      let videoWindow: Awaited<ReturnType<RangeFetcher['fetchWindow']>> | null = null
      if (videoStream) {
        req.onProgress({ stage: 'downloading-video', fraction: 0, message: 'Downloading video…' })
        videoWindow = await this.fetcher.fetchWindow({
          stream: videoStream,
          startSeconds: req.startSeconds,
          endSeconds: req.endSeconds,
          destination: join(work, `video.${windowExtension(videoStream.container)}`),
          signal: req.signal,
          onProgress: (p) =>
            req.onProgress({
              stage: 'downloading-video',
              fraction: p.fraction,
              message: 'Downloading video…',
              bytes: p.receivedBytes
            })
        })
        bytesDownloaded += videoWindow.bytes
        cachedSegments += videoWindow.cachedSegments
        totalSegments += videoWindow.totalSegments
      }

      // ---------------------------------------------------- fetch audio ----
      let audioWindow: Awaited<ReturnType<RangeFetcher['fetchWindow']>> | null = null
      if (audioStream) {
        req.onProgress({ stage: 'downloading-audio', fraction: 0, message: 'Downloading audio…' })
        audioWindow = await this.fetcher.fetchWindow({
          stream: audioStream,
          startSeconds: audioStart,
          endSeconds: audioEnd,
          destination: join(work, `audio.${windowExtension(audioStream.container)}`),
          signal: req.signal,
          onProgress: (p) =>
            req.onProgress({
              stage: 'downloading-audio',
              fraction: p.fraction,
              message: 'Downloading audio…',
              bytes: p.receivedBytes
            })
        })
        bytesDownloaded += audioWindow.bytes
        cachedSegments += audioWindow.cachedSegments
        totalSegments += audioWindow.totalSegments
      }

      const primary = videoWindow ?? audioWindow
      if (!primary) throw Errors.downloadFailed('no media window was produced')

      // --------------------------------------------- inspect real codecs ----
      const probe = await this.ffmpeg.probe(primary.file)
      const realVideo = probe.streams.find((s) => s.codec_type === 'video')
      const realAudio = audioWindow
        ? (await this.ffmpeg.probe(audioWindow.file)).streams.find((s) => s.codec_type === 'audio')
        : probe.streams.find((s) => s.codec_type === 'audio')

      const plan = this.replanContainer(req, realVideo?.codec_name, realAudio?.codec_name)
      notes.push(...plan.notes)

      const outputPath = correctExtension(req.outputPath, plan.container)

      // --------------------------------------------------- decide the cut ----
      const relStart = roundMs(req.startSeconds - primary.windowStartSeconds)
      // Drawing on the picture means decoding and re-encoding it. Asking for a
      // stream copy as well is a contradiction, so the watermark wins and the
      // note explains it in the editor's terms rather than FFmpeg's. A hand-drawn
      // audio edit is the same contradiction on the sound side.
      const watermarking = Boolean(req.watermark && videoStream)
      const transforming = Boolean(
        videoStream && (!isIdentityTransform(req.transform) || (req.opacity !== undefined && req.opacity < 1))
      )
      // `realAudio`, not `audioStream`: a muxed source has no separate audio
      // stream object at all, and its sound is still perfectly editable — it
      // just lives inside the same file as the picture.
      const editingAudio = Boolean(
        realAudio && ((req.audioEdits && req.audioEdits.length > 0) || (req.audioGain && req.audioGain !== 1))
      )
      const decision = await this.decideCut(
        primary.file,
        relStart,
        watermarking || transforming || editingAudio ? 'precise' : req.settings.cutMode,
        req.settings.keyframeToleranceSeconds
      )
      if (watermarking) {
        notes.push('The video was processed so the watermark could be drawn onto it.')
      }
      if (transforming) {
        notes.push('The video was re-rendered to apply its position, scale, rotation or opacity.')
      }
      if (req.audioEdits && req.audioEdits.length > 0) {
        notes.push(
          `The audio was processed to apply ${req.audioEdits.length} edit${req.audioEdits.length === 1 ? '' : 's'}.`
        )
      }
      if (req.audioGain !== undefined && req.audioGain !== 1) {
        notes.push(`The audio volume was set to ${Math.round(req.audioGain * 100)}%.`)
      }

      if (decision.mode === 'copy' && decision.driftSeconds > 0.001) {
        notes.push(
          `Stream copy starts at the nearest keyframe, ${decision.driftSeconds.toFixed(3)}s before the requested start.`
        )
      }
      if (decision.mode === 'precise') {
        notes.push(
          `Re-encoded for a frame-accurate start: the nearest earlier keyframe was ${decision.driftSeconds.toFixed(3)}s away, beyond the ${req.settings.keyframeToleranceSeconds}s tolerance.`
        )
      }

      // ------------------------------------------------------ cut and mux ----
      req.onProgress({
        stage: decision.mode === 'precise' ? 'cutting' : 'muxing',
        fraction: 0,
        message: decision.mode === 'precise' ? 'Cutting (frame accurate)…' : 'Muxing…'
      })

      const cutArgsFor = (forceSoftware: boolean): { args: string[]; videoEncoding: string } =>
        this.buildCutArgs({
          videoWindow,
          audioWindow,
          muxed: (req.streams.muxed && !req.audioOverride) || (!audioWindow && Boolean(realAudio)),
          startSeconds: req.startSeconds,
          endSeconds: req.endSeconds,
          audioStartSeconds: audioStart,
          decision,
          plan,
          settings: req.settings,
          sourceVideoCodec: realVideo?.codec_name,
          outputPath,
          forceSoftware,
          watermark: watermarking ? req.watermark : undefined,
          transform: transforming ? req.transform : undefined,
          opacity: transforming ? req.opacity : undefined,
          // The real frame size, so the normalised transform can be resolved
          // against the picture that is actually being written.
          frameWidth: realVideo?.width,
          frameHeight: realVideo?.height,
          audioEdits: editingAudio ? req.audioEdits : undefined,
          audioGain: editingAudio ? req.audioGain : undefined,
          bleepHz: req.bleep?.hz,
          bleepAmplitude: req.bleep?.amplitude
        })

      const runCut = async (forceSoftware: boolean): Promise<string> => {
        const { args, videoEncoding } = cutArgsFor(forceSoftware)
        await this.ffmpeg.exec(args, {
          signal: req.signal,
          label: `cut ${req.clipName}${forceSoftware ? ' (software)' : ''}`,
          onProgress: (p) =>
            req.onProgress({
              stage: decision.mode === 'precise' ? 'cutting' : 'muxing',
              fraction: Math.min(1, p.outTimeSeconds / Math.max(0.001, duration)),
              message:
                decision.mode === 'precise'
                  ? `Cutting (frame accurate)… ${p.speed > 0 ? `${p.speed.toFixed(1)}x` : ''}`.trim()
                  : 'Muxing…',
              bytes: p.totalSizeBytes
            })
        })
        return videoEncoding
      }

      const sourceFamily = codecFamily(realVideo?.codec_name)
      const usedHardware =
        decision.mode === 'precise' &&
        this.ffmpeg.pickHwEncoder(
          req.settings.hwAccel,
          sourceFamily === 'av1'
            ? this.ffmpeg.pickHwEncoder(req.settings.hwAccel, 'av1') !== null
              ? 'av1'
              : 'hevc'
            : sourceFamily
        ) !== null

      let videoEncodingUsed: string
      try {
        videoEncodingUsed = await runCut(false)
      } catch (err) {
        await rm(outputPath, { force: true }).catch(() => undefined)
        if (!usedHardware || req.signal?.aborted) throw err
        // A GPU encoder can fail at run time (driver, session limit, busy GPU).
        // Fall back to software rather than losing the clip.
        this.log.warn('export', 'Hardware encode failed; retrying in software', {
          clip: req.clipName,
          error: err
        })
        notes.push('Hardware encoding was unavailable at run time, so the clip was encoded in software.')
        try {
          videoEncodingUsed = await runCut(true)
        } catch (softwareErr) {
          await rm(outputPath, { force: true }).catch(() => undefined)
          throw softwareErr
        }
      }
      // Always stated plainly, so it's never a guess whether a given export
      // actually used the GPU — including the common case of no re-encode
      // happening at all.
      notes.push(`Video: ${videoEncodingUsed}.`)

      // ---------------------------------------------------------- verify ----
      req.onProgress({ stage: 'verifying', fraction: 0.5, message: 'Verifying output…' })
      const expectedDuration =
        decision.mode === 'copy' ? duration + decision.driftSeconds : duration
      const verification = await this.verify(outputPath, expectedDuration, Boolean(realAudio))

      if (!verification.ok) {
        this.log.warn('export', 'Verification problems', {
          clip: req.clipName,
          problems: verification.problems
        })
      }

      return {
        outputPath,
        verification,
        startDriftSeconds: decision.mode === 'copy' ? decision.driftSeconds : 0,
        reEncoded: decision.mode === 'precise',
        notes,
        bytesDownloaded,
        cachedSegments,
        totalSegments
      }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Re-check container compatibility against the codecs actually downloaded. */
  private replanContainer(
    req: ExportClipRequest,
    realVideoCodec: string | undefined,
    realAudioCodec: string | undefined
  ): ContainerPlan {
    const streams: SelectedStreams = {
      ...req.streams,
      video: req.streams.video
        ? { ...req.streams.video, codec: realVideoCodec ?? req.streams.video.codec }
        : null,
      audio: req.streams.audio
        ? { ...req.streams.audio, codec: realAudioCodec ?? req.streams.audio.codec }
        : realAudioCodec && req.streams.muxed
          ? {
              ...(req.streams.video ?? ({} as never)),
              id: 'muxed-audio',
              codec: realAudioCodec,
              hasVideo: false,
              hasAudio: true
            }
          : null
    }
    return planContainer(streams, req.settings.container, 'switch-to-mkv')
  }

  /** Work out whether a stream copy can hit the requested start closely enough. */
  private async decideCut(
    windowFile: string,
    relStartSeconds: number,
    mode: CutMode,
    toleranceSeconds: number
  ): Promise<{ mode: 'copy' | 'precise'; keyframeSeconds: number; driftSeconds: number }> {
    // ffprobe's -read_intervals works in the file's own (absolute) timestamps,
    // so offset the probe window by the file start time and convert back.
    const startTime = await this.fileStartTime(windowFile)
    const relProbeFrom = Math.max(0, relStartSeconds - 15)
    const { times } = await this.ffmpeg.keyframes(windowFile, startTime + relProbeFrom, 20)
    const rel = times.map((t) => roundMs(t - startTime)).filter((t) => Number.isFinite(t))

    const before = rel.filter((t) => t <= relStartSeconds + 0.001)
    const keyframe = before.length > 0 ? before[before.length - 1] : 0
    const drift = roundMs(Math.max(0, relStartSeconds - keyframe))

    if (mode === 'copy') return { mode: 'copy', keyframeSeconds: keyframe, driftSeconds: drift }
    if (mode === 'precise') return { mode: 'precise', keyframeSeconds: keyframe, driftSeconds: drift }
    return drift <= toleranceSeconds
      ? { mode: 'copy', keyframeSeconds: keyframe, driftSeconds: drift }
      : { mode: 'precise', keyframeSeconds: keyframe, driftSeconds: drift }
  }

  private async fileStartTime(file: string): Promise<number> {
    try {
      const probe = await this.ffmpeg.probe(file, ['-show_entries', 'format=start_time'])
      const raw = (probe.format as unknown as { start_time?: string }).start_time
      const value = Number(raw)
      return Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }

  private buildCutArgs(opts: {
    videoWindow: { file: string; windowStartSeconds: number } | null
    audioWindow: { file: string; windowStartSeconds: number } | null
    muxed: boolean
    startSeconds: number
    endSeconds: number
    /** Where the audio range starts in the audio POV's own timeline. */
    audioStartSeconds?: number
    decision: { mode: 'copy' | 'precise'; keyframeSeconds: number; driftSeconds: number }
    plan: ContainerPlan
    settings: ExportSettings
    sourceVideoCodec: string | undefined
    outputPath: string
    forceSoftware?: boolean
    watermark?: ResolvedWatermark
    transform?: TimelineTransform
    opacity?: number
    frameWidth?: number
    frameHeight?: number
    audioEdits?: AudioEdit[]
    audioGain?: number
    bleepHz?: number
    bleepAmplitude?: number
  }): { args: string[]; videoEncoding: string } {
    const args: string[] = ['-y', '-progress', 'pipe:1', '-nostats']
    const duration = roundMs(opts.endSeconds - opts.startSeconds)

    // Offsets of the requested start inside each window file.
    const relVideo = opts.videoWindow
      ? roundMs(opts.startSeconds - opts.videoWindow.windowStartSeconds)
      : 0
    const relAudio = opts.audioWindow
      ? roundMs((opts.audioStartSeconds ?? opts.startSeconds) - opts.audioWindow.windowStartSeconds)
      : 0

    /**
     * Precise mode uses two-stage seeking: a fast input seek to a short
     * pre-roll before the cut, then an output-side seek that trims *every*
     * stream at exactly the requested instant. Seeking only on the input would
     * start the copied audio at the preceding video keyframe instead, leaving
     * the clip with a silent-video head and a longer-than-requested duration.
     */
    const preroll =
      opts.decision.mode === 'precise'
        ? roundMs(
            Math.min(
              5,
              opts.videoWindow ? relVideo : Infinity,
              opts.audioWindow ? relAudio : Infinity
            )
          )
        : 0

    const effectiveDuration =
      opts.decision.mode === 'copy' ? roundMs(duration + opts.decision.driftSeconds) : duration

    let inputIndex = 0
    let videoInput: number | null = null
    let audioInput: number | null = null

    if (opts.videoWindow) {
      const seek =
        opts.decision.mode === 'copy'
          ? opts.decision.keyframeSeconds
          : Math.max(0, roundMs(relVideo - preroll))
      // Precise mode always decodes this input (to trim frame-accurately, and
      // to draw a watermark). `-hwaccel auto` puts that decode on the GPU
      // alongside the hardware encoder already picked for the output side,
      // rather than leaving decode on the CPU while only the encode side was
      // ever accelerated. Software fallback (a hardware *encoder* failure)
      // takes hardware out of the picture entirely rather than leaving decode
      // on it — the point of that retry is to rule hardware out, not half of it.
      if (opts.decision.mode === 'precise' && !opts.forceSoftware && opts.settings.hwAccel !== 'none') {
        args.push('-hwaccel', 'auto')
      }
      args.push('-ss', toFfmpegTime(seek), '-i', opts.videoWindow.file)
      videoInput = inputIndex++
    }
    if (opts.audioWindow) {
      const seek =
        opts.decision.mode === 'copy'
          ? roundMs(relAudio - opts.decision.driftSeconds)
          : roundMs(relAudio - preroll)
      args.push('-ss', toFfmpegTime(Math.max(0, seek)), '-i', opts.audioWindow.file)
      audioInput = inputIndex++
    }

    // The watermark is an extra input, looped so a still image lasts the whole
    // clip. Its filter chain is built below.
    let watermarkInput: number | null = null
    if (opts.watermark) {
      args.push('-loop', '1', '-i', opts.watermark.imagePath)
      watermarkInput = inputIndex++
    }

    if (opts.decision.mode === 'precise' && preroll > 0) {
      args.push('-ss', toFfmpegTime(preroll))
    }
    args.push('-t', toFfmpegTime(effectiveDuration))

    // Transform runs first — the watermark then draws onto the *repositioned*
    // picture, so the logo stays anchored to the frame rather than moving
    // with a clip that's been scaled or shifted.
    const transformPlan =
      videoInput !== null && opts.frameWidth && opts.frameHeight
        ? buildTransformFilter(opts.transform, opts.opacity, {
            frameWidth: opts.frameWidth,
            frameHeight: opts.frameHeight,
            videoLabel: `${videoInput}:v:0`,
            outputLabel: 'xf'
          })
        : null

    // The watermark's overlay runs in its own -filter_complex, chained onto
    // the transform's output when there is one.
    const videoPlan =
      opts.watermark && videoInput !== null && watermarkInput !== null && opts.frameWidth && opts.frameHeight
        ? buildWatermarkFilter(opts.watermark, {
            frameWidth: opts.frameWidth,
            frameHeight: opts.frameHeight,
            videoLabel: transformPlan ? transformPlan.outputLabel : `${videoInput}:v:0`,
            imageLabel: `${watermarkInput}:v`,
            outputLabel: 'wm'
          })
        : null

    // Audio edits run against whichever input actually carries the sound —
    // its own window file if one was fetched, otherwise the muxed video's own
    // audio stream.
    const audioSourceLabel =
      audioInput !== null
        ? `${audioInput}:a:0`
        : opts.muxed && videoInput !== null
          ? `${videoInput}:a:0`
          : null
    /*
     * Every edit's start/end is clip-relative (0 is the start of the
     * *exported* clip). But precise mode's `-ss` after `-t` is an OUTPUT
     * option — it trims `preroll` seconds off the front of the already-
     * filtered stream, which runs *after* the filter graph, not before it.
     * `asetpts=PTS-STARTPTS` inside the graph (see buildAudioFilter) zeroes
     * time at the *input* seek, which lands `preroll` seconds earlier than
     * the true clip start. Shifting every edit forward by `preroll` — and
     * widening the window buildAudioFilter is allowed to touch to match —
     * is what lines the two clocks back up. Measured without this: the
     * whole edit fell inside the trimmed-off preroll and muted nothing.
     */
    const hasAudioWork =
      audioSourceLabel &&
      (((opts.audioEdits?.length ?? 0) > 0) || (opts.audioGain !== undefined && opts.audioGain !== 1))
    const audioPlan = hasAudioWork
      ? buildAudioFilter(
          (opts.audioEdits ?? []).map((e) => ({
            ...e,
            startSeconds: e.startSeconds + preroll,
            endSeconds: e.endSeconds + preroll
          })),
          {
            inputLabel: audioSourceLabel!,
            durationSeconds: preroll + effectiveDuration,
            bleepHz: opts.bleepHz,
            bleepAmplitude: opts.bleepAmplitude,
            gain: opts.audioGain
          }
        )
      : null

    const graphs = [transformPlan?.filterComplex, videoPlan?.filterComplex, audioPlan?.filterComplex].filter(
      Boolean
    )
    if (graphs.length > 0) args.push('-filter_complex', graphs.join(';'))

    const finalVideoLabel = videoPlan?.outputLabel ?? transformPlan?.outputLabel ?? null
    if (finalVideoLabel) args.push('-map', `[${finalVideoLabel}]`)
    else if (videoInput !== null) args.push('-map', `${videoInput}:v:0`)

    if (audioPlan?.filterComplex) args.push('-map', `[${audioPlan.outputLabel}]`)
    else if (audioInput !== null) args.push('-map', `${audioInput}:a:0?`)
    else if (opts.muxed && videoInput !== null) args.push('-map', `${videoInput}:a:0?`)

    // Video codec
    let videoEncoding = 'no video'
    if (videoInput !== null) {
      if (opts.decision.mode === 'copy' && !videoPlan && !transformPlan) {
        args.push('-c:v', 'copy')
        videoEncoding = 'stream copy (no re-encode)'
      } else {
        const encoded = this.videoEncoderArgs(
          opts.forceSoftware ? { ...opts.settings, hwAccel: 'none' } : opts.settings,
          opts.sourceVideoCodec
        )
        args.push(...encoded.args)
        videoEncoding = encoded.description
      }
    }

    // Audio codec — never re-encode unless the container forces it, or an
    // edit was applied and there is no longer a copy of the original to copy.
    if (opts.plan.copyAudio && !audioPlan?.filterComplex) args.push('-c:a', 'copy')
    else args.push('-c:a', opts.plan.audioEncoder ?? 'aac', '-b:a', '320k')

    args.push('-avoid_negative_ts', 'make_zero')
    if (opts.plan.container === 'mp4') args.push('-movflags', '+faststart')
    args.push('-map_metadata', '-1', '-map_chapters', '-1')
    args.push(opts.outputPath)
    return { args, videoEncoding }
  }

  /**
   * Encoder selection for the accurate path. Hardware is preferred when
   * available, but only ever reached when re-encoding is genuinely required.
   *
   * The target family normally mirrors the source's own (AV1/VP9 sources get
   * a more efficient re-encode, everything else stays H.264) — except AV1
   * only stays AV1 when there's an AV1-capable *hardware* encoder to make it
   * cheap. Software AV1 (libsvtav1) is dramatically slower than libx264 or
   * libx265, so a machine without recent-enough hardware still gets the
   * proven HEVC software path rather than a much slower export for a codec
   * choice nobody asked for.
   */
  private videoEncoderArgs(
    settings: ExportSettings,
    sourceCodec: string | undefined
  ): { args: string[]; description: string } {
    const sourceFamily = codecFamily(sourceCodec)
    const av1Hw = sourceFamily === 'av1' ? this.ffmpeg.pickHwEncoder(settings.hwAccel, 'av1') : null
    const targetFamily: 'h264' | 'hevc' | 'av1' = av1Hw ? 'av1' : sourceFamily === 'av1' ? 'hevc' : sourceFamily
    const hw = targetFamily === 'av1' ? av1Hw : this.ffmpeg.pickHwEncoder(settings.hwAccel, targetFamily)

    /*
     * No B-frames on this path, on every encoder. A GOP with B-frames needs a
     * decoder reorder buffer, which shows up in the muxed output as the video
     * track's first sample presenting `bf / fps` seconds after the file's
     * nominal start (an mp4 edit-list offset) — three B-frames at 30fps is
     * exactly the 0.1s of drift that broke frame-accurate A/V sync here. A
     * short clip export has nothing to gain from B-frames that is worth that.
     */
    if (hw?.includes('nvenc')) {
      const cq = targetFamily === 'av1' ? '25' : '19'
      return {
        args: ['-c:v', hw, '-preset', 'p5', '-rc', 'vbr', '-cq', cq, '-b:v', '0', '-bf', '0'],
        description: `${hw} (NVIDIA hardware)`
      }
    }
    if (hw?.includes('qsv')) {
      return {
        args: ['-c:v', hw, '-global_quality', '20', '-look_ahead', '1', '-bf', '0'],
        description: `${hw} (Intel hardware)`
      }
    }
    if (hw?.includes('amf')) {
      return {
        args: ['-c:v', hw, '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20', '-bf', '0'],
        description: `${hw} (AMD hardware)`
      }
    }
    if (hw?.includes('videotoolbox')) {
      return { args: ['-c:v', hw, '-q:v', '60', '-bf', '0'], description: `${hw} (Apple hardware)` }
    }
    if (hw?.includes('vaapi')) {
      return { args: ['-c:v', hw, '-qp', '20', '-bf', '0'], description: `${hw} (VA-API hardware)` }
    }
    if (targetFamily === 'av1') {
      // Only reachable if av1Hw was picked and the encode then falls back to
      // software mid-export (see forceSoftware) — kept for that edge case
      // rather than ever being the everyday path.
      return { args: ['-c:v', 'libsvtav1', '-crf', '30', '-preset', '8', '-bf', '0'], description: 'libsvtav1 (software)' }
    }
    return targetFamily === 'hevc'
      ? { args: ['-c:v', 'libx265', '-crf', '20', '-preset', 'medium', '-bf', '0'], description: 'libx265 (software)' }
      : { args: ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-bf', '0'], description: 'libx264 (software)' }
  }

  /** ffprobe-based output verification. */
  async verify(
    path: string,
    expectedDurationSeconds: number,
    expectAudio: boolean
  ): Promise<VerificationReport> {
    const problems: string[] = []
    let sizeBytes = 0
    try {
      const s = await stat(path)
      sizeBytes = s.size
      if (sizeBytes === 0) problems.push('the output file is empty')
    } catch {
      return {
        ok: false,
        path,
        sizeBytes: 0,
        container: 'unknown',
        durationSeconds: 0,
        expectedDurationSeconds,
        durationDeltaSeconds: expectedDurationSeconds,
        video: { present: false },
        audio: { present: false },
        avSkewSeconds: null,
        problems: ['the output file was not created']
      }
    }

    const probe = await this.ffmpeg.probe(path)
    const container = probe.format.format_name ?? 'unknown'
    const durationSeconds = Number(probe.format.duration ?? 0)
    const v = probe.streams.find((s) => s.codec_type === 'video')
    const a = probe.streams.find((s) => s.codec_type === 'audio')

    const videoDuration = v?.duration ? Number(v.duration) : undefined
    const audioDuration = a?.duration ? Number(a.duration) : undefined

    if (!v) problems.push('no video stream is present')
    if (expectAudio && !a) problems.push('the source has audio but the output does not')

    const durationDelta = Math.abs(durationSeconds - expectedDurationSeconds)
    if (durationDelta > Math.max(0.75, expectedDurationSeconds * 0.02)) {
      problems.push(
        `duration is ${durationSeconds.toFixed(2)}s but ${expectedDurationSeconds.toFixed(2)}s was expected`
      )
    }

    let avSkew: number | null = null
    if (videoDuration !== undefined && audioDuration !== undefined) {
      avSkew = Math.abs(videoDuration - audioDuration)
      if (avSkew > 0.5) {
        problems.push(`video and audio lengths differ by ${avSkew.toFixed(2)}s`)
      }
    }

    return {
      ok: problems.length === 0,
      path,
      sizeBytes,
      container,
      durationSeconds,
      expectedDurationSeconds,
      durationDeltaSeconds: roundMs(durationDelta),
      video: {
        present: Boolean(v),
        codec: v?.codec_name,
        width: v?.width,
        height: v?.height,
        fps: parseFrameRate(v?.avg_frame_rate ?? v?.r_frame_rate),
        durationSeconds: videoDuration
      },
      audio: {
        present: Boolean(a),
        codec: a?.codec_name,
        sampleRate: a?.sample_rate ? Number(a.sample_rate) : undefined,
        channels: a?.channels,
        durationSeconds: audioDuration
      },
      avSkewSeconds: avSkew === null ? null : roundMs(avSkew),
      problems
    }
  }

  /**
   * Join already-exported clips into one file, preserving the given order.
   * Stream copy is used when every part shares the same codecs; otherwise the
   * parts are normalised by re-encoding and the caller is told why.
   */
  async combine(opts: {
    parts: string[]
    outputPath: string
    workDir: string
    settings: ExportSettings
    signal?: AbortSignal
    onProgress: (e: ExportProgressEvent) => void
  }): Promise<{ outputPath: string; reEncoded: boolean; notes: string[] }> {
    if (opts.parts.length === 0) throw Errors.invalidRange('No clips were selected to combine.')

    const probes = await Promise.all(opts.parts.map((p) => this.ffmpeg.probe(p)))
    const signatures = probes.map((p) => {
      const v = p.streams.find((s) => s.codec_type === 'video')
      const a = p.streams.find((s) => s.codec_type === 'audio')
      return [v?.codec_name, v?.width, v?.height, a?.codec_name, a?.sample_rate, a?.channels].join('|')
    })
    const uniform = signatures.every((s) => s === signatures[0])

    const listPath = join(opts.workDir, `concat-${Date.now()}.txt`)
    await writeFile(
      listPath,
      opts.parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8'
    )

    const notes: string[] = []
    const args = ['-y', '-progress', 'pipe:1', '-nostats', '-f', 'concat', '-safe', '0', '-i', listPath]

    if (uniform) {
      args.push('-c', 'copy')
      notes.push('Video: stream copy (no re-encode).')
    } else {
      notes.push(
        'The selected clips do not share identical video/audio parameters, so they were re-encoded to a single consistent stream.'
      )
      const encoded = this.videoEncoderArgs(opts.settings, probes[0].streams[0]?.codec_name)
      args.push(...encoded.args)
      notes.push(`Video: ${encoded.description}.`)
      args.push('-c:a', 'aac', '-b:a', '320k')
    }
    if (opts.outputPath.toLowerCase().endsWith('.mp4')) args.push('-movflags', '+faststart')
    args.push(opts.outputPath)

    opts.onProgress({ stage: 'muxing', fraction: 0, message: 'Combining clips…' })
    try {
      await this.ffmpeg.exec(args, {
        signal: opts.signal,
        label: 'combine',
        onProgress: (p) =>
          opts.onProgress({
            stage: 'muxing',
            fraction: 0,
            message: `Combining clips… ${toFfmpegTime(p.outTimeSeconds)}`,
            bytes: p.totalSizeBytes
          })
      })
    } finally {
      await rm(listPath, { force: true }).catch(() => undefined)
    }

    return { outputPath: opts.outputPath, reEncoded: !uniform, notes }
  }
}

/**
 * Which family a re-encode should target. AV1 sources get their own family
 * (see `videoEncoderArgs` for why that only sticks when hardware can do it);
 * other already-modern sources (HEVC, VP9) get re-encoded as HEVC rather
 * than H.264; everything else stays H.264.
 */
function codecFamily(codec: string | undefined): 'h264' | 'hevc' | 'av1' {
  if (codec && /av1|av01/i.test(codec)) return 'av1'
  if (codec && /hevc|h265|vp9/i.test(codec)) return 'hevc'
  return 'h264'
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [num, den] = value.split('/').map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return undefined
  return Math.round((num / den) * 1000) / 1000
}

/** A container extension FFmpeg can actually mux into. */
export function windowExtension(container: string | undefined): string {
  if (!container) return 'mkv'
  const c = container.toLowerCase()
  if (c === 'mp4' || c === 'm4a' || c === 'm4v') return 'mp4'
  if (c === 'ts' || c === 'mpegts') return 'ts'
  if (c === 'webm') return 'webm'
  return 'mkv'
}

function correctExtension(path: string, container: 'mp4' | 'mkv'): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(`.${container}`)) return path
  return path.replace(/\.[^.\\/]+$/, '') + `.${container}`
}

function safeWorkName(clipId: string): string {
  return clipId.replace(/[^A-Za-z0-9_-]/g, '_')
}
