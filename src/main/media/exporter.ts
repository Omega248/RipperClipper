import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { ConcurrencyLimiter } from '../services/limiter.js'
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
import { buildPipFilter } from './pipFilter.js'
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
    /**
     * The live source the sound belongs to, when it is one.
     *
     * A live POV's media is not on any server yet, so it cannot be fetched by
     * URL like the stream above — it has to be asked of the buffer by id, the
     * same way the picture is. Absent for an ordinary VOD, where `stream` is
     * all that is needed.
     */
    liveSourceId?: string
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
   * A second POV composited as an inset over this clip's picture. Its own
   * range is in *that* POV's local time, fetched independently — same
   * reasoning as `audioOverride`. Drawing it is the same re-render
   * implication as `transform`: a stream copy stops being possible.
   */
  pip?: {
    stream: StreamInfo
    startSeconds: number
    endSeconds: number
    transform?: TimelineTransform
  }
  /**
   * Hand-drawn mute/bleep/duck ranges for this clip's chosen sound POV, in the
   * clip's own timeline. Like the watermark, applying one means the audio can
   * no longer be stream-copied.
   */
  audioEdits?: AudioEdit[]
  /** Flat volume multiplier for the whole clip's sound. 1 = unchanged. */
  audioGain?: number
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

/**
 * Outputs longer than this do not get `+faststart`.
 *
 * Faststart moves the mp4 index to the front of the file so it can be played
 * while still downloading, and ffmpeg achieves it by writing the file, then
 * rewriting the whole thing a second time. For a clip that is a rounding
 * error. For a four-hour archive it doubles the bytes written — thirty of
 * them is hundreds of gigabytes of pure rewrite — to buy progressive
 * streaming for a file that is going to be opened from local disk.
 */
const FASTSTART_MAX_SECONDS = 900

/**
 * Smart cut bounds.
 *
 * Re-encoding a whole clip to move its start by a fraction of a second is
 * almost all wasted work: the only frames that genuinely cannot be copied are
 * the ones between the requested start and the next keyframe, because they
 * depend on a keyframe that is being thrown away. Everything from that
 * keyframe on is already exactly what the output should contain.
 *
 * So the accurate path re-encodes that short head, stream-copies the tail and
 * splices the two — which on a typical 2-second GOP means encoding ~1s of a
 * 60s clip instead of all of it.
 *
 * The bounds keep the splice to cases where it actually pays. A clip shorter
 * than MIN is over before the three processes have paid for themselves; a
 * head longer than MAX (a source with very sparse keyframes) is no longer a
 * head, and the plain single-pass encode is simpler and no slower. A tail
 * shorter than MIN_TAIL is not worth a second file.
 */
/** Bounds the ffprobe fan-out when inspecting the parts of a combined export. */
const combineProbeLimiter = new ConcurrencyLimiter(4)

const SPLICE_MIN_CLIP_SECONDS = 3
const SPLICE_MAX_HEAD_SECONDS = 20
const SPLICE_MIN_TAIL_SECONDS = 1

/**
 * Held media for a live source, as the exporter needs it.
 *
 * Deliberately one method rather than the whole live registry: the exporter's
 * only interest in a broadcast is "give me the file covering this stretch of
 * wall clock, or tell me you can't", and nothing about buffers, windows or
 * reconnects belongs in an export.
 */
export interface LiveMediaSource {
  writeRange(
    sourceId: string,
    startEpoch: number,
    endEpoch: number,
    destination: string
  ): Promise<{ file: string; windowStartEpoch: number; windowEndEpoch: number } | null>
}

