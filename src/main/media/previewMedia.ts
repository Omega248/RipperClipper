import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyPreview } from '../../shared/compat.js'
import type { PreviewPlan } from '../../shared/compat.js'
import { Errors } from '../../shared/errors.js'
import type { HwAccelPreference, StreamInfo, VodSource } from '../../shared/types.js'
import { windowExtension } from './exporter.js'
import type { FfmpegService } from './ffmpeg.js'
import type { RangeFetcher } from './rangeFetcher.js'
import type { Logger } from '../services/logger.js'

/**
 * Playable preview media for a range the player cannot decode itself.
 *
 * The source is inspected first — container, codecs, whether there is even a
 * picture — and only what is actually necessary is done: play it as it is,
 * copy the streams into MP4, or, as a last resort, re-encode a temporary copy.
 * Only the requested range is ever fetched or processed, and the result is
 * cached so scrubbing back to the same clip does not rebuild it.
 */

export interface PreviewAsset {
  /** Key under which the local server serves it. */
  id: string
  path: string
  plan: PreviewPlan
  reason: string
  /** Range this asset covers, in the POV's own time. */
  startSeconds: number
  endSeconds: number
  cached: boolean
}

export class PreviewMediaService {
  private readonly assets = new Map<string, PreviewAsset>()
  private maxSizeBytes: number
  private pruning: Promise<void> | null = null

  constructor(
    private readonly log: Logger,
    private readonly ffmpeg: FfmpegService,
    private readonly fetcher: RangeFetcher,
    private cacheDir: string,
    maxSizeBytes = 2 * 1024 * 1024 * 1024
  ) {
    this.maxSizeBytes = maxSizeBytes
  }

  setCacheDir(dir: string): void {
    this.cacheDir = dir
  }

  setMaxSizeBytes(bytes: number): void {
    this.maxSizeBytes = bytes
  }

  /**
   * Drops the oldest previews once the cache directory outgrows its budget —
   * "deleted automatically when not needed" without deleting anything a
   * *recent* cut might still want. Least-recently-*built* rather than
   * least-recently-*played*, since that's what an mtime scan of the
   * directory can actually see; good enough for a temp cache.
   */
  private async prune(): Promise<void> {
    let entries: Array<{ name: string; sizeBytes: number; mtimeMs: number }>
    try {
      const names = await readdir(this.cacheDir)
      entries = []
      for (const name of names) {
        if (!name.endsWith('.mp4') || name.endsWith('.partial.mp4')) continue
        const info = await stat(join(this.cacheDir, name)).catch(() => null)
        if (info?.isFile()) entries.push({ name, sizeBytes: info.size, mtimeMs: info.mtimeMs })
      }
    } catch {
      return
    }
    let total = entries.reduce((sum, e) => sum + e.sizeBytes, 0)
    if (total <= this.maxSizeBytes) return

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let removed = 0
    for (const entry of entries) {
      if (total <= this.maxSizeBytes * 0.9) break
      const id = entry.name.replace(/\.mp4$/, '')
      await rm(join(this.cacheDir, entry.name), { force: true }).catch(() => undefined)
      this.assets.delete(id)
      total -= entry.sizeBytes
      removed++
    }
    if (removed > 0) {
      this.log.info('preview', 'Pruned preview cache', { removed, remainingBytes: total })
    }
  }

  private schedulePrune(): void {
    if (this.pruning) return
    this.pruning = this.prune().finally(() => {
      this.pruning = null
    })
  }

  /** Path for an id handed out earlier, or null if it is unknown. */
  resolve(id: string): string | null {
    return this.assets.get(id)?.path ?? null
  }

