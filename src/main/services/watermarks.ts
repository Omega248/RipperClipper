import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { createId } from '../../shared/clips.js'
import { Errors } from '../../shared/errors.js'
import type { WatermarkImage } from '../../shared/watermark.js'
import { atomicWriteJson } from './projects.js'
import type { Logger } from './logger.js'

/**
 * The watermark image library.
 *
 * Images are copied into the application's own folder rather than referenced
 * where the editor found them: a logo on a desktop that later gets tidied away
 * would otherwise break every export that used it, silently and long after the
 * fact. The copy is the one the exporter reads.
 *
 * Dimensions are read here, once, because the aspect ratio is needed by the
 * editor, the preview and the export filter — and reading a PNG header is
 * cheaper than asking FFmpeg every time a slider moves.
 */
export class WatermarkLibrary {
  private items: WatermarkImage[] = []

  constructor(
    private readonly log: Logger,
    private readonly directory: string
  ) {}

  private get indexFile(): string {
    return join(this.directory, 'index.json')
  }

  async load(): Promise<WatermarkImage[]> {
    try {
      const raw = await readFile(this.indexFile, 'utf8')
      const parsed = JSON.parse(raw)
      this.items = Array.isArray(parsed) ? parsed.filter(isImage) : []
    } catch {
      this.items = []
    }
    return this.items
  }

  list(): WatermarkImage[] {
    return this.items
  }

  find(id: string): WatermarkImage | null {
    return this.items.find((i) => i.id === id) ?? null
  }

  /**
   * Add a PNG the renderer drew, rather than a file the editor picked.
   *
   * This is how the automatic name badges are made: the renderer is Chromium,
   * so it can rasterise text far better than anything available here, and the
   * result then flows through exactly the same library, positioning and
   * export path as an imported logo. Nothing downstream knows the difference.
   */
  async addPng(dataUrl: string, name: string): Promise<WatermarkImage> {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
    if (!match) throw Errors.invalidRange('That is not a PNG this app can store.')

    await mkdir(this.directory, { recursive: true })
    const id = createId('wm')
    const destination = join(this.directory, `${id}.png`)
    await writeFile(destination, Buffer.from(match[1], 'base64'))

    const size = await imageSize(destination)
    const image: WatermarkImage = {
      id,
      name,
      path: destination,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      addedAt: new Date().toISOString()
    }
    this.items = [...this.items, image]
    await this.persist()
    this.log.info('watermark', 'Generated a name badge', { id, name, ...size })
    return image
  }

  /** Copy a file the editor picked into the library. */
  async add(sourcePath: string): Promise<WatermarkImage> {
    const extension = extname(sourcePath).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) {
      throw Errors.invalidRange('That file is not an image Ripper Clipper can use.')
    }
    await mkdir(this.directory, { recursive: true })

    const id = createId('wm')
    const destination = join(this.directory, `${id}${extension}`)
    await copyFile(sourcePath, destination)

    const size = await imageSize(destination)
    const image: WatermarkImage = {
      id,
      name: basename(sourcePath, extension),
      path: destination,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      addedAt: new Date().toISOString()
    }
    this.items = [...this.items, image]
    await this.persist()
    this.log.info('watermark', 'Image added to the library', { id, name: image.name, ...size })
    return image
  }

  async remove(id: string): Promise<WatermarkImage[]> {
    const image = this.find(id)
    this.items = this.items.filter((i) => i.id !== id)
    await this.persist()
    // The file goes too: a library entry the editor deleted should not leave
    // megabytes behind in the app folder.
    if (image) await rm(image.path, { force: true }).catch(() => undefined)
    return this.items
  }

  private async persist(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await atomicWriteJson(this.indexFile, this.items)
  }
}

function isImage(value: unknown): value is WatermarkImage {
  const v = value as WatermarkImage
  return Boolean(v && typeof v.id === 'string' && typeof v.path === 'string')
}

/**
 * Intrinsic size, read from the file's own header.
 *
 * PNG, GIF and JPEG cover everything the picker accepts, and WebP's VP8X form
 * covers the rest. A file whose header cannot be read returns null and the
 * caller falls back to treating it as square, which is wrong but harmless — the
 * editor sees it immediately and can resize.
 */
export async function imageSize(
  path: string
): Promise<{ width: number; height: number } | null> {
  let buffer: Buffer
  try {
    buffer = await readFile(path)
  } catch {
    return null
  }

  // PNG: IHDR is always the first chunk.
  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  // GIF: logical screen descriptor, little endian.
  if (buffer.length > 10 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }

  // WebP: the VP8X chunk carries canvas size as two 24-bit values, minus one.
  if (
    buffer.length > 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
      return { width, height }
    }
    if (chunk === 'VP8 ') {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff
      }
    }
  }

  // JPEG: walk the markers to the frame header.
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      // SOF0..SOF15, excluding the DHT/DAC/RST markers in that range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }

  return null
}
