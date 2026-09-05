/*
 * Everything that decides whether playback is smooth, measured in one run.
 *
 * "Bad quality and not smooth" was diagnosed for two days off a screenshot of
 * the corner of a tile, because the numbers that matter — which decode chain
 * this machine actually uses, which rendition a tile pulls, how fast frames
 * really arrive — existed only inside a running window. This runs the app's
 * own code against the app's own POVs and writes all of it down.
 *
 * It imports the real resolvers and HLS parser rather than
 * reimplementing them, so a number here is a number the app would get. Nothing
 * is mocked and nothing is written to the user's folders.
 *
 *   node --experimental-transform-types --import ./scripts/sandbox-loader.mjs \
 *     scripts/diagnose.mts [--project <file.cookieclip>] [--url <vod url>]...
 *
 * With no arguments it finds the most recently modified project in Documents\
 * Ripper Clipper and uses its POVs.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { cpus, homedir, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Logger } from '../src/main/services/logger.ts'
import { FfmpegService } from '../src/main/media/ffmpeg.ts'
import { AdapterRegistry } from '../src/main/platforms/registry.ts'
import { ResolverService } from '../src/main/media/resolver.ts'
import { SourceService } from '../src/main/services/sources.ts'
import { isMasterPlaylist, parseMaster } from '../src/main/media/hls.ts'
import type { VodSource } from '../src/shared/types.ts'

const run = promisify(execFile)
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? null)
}
const flags = (name: string): string[] =>
  argv.reduce<string[]>((out, a, i) => (a === `--${name}` && argv[i + 1] ? [...out, argv[i + 1]] : out), [])

/** Everything goes to stdout; the .bat redirects it into _diagnose.log. */
const out: string[] = []
const say = (line = ''): void => {
  out.push(line)
  console.log(line)
}
const head = (title: string): void => {
  say()
  say(`=== ${title} ===`)
}
const ms = (start: number): string => `${(Date.now() - start).toFixed(0)}ms`

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'diagnose-'))
  const log = new Logger(join(root, 'logs'))
  const ffmpeg = new FfmpegService(log)

  say(`Ripper Clipper diagnosis — ${new Date().toISOString()}`)

  // ---------------------------------------------------------- machine ---
  head('machine')
  say(`platform    ${platform()} ${process.arch}`)
  say(`node        ${process.version}`)
  say(`cpu         ${cpus().length} logical — ${cpus()[0]?.model ?? 'unknown'}`)
  say(`memory      ${(totalmem() / 1024 ** 3).toFixed(1)} GB`)
  if (platform() === 'win32') {
    try {
      const { stdout } = await run('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join "; "'
      ])
      say(`gpu         ${stdout.trim() || 'none reported'}`)
    } catch {
      say('gpu         could not ask Windows')
    }
  }

  // ------------------------------------------------------------ tools ---
  head('tools')
  const env = await ffmpeg.detect({})
  say(`ffmpeg      ${env.ffmpegPath ?? 'NOT FOUND'}`)
  say(`ffprobe     ${env.ffprobePath ?? 'NOT FOUND'}`)
  say(`version     ${env.version ?? 'unknown'}`)
  say(`hw encoders ${env.hwEncoders?.join(', ') || 'none'}`)
  if (!env.available) {
    say('FFMPEG IS MISSING — nothing below can run.')
    return
  }
  const hwaccels = await ffmpeg.textOutput(['-hwaccels']).catch(() => '')
  const filters = await ffmpeg.textOutput(['-filters']).catch(() => '')
  // Inline rather than imported: this used to come from the app's own decode
  // pipeline, which no longer exists. Playback is the browser's job now; ffmpeg
  // is still what exports, so what its build can do is still worth reporting.
  const has = (haystack: string, needle: string): boolean => haystack.includes(needle)
  say(`hwaccels    ${hwaccels.split('\n').slice(1).join(' ').trim() || 'none'}`)
  say(`  (what the BUILD claims — an export is the real test)`)
  say(`cuda        ${has(hwaccels, 'cuda') && has(filters, 'scale_cuda') ? 'yes, with scale_cuda' : 'no'}`)
  say(`qsv         ${has(hwaccels, 'qsv') && has(filters, 'scale_qsv') ? 'yes, with scale_qsv' : 'no'}`)

  // ----------------------------------------------------------- angles ---
  head('angles')
  const sources = await loadSources(log)
  if (sources.length === 0) {
    say('No POVs found. Pass --project <file.cookieclip> or --url <vod url>.')
    return
  }
  for (const s of sources) {
    say(`${s.creator} — ${s.platform} — ${fmt(s.durationSeconds)} — ${s.playbackKind}`)
    say(`  ${s.playbackUrl ?? 'no playback url'}`)
  }

  // -------------------------------------------------------- playlists ---
  head('renditions offered')
  const masters = new Map<string, string>()
  for (const s of sources) {
    if (!s.playbackUrl) continue
    try {
      const started = Date.now()
      const text = await fetchText(s.playbackUrl)
      say(`${s.creator}: master fetched in ${ms(started)}`)
      if (!isMasterPlaylist(text)) {
        say('  not a master playlist — ffmpeg gets this exactly as it is')
        continue
      }
      masters.set(s.id, s.playbackUrl)
      const variants = parseMaster(text, s.playbackUrl).variants
      for (const v of variants) {
        say(
          `  ${String(v.height ?? '?').padStart(4)}p` +
            `${v.frameRate ? String(Math.round(v.frameRate)).padStart(3) : '   '}` +
            `  ${v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps`.padStart(11) : ''}` +
            `  ${v.codecs ?? ''}`
        )
      }
    } catch (err) {
      say(`${s.creator}: could not read the playlist — ${message(err)}`)
    }
  }

  // --------------------------------------------------------- pipeline ---
  head('app log written during this run')
  const lines = await readFile(log.path, 'utf8').catch(() => '')
  for (const line of lines.trim().split('\n').slice(-60)) say(line)

  await rm(root, { recursive: true, force: true })
  head('done')
  say('Send _diagnose.log to Claude.')
}

// ------------------------------------------------------------ helpers ---

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** The POVs to test: an explicit project, explicit URLs, or the newest project. */
async function loadSources(log: Logger): Promise<VodSource[]> {
  const urls = flags('url')
  if (urls.length > 0) {
    const registry = new AdapterRegistry()
    const service = new SourceService(log, registry, new ResolverService(log))
    const resolved: VodSource[] = []
    for (const url of urls) {
      try {
        resolved.push(await service.resolve(url))
      } catch (err) {
        say(`could not resolve ${url}: ${message(err)}`)
      }
    }
    return resolved
  }

  const path = flag('project') ?? (await newestProject())
  if (!path) return []
  say(`project     ${path}`)
  const project = JSON.parse(await readFile(path, 'utf8')) as { sources?: VodSource[] }
  return project.sources ?? []
}

async function newestProject(): Promise<string | null> {
  const dir = join(homedir(), 'Documents', 'Ripper Clipper')
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.cookieclip'))
    const dated = await Promise.all(
      names.map(async (n) => ({ n, at: (await stat(join(dir, n))).mtimeMs }))
    )
    const newest = dated.sort((a, b) => b.at - a.at)[0]
    return newest ? join(dir, newest.n) : null
  } catch {
    return null
  }
}

main().catch((err) => {
  say('')
  say(`DIAGNOSIS FAILED: ${message(err)}`)
  say(err instanceof Error ? (err.stack ?? '') : '')
  process.exitCode = 1
})
