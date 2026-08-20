import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../../shared/errors.js'
import type { InstallProgress, ToolId, ToolStatus } from '../../shared/ipc.js'
import { run } from './process.js'
import type { Logger } from './logger.js'

/**
 * Installing the tools Ripper Clipper depends on.
 *
 * Rules this file exists to enforce:
 *
 *  - only the publishers' own release channels are ever contacted, over HTTPS,
 *    at URLs written down here rather than discovered at runtime;
 *  - when a publisher publishes a checksum, the download must match it or it is
 *    deleted and the install fails loudly;
 *  - archives are unpacked into scratch space and only files whose *names* are
 *    on this file's list are copied out, so a hostile archive cannot place
 *    anything anywhere — path traversal has nothing to traverse into;
 *  - nothing outside the managed tools folder is ever written, and an existing
 *    tool is replaced only after the new one has been verified.
 */

export type { InstallProgress, ToolId, ToolStatus }

export interface InstalledRecord {
  id: ToolId
  url: string
  sha256: string
  /** Where the expected digest came from, or null when the publisher has none. */
  digestSource: string | null
  files: string[]
  installedAt: string
}

interface Download {
  url: string
  /**
   * `tree` unpacks the whole archive into a named subdirectory — a Python
   * runtime is thousands of files, not a handful worth listing.
   */
  kind: 'binary' | 'archive' | 'tree'
  /** Subdirectory of the tools folder for a `tree` install. */
  intoDir?: string
  /**
   * Basenames to copy out of an archive, case-insensitive. An entry may use
   * `*` as a wildcard, for tools that ship several matching files where any of
   * them will do.
   */
  keep?: string[]
  /** Name to save a plain binary as. */
  saveAs?: string
  /** Publisher's digest for this exact file, when there is one. */
  expected?: { sha256: string; source: string } | null
  /**
   * Tried in order if the download itself fails. A *checksum* mismatch never
   * falls back — that is a signal, not a hiccup.
   */
  fallbacks?: Download[]
}

const USER_AGENT = 'Ripper Clipper (dependency installer)'

/** Injectable so tests can exercise the real install path without the network. */
export type Fetch = typeof fetch

/**
 * The platform the catalogue describes. Always this machine at runtime; the
 * packaging script points it at Windows so a Windows build can be assembled
 * from any host.
 */
let target: NodeJS.Platform = process.platform

export function setTargetPlatform(platform: NodeJS.Platform): void {
  target = platform
}

/** The one place a download URL may come from. */
const CATALOGUE: Record<
  ToolId,
  {
    label: string
    purpose: string
    required: boolean
    approxBytes: number
    /**
     * Files that prove the tool is installed, in the tools folder. Entries may
     * use `*`; every pattern has to match something.
     */
    provides: () => string[]
    plan: (get: Fetch) => Promise<Download | null>
  }
> = {
  ffmpeg: {
    label: 'FFmpeg',
    purpose: 'Cutting, muxing and verifying every exported clip.',
    required: true,
    approxBytes: 90 * 1024 * 1024,
    provides: () => exe(['ffmpeg', 'ffprobe']),
    plan: async (get) => {
      if (target === 'win32') {
        // gyan.dev is the Windows build linked from ffmpeg.org, and publishes a
        // SHA-256 next to every archive.
        const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
        return {
          url,
          kind: 'archive',
          keep: ['ffmpeg.exe', 'ffprobe.exe'],
          expected: await gyanDigest(get, `${url}.sha256`),
          // BtbN's builds are the other Windows source ffmpeg.org lists; used
          // only if gyan.dev cannot be reached at all.
          fallbacks: [
            {
              url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
              kind: 'archive',
              keep: ['ffmpeg.exe', 'ffprobe.exe'],
              expected: null
            }
          ]
        }
      }
      if (target === 'linux') {
        return {
          url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
          kind: 'archive',
          keep: ['ffmpeg', 'ffprobe'],
          expected: null
        }
      }
      return null
    }
  },

  ytdlp: {
    label: 'yt-dlp',
    purpose: 'Reading VOD metadata and stream manifests from Twitch, Kick and YouTube.',
    required: true,
    approxBytes: 18 * 1024 * 1024,
    provides: () => exe(['yt-dlp']),
    plan: async (get) => {
      const asset =
        target === 'win32'
          ? 'yt-dlp.exe'
          : target === 'darwin'
            ? 'yt-dlp_macos'
            : 'yt-dlp_linux'
      const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
      return {
        url: `${base}/${asset}`,
        kind: 'binary',
        saveAs: target === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
        expected: await sumsDigest(get, `${base}/SHA2-256SUMS`, asset)
      }
    }
  },

}