export class Exporter {
  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher
  ) {}

  private encodeThreads = 0

  private liveMedia: LiveMediaSource | null = null

  /**
   * Where clips from a live source get their media.
   *
   * Set once at startup. Left unset, live clips fail with a plain error
   * rather than silently going to the platform for a range that only exists
   * in this app's memory.
   */
  setLiveMedia(source: LiveMediaSource): void {
    this.liveMedia = source
  }

  /**
   * Threads one re-encode may use, or 0 to leave the decision to ffmpeg.
   *
   * Left to itself ffmpeg sizes its thread pool to the whole machine, which
   * is right for one export and wrong for a queue: thirty of them each
   * claiming every core is thirty times oversubscribed, and the context
   * switching costs more than the parallelism gains. The caller divides the
   * machine by how many exports it intends to run at once.
   */
  setEncodeThreads(value: number): void {
    this.encodeThreads = Math.max(0, Math.round(value))
  }

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
      /*
       * Declared alongside the picture because the live branch below can fill
       * it too: a live clip whose sound comes from another POV reads that
       * POV's held media before the ordinary fetch is even considered.
       */
      let audioWindow: Awaited<ReturnType<RangeFetcher['fetchWindow']>> | null = null

      /*
       * A live clip is cut from what the app is holding, not from the
       * platform: the moment being clipped has not been published yet and
       * there is no range on any server to ask for.
       *
       * The buffer keeps whole segments and reports where they actually
       * start, which is the same contract `fetchWindow` has — so once the
       * file exists everything downstream (the keyframe decision, the smart
       * cut, the verify) treats it exactly like a fetched VOD window. The
       * clock is wall-clock seconds rather than an offset into a recording,
       * and that difference never leaves this block, because every use below
       * is a subtraction between two points on the same clock.
       */
      if (req.source.isLive) {
        if (!this.liveMedia) throw Errors.liveUnsupported(req.source.platform)
        req.onProgress({ stage: 'downloading-video', fraction: 0, message: 'Reading held media…' })
        videoWindow = await this.heldWindow({
          sourceId: req.source.id,
          startEpoch: req.startSeconds,
          endEpoch: req.endSeconds,
          work,
          name: 'live.mkv',
          label: `live window ${req.clipName}`,
          signal: req.signal
        })
        bytesDownloaded += videoWindow.bytes

        /*
         * Sound from another live POV.
         *
         * The audio fetch below is skipped for a live source on the grounds
         * that a live segment is muxed, so its sound arrived with its
         * picture. That is true of the POV supplying the picture and false of
         * any other one — and with `audioWindow` left null, `muxed` resolved
         * to true and the cut mapped the *picture* POV's own audio. So asking
         * for the commentary from another angle silently wrote this angle's
         * instead: no note, no error, and `verify` compares durations rather
         * than content, so the job finished green. It was discoverable only
         * by listening to the file.
         *
         * The buffer holds every watched POV, so the sound is asked of it by
         * id exactly as the picture was.
         */
        if (req.audioOverride?.liveSourceId) {
          req.onProgress({ stage: 'downloading-audio', fraction: 0, message: 'Reading held sound…' })
          audioWindow = await this.heldWindow({
            sourceId: req.audioOverride.liveSourceId,
            startEpoch: audioStart,
            endEpoch: audioEnd,
            work,
            name: 'live-audio.mkv',
            label: `live sound ${req.clipName}`,
            signal: req.signal
          })
          bytesDownloaded += audioWindow.bytes
          req.onProgress({ stage: 'downloading-audio', fraction: 1, message: 'Reading held sound…' })
        }
        req.onProgress({ stage: 'downloading-video', fraction: 1, message: 'Reading held media…' })
      } else if (videoStream) {
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
      if (audioStream && !req.source.isLive) {
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

      // -------------------------------------------------------- fetch pip ----
      let pipWindow: Awaited<ReturnType<RangeFetcher['fetchWindow']>> | null = null
      if (req.pip) {
        req.onProgress({ stage: 'downloading-video', fraction: 0, message: 'Downloading picture-in-picture…' })
        pipWindow = await this.fetcher.fetchWindow({
          stream: req.pip.stream,
          startSeconds: req.pip.startSeconds,
          endSeconds: req.pip.endSeconds,
          destination: join(work, `pip.${windowExtension(req.pip.stream.container)}`),
          signal: req.signal,
          onProgress: (p) =>
            req.onProgress({
              stage: 'downloading-video',
              fraction: p.fraction,
              message: 'Downloading picture-in-picture…',
              bytes: p.receivedBytes
            })
        })
        bytesDownloaded += pipWindow.bytes
        cachedSegments += pipWindow.cachedSegments
        totalSegments += pipWindow.totalSegments
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
      const compositingPip = Boolean(req.pip && videoStream)
      // `realAudio`, not `audioStream`: a muxed source has no separate audio
      // stream object at all, and its sound is still perfectly editable — it
      // just lives inside the same file as the picture.
      const editingAudio = Boolean(
        realAudio && ((req.audioEdits && req.audioEdits.length > 0) || (req.audioGain && req.audioGain !== 1))
      )
      const decision = await this.decideCut(
        primary.file,
        relStart,
        watermarking || transforming || compositingPip || editingAudio ? 'precise' : req.settings.cutMode,
        req.settings.keyframeToleranceSeconds,
        Number(probe.format.start_time)
      )
      if (watermarking) {
        notes.push('The video was processed so the watermark could be drawn onto it.')
      }
      if (transforming) {
        notes.push('The video was re-rendered to apply its position, scale, rotation or opacity.')
      }
      if (compositingPip) {
        notes.push('The video was processed to composite a second POV as an inset.')
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

      // ------------------------------------------------------ cut and mux ----
      /*
       * Smart cut. When the ONLY reason this export cannot be a stream copy
       * is that the requested start sits mid-GOP, the picture does not need
       * re-encoding — only the handful of frames before the next keyframe do.
       * `planSplice` looks for that keyframe; a null means the plain
       * single-pass path below runs exactly as it always has.
       *
       * Anything that redraws the picture (watermark, transform, inset) or
       * rewrites the sound is deliberately excluded: those change every
       * frame, so there is no copyable tail to splice onto.
       */
      const redrawing = watermarking || transforming || compositingPip || editingAudio
      const spliceable =
        decision.mode === 'precise' &&
        !redrawing &&
        req.settings.smartCut !== false &&
        videoWindow !== null &&
        // mpegts is what makes the splice work — it carries a parameter-set
        // change at the join, which mp4 does not. It only carries H.264 and
        // HEVC, so anything else takes the single-pass path.
        codecFamily(realVideo?.codec_name) !== 'av1' &&
        !/vp9|vp09/i.test(realVideo?.codec_name ?? '')
      const splice = spliceable
        ? await this.planSplice(
            videoWindow!.file,
            relStart,
            roundMs(relStart + duration),
            Number(probe.format.start_time)
          )
        : null

      req.onProgress({
        stage: decision.mode === 'precise' ? 'cutting' : 'muxing',
        fraction: 0,
        message: decision.mode === 'precise' ? 'Cutting (frame accurate)…' : 'Muxing…'
      })

      // Long outputs skip the mp4 rewrite; see FASTSTART_MAX_SECONDS.
      const faststart = duration <= FASTSTART_MAX_SECONDS
      if (!faststart && plan.container === 'mp4') {
        notes.push(
          'The file was written without the streaming index at the front, which would have meant rewriting every byte of it a second time.'
        )
      }

      /*
       * Composite on the GPU when every condition for it holds.
       *
       * The watermark has to be the only thing redrawing the picture: a crop,
       * an inset or an audio edit all pull the graph back onto the CPU, and a
       * half-GPU chain copies every frame anyway. NVENC has to be the encoder
       * that ends the chain, or the frames come down at the last step for
       * nothing. And the machine has to have actually run the chain once at
       * startup — `cudaOverlay` is a smoke test, not a capability list.
       */
      const gpuWatermark =
        watermarking &&
        !transforming &&
        !compositingPip &&
        !editingAudio &&
        decision.mode === 'precise' &&
        req.settings.hwAccel !== 'none' &&
        // Only ever true when an NVENC encoder was found *and* the whole
        // decode-overlay-encode chain ran at startup — see smokeTestCudaOverlay.
        this.ffmpeg.current().cudaOverlay

      const cutArgsFor = (
        forceSoftware: boolean,
        cuda = gpuWatermark && !forceSoftware
      ): { args: string[]; videoEncoding: string } =>
        this.buildCutArgs({
          cuda,
          videoWindow,
          audioWindow,
          pipWindow: compositingPip ? pipWindow : null,
          pipStartSeconds: req.pip?.startSeconds,
          pipTransform: req.pip?.transform,
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
          faststart
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

      const runSplice = async (forceSoftware: boolean): Promise<string> =>
        this.runSplice({
          plan: splice!,
          work,
          videoFile: videoWindow!.file,
          relStart,
          durationSeconds: duration,
          audioFile: audioWindow ? audioWindow.file : realAudio ? videoWindow!.file : null,
          audioSeekSeconds: audioWindow
            ? roundMs(audioStart - audioWindow.windowStartSeconds)
            : relStart,
          containerPlan: plan,
          settings: req.settings,
          sourceVideoCodec: realVideo?.codec_name,
          outputPath,
          faststart,
          forceSoftware,
          label: req.clipName,
          signal: req.signal,
          onProgress: req.onProgress
        })

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

      const attempt = splice ? runSplice : runCut

      let videoEncodingUsed: string
      /** Set when the CPU-overlay retry succeeded, so the last rung is skipped. */
      let cpuOverlayFallback: string | null = null
      try {
        videoEncodingUsed = await attempt(false)
      } catch (err) {
        await rm(outputPath, { force: true }).catch(() => undefined)
        if (req.signal?.aborted) throw err
        /*
         * Three rungs, not two.
         *
         * The GPU composite is the fastest and the fussiest — a driver, a
         * surface format, an encoder session. When it fails the answer is
         * almost never "give up on the graphics card": it is to composite on
         * the CPU and still encode on the GPU, which is what the app did
         * before this path existed. Dropping straight to software would turn
         * one unlucky filter into a ten-times-slower export.
         */
        if (gpuWatermark && !splice) {
          this.log.warn('export', 'GPU compositing failed; retrying with the CPU filter graph', {
            clip: req.clipName,
            error: err
          })
          try {
            const { args, videoEncoding } = cutArgsFor(false, false)
            await this.ffmpeg.exec(args, {
              signal: req.signal,
              label: `cut ${req.clipName} (cpu overlay)`,
              onProgress: (p) =>
                req.onProgress({
                  stage: 'cutting',
                  fraction: Math.min(1, p.outTimeSeconds / Math.max(0.001, duration)),
                  message: `Cutting (frame accurate)… ${p.speed > 0 ? `${p.speed.toFixed(1)}x` : ''}`.trim(),
                  bytes: p.totalSizeBytes
                })
            })
            notes.push(
              'The watermark could not be composited on the graphics card this time, so it was drawn on the CPU. The encode still used the GPU.'
            )
            cpuOverlayFallback = videoEncoding
          } catch (cpuErr) {
            await rm(outputPath, { force: true }).catch(() => undefined)
            if (!usedHardware) throw cpuErr
          }
        }
        if (cpuOverlayFallback !== null) {
          videoEncodingUsed = cpuOverlayFallback
        } else if (!usedHardware) {
          throw err
        } else {
          // A GPU encoder can fail at run time (driver, session limit, busy
          // GPU). Fall back to software rather than losing the clip.
          this.log.warn('export', 'Hardware encode failed; retrying in software', {
            clip: req.clipName,
            error: err
          })
          notes.push(
            'Hardware encoding was unavailable at run time, so the clip was encoded in software.'
          )
          try {
            videoEncodingUsed = await attempt(true)
          } catch (softwareErr) {
            await rm(outputPath, { force: true }).catch(() => undefined)
            throw softwareErr
          }
        }
      }
      if (decision.mode === 'precise' && !splice) {
        notes.push(
          `Re-encoded for a frame-accurate start: the nearest earlier keyframe was ${decision.driftSeconds.toFixed(3)}s away, beyond the ${req.settings.keyframeToleranceSeconds}s tolerance.`
        )
        /*
         * Which redraw cost the copy, by name.
         *
         * A watermark rules out both the stream copy and the smart splice —
         * every frame is different, so there is nothing left to copy. That is
         * the correct behaviour and it is also, quietly, the difference
         * between a clip that finishes at download speed and one that takes
         * as long as the encoder needs. Whoever is waiting deserves to know
         * which of their own settings asked for that.
         */
        const redraws = [
          watermarking ? 'the watermark' : null,
          transforming ? 'the crop or zoom' : null,
          compositingPip ? 'the picture-in-picture inset' : null,
          editingAudio ? 'the audio edit' : null
        ].filter((x): x is string => x !== null)
        if (redraws.length > 0) {
          notes.push(
            `A copy was not possible here anyway: ${redraws.join(' and ')} changes every frame, so the whole clip had to be encoded. Removing it lets a clip like this be copied instead.`
          )
        }
      }
      if (splice) {
        notes.push(
          `Smart cut: only the first ${splice.headSeconds.toFixed(2)}s was re-encoded to land the start exactly; the remaining ${(duration - splice.headSeconds).toFixed(2)}s was copied untouched.`
        )
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

  /**
   * A stretch of a live POV's held media, as a file the rest of the export
   * can treat exactly like a fetched VOD window.
   *
   * Rebuilds the timeline on the way, which is the part that matters. The
   * buffer holds whole broadcast segments and writes them end to end, and
   * each of those was muxed independently by the broadcaster's encoder with
   * its own PCR and program tables. Run together in one MPEG-TS file FFmpeg
   * cannot build a coherent index across the joins, and every seek lands
   * about a second late and on the wrong keyframe — measured on a fixture
   * broadcast, asking for one second in returned the frame from three
   * seconds in. Matroska carries an explicit timestamp on every frame and an
   * index of its own, so a stream copy into it — no re-encode, a fraction of
   * a second for a clip-sized window — produces a file whose seeks land
   * exactly.
   *
   * Extracted so the sound can come from a different live POV than the
   * picture: both are the same question asked of the buffer with a different
   * id.
   */
  private async heldWindow(req: {
    sourceId: string
    startEpoch: number
    endEpoch: number
    work: string
    name: string
    label: string
    signal?: AbortSignal
  }): Promise<{
    file: string
    windowStartSeconds: number
    windowEndSeconds: number
    bytes: number
    cachedSegments: number
    totalSegments: number
  }> {
    if (!this.liveMedia) throw Errors.liveUnsupported('live')
    const raw = join(req.work, `${req.name}.held.ts`)
    const held = await this.liveMedia.writeRange(req.sourceId, req.startEpoch, req.endEpoch, raw)
    if (!held) {
      throw Errors.liveRangeGone(
        'Clip it sooner, or wait for the broadcast to be archived and cut it from the VOD.'
      )
    }

    const normalised = join(req.work, req.name)
    await this.ffmpeg.exec(
      ['-y', '-fflags', '+genpts', '-i', held.file, '-map', '0', '-c', 'copy', '-f', 'matroska', normalised],
      { signal: req.signal, label: req.label, priority: 'background' }
    )
    await rm(held.file, { force: true }).catch(() => undefined)

    const bytes = await stat(normalised).then((f) => f.size).catch(() => 0)
    return {
      file: normalised,
      windowStartSeconds: held.windowStartEpoch,
      windowEndSeconds: held.windowEndEpoch,
      bytes,
      // Nothing was transferred: the media was already here.
      cachedSegments: 0,
      totalSegments: 0
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
    toleranceSeconds: number,
    /**
     * The window file's own first timestamp, taken from the probe the caller
     * has already run on this same file. It used to be re-read here with a
     * second ffprobe asking only for `format=start_time` — a whole extra
     * process (~135ms measured) for one field the caller was already
     * holding. That is invisible on a four-hour archive and is not on a
     * short clip, where the transfer itself is now a couple of seconds.
     */
    startTimeSeconds: number
  ): Promise<{ mode: 'copy' | 'precise'; keyframeSeconds: number; driftSeconds: number }> {
    // ffprobe's -read_intervals works in the file's own (absolute) timestamps,
    // so offset the probe window by the file start time and convert back.
    // A container that reports no start time is treated as starting at zero,
    // exactly as the previous ffprobe-based lookup did.
    const startTime = Number.isFinite(startTimeSeconds) ? startTimeSeconds : 0
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

  /**
   * Find the splice point for a smart cut: the first keyframe strictly after
   * the requested start, which is the earliest frame the output can start
   * copying from.
   *
   * Returns null when a splice would not pay for itself, and the caller then
   * re-encodes the whole clip exactly as before. Deciding that here — rather
   * than letting the splice run and be slow — keeps the fast path honest: a
   * source with a keyframe every thirty seconds gains nothing from three
   * ffmpeg processes over one.
   */
  private async planSplice(
    windowFile: string,
    relStartSeconds: number,
    relEndSeconds: number,
    startTimeSeconds: number
  ): Promise<{ headEndSeconds: number; headSeconds: number } | null> {
    const duration = roundMs(relEndSeconds - relStartSeconds)
    if (duration < SPLICE_MIN_CLIP_SECONDS) return null

    const startTime = Number.isFinite(startTimeSeconds) ? startTimeSeconds : 0
    // Only ever look as far as a head is allowed to be — a longer probe would
    // cost more ffprobe time to find an answer that is rejected anyway.
    const lookahead = Math.min(duration, SPLICE_MAX_HEAD_SECONDS) + 1
    const { times } = await this.ffmpeg.keyframes(
      windowFile,
      startTime + relStartSeconds,
      lookahead
    )
    const after = times
      .map((t) => roundMs(t - startTime))
      .filter((t) => Number.isFinite(t) && t > relStartSeconds + 0.001)
      .sort((a, b) => a - b)
    if (after.length === 0) return null

    const headEndSeconds = after[0]
    const headSeconds = roundMs(headEndSeconds - relStartSeconds)
    // A tail too short to be worth its own file, or a head so long it is most
    // of the clip, both mean the single-pass encode is the better shape.
    if (relEndSeconds - headEndSeconds < SPLICE_MIN_TAIL_SECONDS) return null
    if (headSeconds > SPLICE_MAX_HEAD_SECONDS || headSeconds > duration * 0.5) return null
    return { headEndSeconds, headSeconds }
  }

  /**
   * Run a smart cut: encode the head, copy the tail, splice them together and
   * mux the sound alongside.
   *
   * The two halves are written as MPEG-TS. That is the whole reason this
   * works: TS carries its parameter sets inline and re-states them at every
   * keyframe, so a freshly encoded head and an untouched tail — different
   * SPS/PPS, different encoders entirely — concatenate into one playable
   * stream. MP4 states them once in the header and cannot.
   *
   * Sound is never spliced. It is mapped in whole from its own source in the
   * final mux, seeked to the clip's start, which sidesteps the encoder
   * priming and frame-boundary artefacts an audio join would introduce for
   * no gain — AAC is cheap to seek and the join is where the glitches live.
   */
  private async runSplice(opts: {
    plan: { headEndSeconds: number; headSeconds: number }
    work: string
    videoFile: string
    /** Where the requested start sits inside the video window file. */
    relStart: number
    durationSeconds: number
    /** File carrying the sound: its own window, the muxed video, or none. */
    audioFile: string | null
    audioSeekSeconds: number
    containerPlan: ContainerPlan
    settings: ExportSettings
    sourceVideoCodec: string | undefined
    outputPath: string
    faststart: boolean
    forceSoftware: boolean
    label: string
    signal?: AbortSignal
    onProgress: (e: ExportProgressEvent) => void
  }): Promise<string> {
    const headPath = join(opts.work, 'splice-head.ts')
    const tailPath = join(opts.work, 'splice-tail.ts')
    const listPath = join(opts.work, 'splice.txt')
    const { headEndSeconds, headSeconds } = opts.plan
    const tailSeconds = roundMs(opts.durationSeconds - headSeconds)

    // ------------------------------------------------------------ head ----
    /*
     * Input-side `-ss` and `-to`, not the two-stage pre-roll seek the
     * single-pass path uses.
     *
     * An input `-ss` is frame-accurate for a re-encode — ffmpeg starts
     * decoding at the preceding keyframe and throws away everything before
     * the mark — so the pre-roll buys nothing here. It exists on the other
     * path only to trim *copied audio* at the same instant as the picture,
     * and this command has no audio in it at all.
     *
     * It also has to be this way round: an output-side `-ss` is silently
     * ignored on a video-only mapping (measured on ffmpeg 6.1 — the head came
     * out starting at the pre-roll, several seconds early), and an output
     * `-t` is measured against timestamps that still carry the source's own
     * start time, which on MPEG-TS is 1.4s and would cut the head short by
     * exactly that. Bounding both ends on the input side sidesteps both.
     */
    const headArgs: string[] = ['-y', '-progress', 'pipe:1', '-nostats']
    if (!opts.forceSoftware && opts.settings.hwAccel !== 'none') headArgs.push('-hwaccel', 'auto')
    headArgs.push(
      '-ss',
      toFfmpegTime(opts.relStart),
      '-to',
      toFfmpegTime(headEndSeconds),
      '-i',
      opts.videoFile
    )
    headArgs.push('-map', '0:v:0', '-an', '-sn', '-dn')
    const encoded = this.videoEncoderArgs(
      opts.forceSoftware ? { ...opts.settings, hwAccel: 'none' } : opts.settings,
      opts.sourceVideoCodec
    )
    if (this.encodeThreads > 0) headArgs.push('-threads', String(this.encodeThreads))
    headArgs.push(...encoded.args)
    headArgs.push('-f', 'mpegts', headPath)

    await this.ffmpeg.exec(headArgs, {
      signal: opts.signal,
      label: `smart cut head ${opts.label}${opts.forceSoftware ? ' (software)' : ''}`,
      onProgress: (p) =>
        opts.onProgress({
          stage: 'cutting',
          // The head is the only part with real work in it, but it is a small
          // slice of the output, so its progress is reported against the head
          // and capped below 1 — the copy and mux fill the rest.
          fraction: Math.min(0.7, (p.outTimeSeconds / Math.max(0.001, headSeconds)) * 0.7),
          message: `Cutting (frame accurate)… ${p.speed > 0 ? `${p.speed.toFixed(1)}x` : ''}`.trim(),
          bytes: p.totalSizeBytes
        })
    })

    // ------------------------------------------------------------ tail ----
    /*
     * Seeking a hair past the keyframe, not exactly onto it: a stream copy
     * starts at the keyframe at or before the seek point, and asking for the
     * keyframe's own timestamp back after a round-trip through floating point
     * can land a microsecond early and rewind a whole GOP.
     *
     * No end bound. A copy cannot be trimmed reliably on either side here —
     * `-t` and `-to` are both read against the source's own start time on a
     * stream copy — so the tail simply runs to the end of the fetched window
     * and the final mux, which counts from zero, trims it to length. The
     * window is only ever the clip plus its segment overhang, and copying a
     * few extra seconds of it costs nothing next to downloading it.
     */
    const tailArgs: string[] = ['-y', '-progress', 'pipe:1', '-nostats']
    tailArgs.push('-ss', toFfmpegTime(roundMs(headEndSeconds + 0.002)), '-i', opts.videoFile)
    tailArgs.push('-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy')
    tailArgs.push('-f', 'mpegts', tailPath)

    await this.ffmpeg.exec(tailArgs, {
      signal: opts.signal,
      label: `smart cut tail ${opts.label}`,
      onProgress: (p) =>
        opts.onProgress({
          stage: 'muxing',
          fraction: 0.7 + Math.min(0.2, (p.outTimeSeconds / Math.max(0.001, tailSeconds)) * 0.2),
          message: 'Copying the rest…',
          bytes: p.totalSizeBytes
        })
    })

    // ----------------------------------------------------------- splice ----
    // Bare names, not paths: the concat demuxer resolves entries relative to
    // the list file, which sidesteps quoting a Windows path with backslashes
    // and drive letters in a format that treats both as syntax.
    await writeFile(listPath, "file 'splice-head.ts'\nfile 'splice-tail.ts'\n", 'utf-8')

    /*
     * The sound is trimmed by an OUTPUT seek, with the spliced picture slid
     * onto the sound's own clock first.
     *
     * Seeking the audio input instead puts it out of sync: a stream copy has
     * no accurate input seek, so it starts at whatever packet precedes the
     * mark and `-avoid_negative_ts` then shifts the lot forward — measured
     * here as sound running 0.85s late against a picture that was exactly
     * right. An output seek discards by timestamp and is exact, and it is
     * honoured because this command maps audio (it is silently ignored on a
     * video-only mapping — see the head, above). `-itsoffset` is what lets
     * one seek do both: it moves the spliced picture to sit at the same
     * instant on the timeline the sound is being cut at.
     */
    const audioSeek = Math.max(0, roundMs(opts.audioSeekSeconds))
    const muxArgs: string[] = ['-y', '-progress', 'pipe:1', '-nostats']
    if (opts.audioFile) muxArgs.push('-itsoffset', toFfmpegTime(audioSeek))
    muxArgs.push('-f', 'concat', '-safe', '0', '-i', listPath)
    if (opts.audioFile) {
      muxArgs.push('-i', opts.audioFile)
      muxArgs.push('-ss', toFfmpegTime(audioSeek))
    }
    muxArgs.push('-t', toFfmpegTime(opts.durationSeconds))
    muxArgs.push('-map', '0:v:0')
    if (opts.audioFile) muxArgs.push('-map', '1:a:0?')
    muxArgs.push('-c:v', 'copy')
    if (opts.audioFile) {
      if (opts.containerPlan.copyAudio) muxArgs.push('-c:a', 'copy')
      else muxArgs.push('-c:a', opts.containerPlan.audioEncoder ?? 'aac', '-b:a', '320k')
    }
    muxArgs.push('-avoid_negative_ts', 'make_zero')
    if (opts.containerPlan.container === 'mp4' && opts.faststart) {
      muxArgs.push('-movflags', '+faststart')
    }
    muxArgs.push('-map_metadata', '-1', '-map_chapters', '-1', opts.outputPath)

    await this.ffmpeg.exec(muxArgs, {
      signal: opts.signal,
      label: `smart cut splice ${opts.label}`,
      onProgress: (p) =>
        opts.onProgress({
          stage: 'muxing',
          fraction: 0.9 + Math.min(0.1, (p.outTimeSeconds / Math.max(0.001, opts.durationSeconds)) * 0.1),
          message: 'Muxing…',
          bytes: p.totalSizeBytes
        })
    })

    await Promise.all([
      rm(headPath, { force: true }).catch(() => undefined),
      rm(tailPath, { force: true }).catch(() => undefined),
      rm(listPath, { force: true }).catch(() => undefined)
    ])

    return `${encoded.description} for the first ${headSeconds.toFixed(2)}s, stream copy for the rest`
  }

  private buildCutArgs(opts: {
    videoWindow: { file: string; windowStartSeconds: number } | null
    audioWindow: { file: string; windowStartSeconds: number } | null
    pipWindow: { file: string; windowStartSeconds: number } | null
    /** Where the pip range starts in the inset POV's own timeline. */
    pipStartSeconds?: number
    pipTransform?: TimelineTransform
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
    /** Keep the frames on the GPU: NVDEC in, `overlay_cuda`, NVENC out. */
    cuda?: boolean
    watermark?: ResolvedWatermark
    transform?: TimelineTransform
    opacity?: number
    frameWidth?: number
    frameHeight?: number
    audioEdits?: AudioEdit[]
    audioGain?: number
    /** Write the mp4 index at the front, at the cost of rewriting the file. */
    faststart: boolean
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
    const relPip = opts.pipWindow
      ? roundMs((opts.pipStartSeconds ?? opts.startSeconds) - opts.pipWindow.windowStartSeconds)
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
              opts.audioWindow ? relAudio : Infinity,
              opts.pipWindow ? relPip : Infinity
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
        if (opts.cuda) {
          // `-hwaccel auto` decodes on the GPU and then downloads every frame,
          // because the filter graph after it is a CPU one. Naming cuda *and*
          // its output format is what leaves the frames where they were
          // decoded, which is the entire point of this path.
          args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda')
        } else {
          args.push('-hwaccel', 'auto')
        }
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

    // The pip inset is its own fetched window, seeked the same way the main
    // video is — its own audio is simply never mapped anywhere below.
    let pipInput: number | null = null
    if (opts.pipWindow) {
      args.push('-ss', toFfmpegTime(Math.max(0, roundMs(relPip - preroll))), '-i', opts.pipWindow.file)
      pipInput = inputIndex++
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

    // Transform runs first, then the pip inset composites onto the
    // repositioned background, then the watermark draws on top of all of
    // it — so the logo stays anchored to the frame and always ends up
    // visibly on top, whatever else this segment is doing.
    const transformPlan =
      videoInput !== null && opts.frameWidth && opts.frameHeight
        ? buildTransformFilter(opts.transform, opts.opacity, {
            frameWidth: opts.frameWidth,
            frameHeight: opts.frameHeight,
            videoLabel: `${videoInput}:v:0`,
            outputLabel: 'xf'
          })
        : null

    const pipPlan =
      pipInput !== null && videoInput !== null && opts.frameWidth && opts.frameHeight
        ? buildPipFilter(opts.pipTransform, {
            frameWidth: opts.frameWidth,
            frameHeight: opts.frameHeight,
            backgroundLabel: transformPlan ? transformPlan.outputLabel : `${videoInput}:v:0`,
            insetLabel: `${pipInput}:v:0`,
            outputLabel: 'pip'
          })
        : null

    // The watermark's overlay runs in its own -filter_complex, chained onto
    // whatever the picture already is by this point.
    const videoPlan =
      opts.watermark && videoInput !== null && watermarkInput !== null && opts.frameWidth && opts.frameHeight
        ? buildWatermarkFilter(opts.watermark, {
            frameWidth: opts.frameWidth,
            frameHeight: opts.frameHeight,
            videoLabel: pipPlan
              ? pipPlan.outputLabel
              : transformPlan
                ? transformPlan.outputLabel
                : `${videoInput}:v:0`,
            imageLabel: `${watermarkInput}:v`,
            outputLabel: 'wm',
            cuda: opts.cuda === true
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
            gain: opts.audioGain
          }
        )
      : null

    const graphs = [
      transformPlan?.filterComplex,
      pipPlan?.filterComplex,
      videoPlan?.filterComplex,
      audioPlan?.filterComplex
    ].filter(Boolean)
    if (graphs.length > 0) args.push('-filter_complex', graphs.join(';'))

    const finalVideoLabel = videoPlan?.outputLabel ?? pipPlan?.outputLabel ?? transformPlan?.outputLabel ?? null
    if (finalVideoLabel) args.push('-map', `[${finalVideoLabel}]`)
    else if (videoInput !== null) args.push('-map', `${videoInput}:v:0`)

    if (audioPlan?.filterComplex) args.push('-map', `[${audioPlan.outputLabel}]`)
    else if (audioInput !== null) args.push('-map', `${audioInput}:a:0?`)
    else if (opts.muxed && videoInput !== null) args.push('-map', `${videoInput}:a:0?`)

    // Video codec
    let videoEncoding = 'no video'
    if (videoInput !== null) {
      if (opts.decision.mode === 'copy' && !videoPlan && !transformPlan && !pipPlan) {
        args.push('-c:v', 'copy')
        videoEncoding = 'stream copy (no re-encode)'
      } else {
        const encoded = this.videoEncoderArgs(
          opts.forceSoftware ? { ...opts.settings, hwAccel: 'none' } : opts.settings,
          opts.sourceVideoCodec
        )
        // Only the re-encode path: a stream copy has nothing to thread.
        if (this.encodeThreads > 0) args.push('-threads', String(this.encodeThreads))
        args.push(...encoded.args)
        videoEncoding = encoded.description
      }
    }

    // Audio codec — never re-encode unless the container forces it, or an
    // edit was applied and there is no longer a copy of the original to copy.
    if (opts.plan.copyAudio && !audioPlan?.filterComplex) args.push('-c:a', 'copy')
    else args.push('-c:a', opts.plan.audioEncoder ?? 'aac', '-b:a', '320k')

    args.push('-avoid_negative_ts', 'make_zero')
    if (opts.plan.container === 'mp4' && opts.faststart) args.push('-movflags', '+faststart')
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
    /*
     * Speed is chosen with the preset; quality is held by the rate control.
     *
     * These two knobs are independent, and conflating them is how an export
     * ends up slow for nothing. `-cq 19` is what decides how the picture
     * looks, and it does not move. The preset only decides how hard the
     * encoder searches to hit it — p5 to p4 is roughly a third faster on the
     * same silicon for a file a few percent larger at the same quality. When
     * an encode is unavoidable, that trade is the right way round.
     */
    if (hw?.includes('nvenc')) {
      const cq = targetFamily === 'av1' ? '25' : '19'
      return {
        args: [
          '-c:v',
          hw,
          '-preset',
          'p4',
          '-tune',
          'hq',
          '-rc',
          'vbr',
          '-cq',
          cq,
          '-b:v',
          '0',
          '-bf',
          '0',
          // The encoder is far quicker than one frame's round trip through
          // the pipeline; two surfaces in flight is what keeps it fed.
          '-delay',
          '0'
        ],
        description: `${hw} (NVIDIA hardware)`
      }
    }
    if (hw?.includes('qsv')) {
      return {
        args: [
          '-c:v',
          hw,
          '-preset',
          'faster',
          '-global_quality',
          '20',
          // Look-ahead buys a little quality for a lot of latency, and this is
          // a short clip being cut, not a stream being broadcast.
          '-look_ahead',
          '0',
          '-bf',
          '0'
        ],
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
      return { args: ['-c:v', 'libsvtav1', '-crf', '30', '-preset', '10', '-bf', '0'], description: 'libsvtav1 (software)' }
    }
    /*
     * `veryfast`, not `medium`, and the CRF is untouched.
     *
     * This path only runs when there is no encoder in the machine at all, so
     * it is already the slowest thing the app can do — `medium` made it about
     * four times slower again for a file maybe 10% smaller at the same CRF,
     * which is the wrong side of the trade for someone waiting on a clip.
     */
    return targetFamily === 'hevc'
      ? { args: ['-c:v', 'libx265', '-crf', '20', '-preset', 'veryfast', '-bf', '0'], description: 'libx265 (software)' }
      : { args: ['-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-bf', '0'], description: 'libx264 (software)' }
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

    /*
     * Bounded, not all at once.
     *
     * A combine of a hundred and fifty parts forked a hundred and fifty
     * ffprobe processes simultaneously, every one of them seeking the same
     * disk the parts had just been written to. Four at a time reads the same
     * data in about the same wall-clock time without the thundering herd.
     */
    const probes = await Promise.all(
      opts.parts.map((p) => combineProbeLimiter.run(() => this.ffmpeg.probe(p)))
    )
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
      if (this.encodeThreads > 0) args.push('-threads', String(this.encodeThreads))
      args.push(...encoded.args)
      notes.push(`Video: ${encoded.description}.`)
      args.push('-c:a', 'aac', '-b:a', '320k')
    }
    // Same trade as a single export: see FASTSTART_MAX_SECONDS.
    const combinedSeconds = probes.reduce((sum, p) => sum + (Number(p.format.duration) || 0), 0)
    if (opts.outputPath.toLowerCase().endsWith('.mp4')) {
      if (combinedSeconds <= FASTSTART_MAX_SECONDS) args.push('-movflags', '+faststart')
      else
        notes.push(
          'The file was written without the streaming index at the front, which would have meant rewriting every byte of it a second time.'
        )
    }
    args.push(opts.outputPath)

    opts.onProgress({ stage: 'muxing', fraction: 0, message: 'Combining clips…' })
    try {
      await this.ffmpeg.exec(args, {
        signal: opts.signal,
        label: 'combine',
        // How far through the combined running time ffmpeg has written. The
        // total is already known — it is the sum of the parts' probed
        // durations, computed above for the faststart decision — so pinning
        // this at zero left the bar frozen for the whole combine on the one
        // export that takes longest.
        onProgress: (p) =>
          opts.onProgress({
            stage: 'muxing',
            fraction:
              combinedSeconds > 0
                ? Math.min(1, Math.max(0, p.outTimeSeconds / combinedSeconds))
                : 0,
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
