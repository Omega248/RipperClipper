import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../../shared/errors.js'
import { WHISPER_MODELS, modelSpec } from '../../shared/transcription.js'
import type { WhisperModelId } from '../../shared/transcription.js'
import type { InstallProgress, WhisperModelStatus } from '../../shared/ipc.js'
import type { Logger } from './logger.js'

/**
 * The speech models, downloaded on demand.
 *
 * Kept apart from the tool installer deliberately: tools are a fixed set the
 * app needs to run, while a model is *chosen* and, at up to 488MB, far too
 * large to bundle for people who may never use the censor suggestions.
 *
 * Downloads go to a temporary name and are renamed into place only once
 * complete, so an interrupted transfer can never leave a truncated model that
 * whisper would fail to load much later in some confusing way.
 */

/** ggml models are published on Hugging Face by whisper.cpp's own author. */
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export class WhisperModelService {
  constructor(
    private readonly log: Logger,
    private readonly dir: string
  ) {}

  get directory(): string {
    return this.dir
  }

  async status(): Promise<WhisperModelStatus[]> {
    const out: WhisperModelStatus[] = []
    for (const spec of WHISPER_MODELS) {
      const path = join(this.dir, spec.file)
      let sizeBytes = 0
      try {
        sizeBytes = (await stat(path)).size
      } catch {
        // not installed
      }
      out.push({
        id: spec.id,
        label: spec.label,
        purpose: spec.purpose,
        approxBytes: spec.approxBytes,
        // A part-downloaded file is not an installed model. Anything under
        // half the expected size is debris rather than something to trust.
        installed: sizeBytes > spec.approxBytes / 2,
        sizeBytes,
        path: sizeBytes > 0 ? path : null
      })
    }
    return out
  }

  /** The model file's path, or null when it is not installed. */
  async pathFor(id: WhisperModelId): Promise<string | null> {
    const found = (await this.status()).find((m) => m.id === id)
    return found?.installed ? found.path : null
  }

  /** The best installed model, so analysis can start without asking. */
  async bestInstalled(): Promise<WhisperModelId | null> {
    const installed = (await this.status()).filter((m) => m.installed)
    if (installed.length === 0) return null
    // Later entries in the catalogue are more accurate.
    const order = WHISPER_MODELS.map((m) => m.id)
    return installed.sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id))[0].id
  }

  async remove(id: WhisperModelId): Promise<WhisperModelStatus[]> {
    await rm(join(this.dir, modelSpec(id).file), { force: true }).catch(() => undefined)
    return this.status()
  }

  /**
   * Fetch a model, reporting real byte progress.
   *
   * No checksum is verified, and that is worth being explicit about: Hugging
   * Face publishes no digest for these files. What is enforced instead is
   * that the transfer completed at roughly the expected size — the realistic
   * failure for a several-hundred-megabyte download over a home connection.
   */
  async install(
    id: WhisperModelId,
    onProgress: (progress: InstallProgress) => void,
    signal?: AbortSignal,
    get: typeof fetch = fetch
  ): Promise<WhisperModelStatus[]> {
    const spec = modelSpec(id)
    await mkdir(this.dir, { recursive: true })

    const target = join(this.dir, spec.file)
    const temp = `${target}.part`
    const report = (
      stage: InstallProgress['stage'],
      fraction: number,
      received: number,
      total: number | null,
      message: string
    ): void =>
      onProgress({
        id: 'whisper',
        label: spec.label,
        stage,
        fraction,
        receivedBytes: received,
        totalBytes: total,
        message
      })

    report('downloading', 0, 0, spec.approxBytes, `Downloading ${spec.label}…`)

    const response = await get(`${MODEL_BASE}/${spec.file}`, {
      headers: { 'user-agent': 'Ripper Clipper (model installer)' },
      signal
    })
    if (!response.ok || !response.body) {
      throw new AppError({
        code: 'MODEL_DOWNLOAD_FAILED',
        title: 'Could not download the speech model',
        message: `The model host answered HTTP ${response.status}.`,
        retryable: true
      })
    }

    const total = Number(response.headers.get('content-length')) || spec.approxBytes
    let received = 0

    await rm(temp, { force: true }).catch(() => undefined)
    const out = createWriteStream(temp)
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      report('downloading', total > 0 ? received / total : 0, received, total, `Downloading ${spec.label}…`)
    })

    try {
      await pipeline(source, out)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw err
    }

    // A transfer that stopped early would otherwise be renamed into place and
    // fail much later, inside whisper, as an unreadable model.
    const written = (await stat(temp)).size
    if (written < spec.approxBytes / 2) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new AppError({
        code: 'MODEL_DOWNLOAD_TRUNCATED',
        title: 'The speech model did not download fully',
        message: `Expected around ${Math.round(spec.approxBytes / 1e6)}MB but only received ${Math.round(written / 1e6)}MB.`,
        retryable: true
      })
    }

    report('installing', 1, written, written, 'Finishing up…')
    await rm(target, { force: true }).catch(() => undefined)
    await rename(temp, target)

    this.log.info('whisper', 'Installed a speech model', { model: id, bytes: written })
    report('done', 1, written, written, `${spec.label} is ready.`)
    return this.status()
  }

  /** Clears `.part` files left by an interrupted download. */
  async cleanupPartials(): Promise<void> {
    try {
      const names = await readdir(this.dir)
      await Promise.all(
        names
          .filter((n) => n.endsWith('.part'))
          .map((n) => rm(join(this.dir, n), { force: true }).catch(() => undefined))
      )
    } catch {
      // no model directory yet
    }
  }
}