function exe(names: string[]): string[] {
  return names.map((n) => (target === 'win32' ? `${n}.exe` : n))
}

export class ToolInstaller {
  constructor(
    private readonly log: Logger,
    /** Managed tools folder. Nothing is ever written outside it. */
    private readonly dir: string,
    private readonly get: Fetch = fetch,
    /** Tools shipped inside the app folder. Read-only; never written to. */
    private readonly bundledDir: string | null = null
  ) {}

  get directory(): string {
    return this.dir
  }

  async status(): Promise<ToolStatus[]> {
    const out: ToolStatus[] = []
    for (const id of Object.keys(CATALOGUE) as ToolId[]) {
      const spec = CATALOGUE[id]
      const names = spec.provides()
      // A build that ships its tools is already done; only what is missing from
      // both places is worth downloading.
      const bundled = this.bundledDir ? await hasAll(this.bundledDir, names) : false
      const managed = await hasAll(this.dir, names)
      out.push({
        id,
        label: spec.label,
        purpose: spec.purpose,
        required: spec.required,
        installed: managed || bundled,
        // A downloaded copy takes precedence, so it is the one described.
        bundled: bundled && !managed,
        managedPath: managed
          ? join(this.dir, names[0])
          : bundled
            ? join(this.bundledDir!, names[0])
            : null,
        approxBytes: spec.approxBytes,
        unsupported: unsupportedReason(id)
      })
    }
    return out
  }

