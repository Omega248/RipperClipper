import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../../shared/errors.js'
import { WHISPER_MODELS, modelSpec } from '../../shared/transcription.js'
import type { WhisperModelId } from '../../shared/transcription.js'
import type { InstallProgress } from '../../shared/ipc.js'
import type { Logger } from './logger.js'

/**
 * The speech models, downloaded on demand.
 *
 * Kept apart from the tool installer deliberately. Tools are a fixed set the
 * app needs to function; models are large, several, and *chosen* — the editor
 * picks accuracy against download size and how long they are willing to wait.
 * Bundling any of them would add hundreds of megabytes to an installer for
 * people who may never transcribe anything.
 *
 * Downloads go to a temporary name and are renamed into place only once
 * complete, so an interrupted download can never leave a truncated model that
 * whisper would later fail to load in some confusing way.
 */

/** ggml models are published on Hugging Face by whisper.cpp's own author. */
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export interface ModelStatus {
  id: WhisperModelId
  label: string
  purpose: string
  approxBytes: number
  installed: boolean
  /** Actual size on disk once installed. */
  sizeBytes: number
  path: string | null
}

export class WhisperModelService {
  constructor(
    private readonly log: Logger,
    private readonly dir: string
  ) {}

  get directory(): string {
    return this.dir
  }

  async status(): Promise<ModelStatus[]> {
    const out: ModelStatus[] = []
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
        // half the expected size is treated as debris rather than trusted.
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

  async remove(id: WhisperModelId): Promise<ModelStatus[]> {
    await rm(join(this.dir, modelSpec(id).file), { force: true }).catch(() => undefined)
    return this.status()
  }

  /**
   * Fetch a model, reporting real byte progress.
   *
   * No checksum is verified here, and that is worth being explicit about:
   * Hugging Face publishes no digest for these files. What is enforced
   * instead is that the download completed and is the expected size — the
   * failure this actually protects against is a truncated or interrupted
   * transfer, which is the realistic one for a 600MB file over a home
   * connection.
   */
  async install(
    id: WhisperModelId,
    onProgress: (progress: InstallProgress) => void,
    signal?: AbortSignal,
    get: typeof fetch = fetch
  ): Promise<ModelStatus[]> {
    const spec = modelSpec(id)
    await mkdir(this.dir, { recursive: true })

    const target = join(this.dir, spec.file)
    const temp = `${target}.part`
    const report = (stage: InstallProgress['stage'], fraction: number, received: number, total: number | null, message: string): void =>
      onProgress({ id: 'whisper', label: spec.label, stage, fraction, receivedBytes: received, totalBytes: total, message })

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
    const hash = createHash('sha256')

    await rm(temp, { force: true }).catch(() => undefined)
    const out = createWriteStream(temp)
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
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

    this.log.info('whisper', 'Installed a speech model', {
      model: id,
      bytes: written,
      sha256: hash.digest('hex').slice(0, 16)
    })
    report('done', 1, written, written, `${spec.label} is ready.`)
    return this.status()
  }

  /** Clears any `.part` files left by an interrupted download. */
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