  /**
   * Inspect a range, and produce something the player can definitely show.
   * `probeOnly` answers "would this play?" without building anything.
   */
  async ensure(req: {
    source: VodSource
    stream: StreamInfo
    startSeconds: number
    endSeconds: number
    workDir: string
    signal?: AbortSignal
    onProgress?: (fraction: number, message: string) => void
    hwAccel?: HwAccelPreference
    /**
     * A lighter proxy instead of the source's own resolution — for rapid
     * scrubbing, where decode speed matters more than picture quality.
     * Downscaling always means a re-encode, even for a range that would
     * otherwise just be stream-copied.
     */
    height?: number
  }): Promise<PreviewAsset> {
    if (!(req.endSeconds > req.startSeconds)) {
      throw Errors.invalidRange('That range is empty, so there is nothing to preview.')
    }

    const id = createHash('sha256')
      .update(
        [
          req.source.id,
          req.stream.id,
          req.stream.url,
          req.startSeconds.toFixed(3),
          req.endSeconds.toFixed(3),
          req.height ? `h${req.height}` : 'full'
        ].join('|')
      )
      .digest('hex')
      .slice(0, 24)

    const known = this.assets.get(id)
    if (known && (await stat(known.path).catch(() => null))) {
      return { ...known, cached: true }
    }

    // The in-memory index is empty right after a restart, but a previous
    // session may already have built exactly this file — the path is
    // deterministic from `id`, so it's found by looking rather than rebuilt
    // for no reason. `plan`/`reason` are only ever informational once a file
    // exists, so a generic label here costs nothing.
    const reusablePath = join(this.cacheDir, `${id}.mp4`)
    const reusable = await stat(reusablePath).catch(() => null)
    if (reusable?.isFile() && reusable.size > 0) {
      const asset: PreviewAsset = {
        id,
        path: reusablePath,
        plan: 'remux',
        reason: 'Reused from a previous session.',
        startSeconds: req.startSeconds,
        endSeconds: req.endSeconds,
        cached: true
      }
      this.assets.set(id, asset)
      return asset
    }

    await mkdir(this.cacheDir, { recursive: true })
    await mkdir(req.workDir, { recursive: true })

    req.onProgress?.(0.05, 'Fetching the range…')
    const window = await this.fetcher.fetchWindow({
      stream: req.stream,
      startSeconds: req.startSeconds,
      endSeconds: req.endSeconds,
      destination: join(req.workDir, `preview-src.${windowExtension(req.stream.container)}`),
      signal: req.signal,
      onProgress: (p) => req.onProgress?.(0.05 + p.fraction * 0.45, 'Fetching the range…')
    })

    const probe = await this.ffmpeg.probe(window.file)
    const video = probe.streams.find((s) => s.codec_type === 'video')
    const audio = probe.streams.find((s) => s.codec_type === 'audio')
    const { plan, reason } = classifyPreview({
      container: probe.format?.format_name,
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio)
    })

    if (plan === 'unsupported') {
      throw Errors.qualityUnavailable('a previewable picture', reason)
    }

    // A stream copy can't resize anything — downscaling always forces a
    // real re-encode, whatever classifyPreview would otherwise have picked.
    const transcoding = plan === 'transcode' || Boolean(req.height)

    const offset = Math.max(0, req.startSeconds - window.windowStartSeconds)
    const duration = req.endSeconds - req.startSeconds
    const output = join(this.cacheDir, `${id}.mp4`)
    // Keep the extension: FFmpeg picks its muxer from it, and ".partial" is
    // not a container it knows.
    const staged = join(this.cacheDir, `${id}.partial.mp4`)

    req.onProgress?.(0.55, transcoding ? 'Preparing the preview…' : 'Repackaging…')

    // Same reasoning as the exporter's precise-cut path: a transcode decodes
    // and re-encodes regardless, so it is worth putting on the GPU when one
    // is available and the editor has not turned that off.
    const hwAccel = req.hwAccel ?? 'auto'
    const hwEncoder = hwAccel !== 'none' ? this.ffmpeg.pickHwEncoder(hwAccel, 'h264') : null
    const common = [
      '-y',
      ...(transcoding && hwEncoder ? ['-hwaccel', 'auto'] : []),
      '-ss',
      offset.toFixed(3),
      '-i',
      window.file,
      '-t',
      duration.toFixed(3)
    ]
    const args = transcoding
        ? [
            ...common,
            ...(req.height ? ['-vf', `scale=-2:${req.height}`] : []),
            '-c:v',
            hwEncoder ?? 'libx264',
            ...(hwEncoder ? [] : ['-preset', 'veryfast', '-crf', '20']),
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            req.height ? '128k' : '192k',
            '-movflags',
            '+faststart',
            staged
          ]
        : [
            ...common,
            '-c',
            'copy',
            // A copy into MP4 has to be seekable from the first byte, or the
            // player will not scrub.
            '-movflags',
            '+faststart',
            staged
          ]

    try {
      await this.ffmpeg.exec(args, {
        signal: req.signal,
        label: `preview ${transcoding ? 'transcode' : 'remux'}`,
        onProgress: (p) =>
          req.onProgress?.(
            0.55 + Math.min(1, p.outTimeSeconds / Math.max(0.1, duration)) * 0.4,
            'Preparing the preview…'
          )
      })
    } catch (err) {
      // A stream copy can fail on an odd container; re-encoding always works.
      // (Only reachable when the copy branch was actually taken — a height
      // request always takes the transcode branch above instead.)
      if (!transcoding) {
        this.log.warn('preview', 'Copy failed; re-encoding the preview instead')
        await this.ffmpeg.exec(
          [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', staged],
          { signal: req.signal, label: 'preview transcode fallback' }
        )
      } else {
        throw err
      }
    }

    await rename(staged, output)
    const asset: PreviewAsset = {
      id,
      path: output,
      plan: transcoding ? 'transcode' : plan,
      reason,
      startSeconds: req.startSeconds,
      endSeconds: req.endSeconds,
      cached: false
    }
    this.assets.set(id, asset)
    this.schedulePrune()
    this.log.info('preview', 'Built preview media', {
      plan: transcoding ? 'transcode' : plan,
      height: req.height,
      seconds: Math.round(duration),
      source: req.source.title
    })
    req.onProgress?.(1, 'Ready')
    return asset
  }

  /** Drop everything: called when the cache is cleared. */
  async clear(): Promise<void> {
    this.assets.clear()
    await rm(this.cacheDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