  /**
   * Download, verify and install one tool. Returns the record written to the
   * manifest; throws an AppError the UI can show if anything is off.
   */
  async install(
    id: ToolId,
    onProgress: (p: InstallProgress) => void,
    signal?: AbortSignal
  ): Promise<InstalledRecord> {
    const spec = CATALOGUE[id]
    const report = (
      stage: InstallProgress['stage'],
      message: string,
      fraction = 0,
      receivedBytes = 0,
      totalBytes: number | null = null
    ): void => onProgress({ id, label: spec.label, stage, fraction, receivedBytes, totalBytes, message })

    report('checking', `Looking up ${spec.label}…`)
    let plan = await spec.plan(this.get)
    if (!plan) {
      throw new AppError({
        code: 'tool-unsupported',
        title: `${spec.label} cannot be installed automatically`,
        message: unsupportedReason(id) ?? `There is no published ${spec.label} build for this system.`
      })
    }

    const work = join(this.dir, `.staging-${id}-${Date.now().toString(36)}`)
    await mkdir(work, { recursive: true })

    try {
      const attempts = [plan, ...(plan.fallbacks ?? [])]
      let chosen = plan
      let file = ''
      let digest = ''
      for (const [index, attempt] of attempts.entries()) {
        chosen = attempt
        file = join(work, basename(new URL(attempt.url).pathname) || 'download')
        try {
          digest = await this.download(attempt.url, file, signal, (received, total) =>
            report(
              'downloading',
              `Downloading ${spec.label}…`,
              total ? received / total : 0,
              received,
              total
            )
          )
          break
        } catch (err) {
          if (signal?.aborted || index === attempts.length - 1) throw err
          this.log.warn('deps', 'Download source failed; trying the next one', {
            tool: id,
            failed: attempt.url,
            next: attempts[index + 1].url
          })
        }
      }
      plan = chosen

      report('verifying', `Checking ${spec.label}…`, 1)
      if (plan.expected) {
        if (digest.toLowerCase() !== plan.expected.sha256.toLowerCase()) {
          this.log.error('deps', 'Checksum mismatch', {
            tool: id,
            url: plan.url,
            expected: plan.expected.sha256,
            got: digest
          })
          throw new AppError({
            code: 'tool-checksum',
            title: `${spec.label} download did not match its checksum`,
            message: `The file Ripper Clipper received does not match the checksum ${spec.label}'s publisher lists for it, so it was deleted rather than installed. This is usually a broken download — try again. If it keeps happening, install ${spec.label} yourself and point at it in Settings → Advanced.`,
            retryable: true,
            detail: `expected ${plan.expected.sha256}, got ${digest}`
          })
        }
        this.log.info('deps', 'Checksum verified', { tool: id, source: plan.expected.source })
      } else {
        this.log.warn('deps', 'Publisher provides no checksum for this file; digest recorded instead', {
          tool: id,
          url: plan.url,
          sha256: digest
        })
      }

      let installed: string[]
      if (plan.kind === 'binary') {
        report('installing', `Installing ${spec.label}…`, 1)
        const target = join(this.dir, plan.saveAs ?? basename(file))
        await this.place(file, target)
        installed = [target]
      } else if (plan.kind === 'tree') {
        report('extracting', `Unpacking ${spec.label}…`, 1)
        const unpacked = join(work, 'unpacked')
        await mkdir(unpacked, { recursive: true })
        await extractArchive(file, unpacked, signal)
        report('installing', `Installing ${spec.label}…`, 1)
        installed = [await this.installTree(unpacked, plan.intoDir ?? id)]
      } else {
        report('extracting', `Unpacking ${spec.label}…`, 1)
        const unpacked = join(work, 'unpacked')
        await mkdir(unpacked, { recursive: true })
        await extractArchive(file, unpacked, signal)
        report('installing', `Installing ${spec.label}…`, 1)
        installed = await this.harvest(unpacked, plan.keep ?? [])
        if (installed.length === 0) {
          throw new AppError({
            code: 'tool-archive',
            title: `${spec.label} archive did not contain what was expected`,
            message: `The archive downloaded from the publisher did not contain ${(plan.keep ?? []).join(', ')}. Nothing was installed. Install ${spec.label} yourself and point at it in Settings → Advanced.`,
            retryable: true
          })
        }
      }

      const record: InstalledRecord = {
        id,
        url: plan.url,
        sha256: digest,
        digestSource: plan.expected?.source ?? null,
        files: installed.map((p) => basename(p)),
        installedAt: new Date().toISOString()
      }
      await this.record(record)
      this.log.info('deps', 'Tool installed', { tool: id, files: record.files })
      report('done', `${spec.label} installed.`, 1)
      return record
    } catch (err) {
      report('failed', err instanceof Error ? err.message : String(err), 1)
      throw err
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async manifest(): Promise<InstalledRecord[]> {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, 'installed.json'), 'utf8'))
      return Array.isArray(raw) ? (raw as InstalledRecord[]) : []
    } catch {
      return []
    }
  }

  private async record(entry: InstalledRecord): Promise<void> {
    const current = (await this.manifest()).filter((r) => r.id !== entry.id)
    const file = join(this.dir, 'installed.json')
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify([...current, entry], null, 2), 'utf8')
    await rename(tmp, file)
  }

  /** Stream a URL to disk, hashing as it goes. Returns the sha256 hex. */
  private async download(
    url: string,
    destination: string,
    signal: AbortSignal | undefined,
    onBytes: (received: number, total: number | null) => void
  ): Promise<string> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') {
      throw new AppError({
        code: 'tool-insecure',
        title: 'Refused an insecure download',
        message: 'Ripper Clipper only downloads tools over HTTPS.',
        detail: url
      })
    }

    const response = await this.get(url, { signal, headers: { 'user-agent': USER_AGENT } })
    if (!response.ok || !response.body) {
      throw new AppError({
        code: 'tool-download',
        title: 'Download failed',
        message: `The publisher's server answered ${response.status} for this download. Check your connection and try again.`,
        retryable: true,
        detail: url
      })
    }

    const header = response.headers.get('content-length')
    const total = header ? Number(header) : null
    const hash = createHash('sha256')
    let received = 0
    let lastReport = 0

    const source = Readable.fromWeb(response.body as never)
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
      // Progress every 250 ms; a 150 MB model would otherwise flood the UI.
      const now = Date.now()
      if (now - lastReport > 250) {
        lastReport = now
        onBytes(received, total && Number.isFinite(total) ? total : null)
      }
    })

    await pipeline(source, createWriteStream(destination))
    onBytes(received, total && Number.isFinite(total) ? total : received)
    return hash.digest('hex')
  }

  /**
   * Move a whole unpacked tree into the tools folder. These archives contain a
   * single top-level directory; that directory becomes `<tools>/<name>`.
   */
  private async installTree(unpacked: string, name: string): Promise<string> {
    const entries = await readdir(unpacked, { withFileTypes: true })
    const roots = entries.filter((e) => e.isDirectory())
    const from = roots.length === 1 ? join(unpacked, roots[0].name) : unpacked
    const target = join(this.dir, name)
    await rm(target, { recursive: true, force: true })
    await mkdir(this.dir, { recursive: true })
    await rename(from, target).catch(async () => {
      // Different filesystems: fall back to a copy.
      const { cp } = await import('node:fs/promises')
      await cp(from, target, { recursive: true })
    })
    return target
  }

  /** Copy one verified file into the tools folder, replacing what was there. */
  private async place(from: string, to: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await copyFile(from, to)
    if (process.platform !== 'win32') await chmod(to, 0o755)
  }

  /**
   * Copy the wanted files out of an unpacked archive.
   *
   * Only basenames are matched and only regular files are copied, so however
   * the archive is laid out — and whatever it tried to call its entries —
   * nothing lands outside the tools folder.
   */
  private async harvest(root: string, keep: string[]): Promise<string[]> {
    if (keep.length === 0) return []
    const patterns = keep.map((k) => wildcard(k))
    const found = new Map<string, string>()
    const base = resolve(root)

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = join(dir, entry.name)
        // Symlinks are skipped outright: a link is the one entry that could
        // point at a file outside the scratch directory.
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        const name = entry.name.toLowerCase()
        if (found.has(name) || !patterns.some((p) => p.test(name))) continue
        const real = resolve(full)
        if (real !== base && !real.startsWith(base + sep)) continue
        found.set(name, full)
      }
    }
    await walk(base, 0)

    const installed: string[] = []
    for (const from of found.values()) {
      const target = join(this.dir, basename(from))
      await this.place(from, target)
      installed.push(target)
    }
    return installed
  }
}

/** `ggml*.dll` -> /^ggml.*\.dll$/ . Only `*` is special; everything else is literal. */
function wildcard(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '\u0000' : `\\${c}`))
    .split('\u0000')
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

function unsupportedReason(id: ToolId): string | null {
  if (id === 'ffmpeg' && !['win32', 'linux'].includes(target)) {
    return 'No published FFmpeg build is installed automatically on this system. Install FFmpeg yourself (brew install ffmpeg) and Ripper Clipper will find it.'
  }
  return null
}

/**
 * Unpack with the system archiver. `tar` reads zip on Windows (bsdtar ships
 * with Windows 10 and later) and .tar.xz on Linux, so one call covers both.
 * Arguments are passed as an argv array — nothing is ever handed to a shell.
 */
async function extractArchive(file: string, into: string, signal?: AbortSignal): Promise<void> {
  // bsdtar (Windows 10+) reads zip; GNU tar does not, so a zip unpacked on a
  // Linux host — which is how a Windows build gets assembled — uses unzip.
  const zipOnUnix = file.toLowerCase().endsWith('.zip') && process.platform !== 'win32'
  // A bare 'tar' resolves through PATH, and on a machine with Git for
  // Windows installed — extremely common — its own GNU tar (no zip support)
  // sits ahead of the Windows-native bsdtar in PATH order, so the same
  // "could not unpack" failure that GNU tar gives on Linux for a zip shows
  // up here too unless the System32 copy is asked for explicitly.
  const winTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const [command, args] = zipOnUnix
    ? ['unzip', ['-qo', file, '-d', into]]
    : [process.platform === 'win32' ? winTar : 'tar', ['-xf', file, '-C', into]]
  const result = await run(command, args, { signal, idleTimeoutMs: 10 * 60_000 })
  if (result.code !== 0) {
    throw new AppError({
      code: 'tool-extract',
      title: 'Could not unpack the download',
      message:
        'Ripper Clipper could not unpack the archive it downloaded. On Windows this needs the built-in tar command (Windows 10 or later). The full output is in the log.',
      retryable: true,
      detail: result.stderr.slice(-1200)
    })
  }
}

/**
 * Is every wanted file present in this folder? Patterns may use `*`, which is
 * how "at least one CPU backend DLL" is expressed.
 */
export async function hasAll(dir: string, patterns: string[]): Promise<boolean> {
  if (patterns.length === 0) return false
  const listing = (await readdir(dir).catch(() => [] as string[])).map((n) => n.toLowerCase())
  for (const pattern of patterns) {
    if (pattern.includes('/')) {
      // A path inside an installed tree, e.g. "python/bin/python3".
      const found = await stat(join(dir, pattern))
        .then((s) => s.isFile())
        .catch(() => false)
      if (!found) return false
      continue
    }
    const test = wildcard(pattern)
    if (!listing.some((name) => test.test(name))) return false
  }
  return true
}

// --- publisher checksum lookups ---------------------------------------------

async function fetchText(get: Fetch, url: string): Promise<string | null> {
  try {
    const response = await get(url, { headers: { 'user-agent': USER_AGENT } })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

/** gyan.dev publishes "<archive>.sha256" containing the bare digest. */
async function gyanDigest(get: Fetch, url: string): Promise<Download['expected']> {
  const text = await fetchText(get, url)
  const match = text ? /\b([a-f0-9]{64})\b/i.exec(text) : null
  return match ? { sha256: match[1], source: url } : null
}

/** yt-dlp publishes one SHA2-256SUMS file per release. */
async function sumsDigest(get: Fetch, url: string, asset: string): Promise<Download['expected']> {
  const text = await fetchText(get, url)
  if (!text) return null
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/i.exec(line.trim())
    if (match && basename(match[2]) === asset) return { sha256: match[1], source: url }
  }
  return null
}

/** Exposed for tests: the catalogue is data, and data can be checked. */
export function toolIds(): ToolId[] {
  return Object.keys(CATALOGUE) as ToolId[]
}
