/**
 * Spike: what does native hardware decode of N live streams actually cost?
 *
 * The other half of the playback benchmark. Settings → Diagnostics measures
 * the POV wall as the browser decodes it; this measures the floor a native
 * player could reach on the same machine, with the same streams, by decoding
 * them with ffmpeg and throwing the frames away.
 *
 * Decoding to `-f null` is deliberately not a complete player — there is no
 * compositing and no presentation. That is the point: it is the *floor*. If
 * the floor is not meaningfully below what the browser already does, no
 * native player built on top of it can be either, and the case for the
 * rewrite is dead without anyone writing one.
 *
 * Throwaway. Delete it once the question is settled.
 *
 * Usage, from the repo root:
 *   node scripts/spike-native-decode.mjs <url> <url> ...
 *   node scripts/spike-native-decode.mjs --project "C:\path\to\Event.cookieclip"
 *
 * Options:
 *   --seconds 30     how long to decode for (default 30)
 *   --no-hw          software decode, to see what the GPU is buying you
 *   --ffmpeg <path>  override the ffmpeg binary
 *   --ytdlp <path>   override the yt-dlp binary
 */
import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const argv = process.argv.slice(2)

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const SECONDS = Number(flag('seconds', 30))
const NO_HW = argv.includes('--no-hw')

/** The bundled tools, wherever this build put them. */
function findTool(name, overrideFlag) {
  const override = flag(overrideFlag)
  if (override) return override
  const candidates = [
    join(process.cwd(), 'resources', 'bin', name),
    join(process.cwd(), 'release', 'win-unpacked', 'resources', 'bin', name),
    join(process.cwd(), 'node_modules', 'ffmpeg-static', name)
  ]
  return candidates.find(existsSync) ?? name.replace(/\.exe$/, '')
}
const FFMPEG = findTool(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', 'ffmpeg')
const YTDLP = findTool(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp', 'ytdlp')

async function urlsFromArgs() {
  const projectPath = flag('project')
  if (projectPath) {
    const project = JSON.parse(await readFile(projectPath, 'utf8'))
    return (project.sources ?? []).map((s) => s.url)
  }
  return argv.filter((a) => /^https?:\/\//.test(a) || /\.(m3u8|mp4|mkv|ts)$/i.test(a))
}

/** yt-dlp resolves a channel or VOD page to a direct stream URL. */
async function directUrl(pageUrl) {
  // Already a media URL (or a local file): nothing to resolve, and this is
  // what makes the script testable without hitting a platform at all.
  if (/\.(m3u8|mp4|mkv|ts)(\?|$)/i.test(pageUrl) || !/^https?:/i.test(pageUrl)) return pageUrl
  const { stdout } = await run(YTDLP, ['-g', '--no-warnings', pageUrl], {
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout.trim().split('\n')[0]
}

/** Per-process CPU and working set, summed. Windows and POSIX both handled. */
async function sampleProcesses(pids) {
  if (pids.length === 0) return { cpuPercent: 0, memoryMB: 0 }
  if (process.platform === 'win32') {
    const script = `
      $ids = @(${pids.join(',')})
      $n = [Environment]::ProcessorCount
      $out = 0.0; $mem = 0
      foreach ($id in $ids) {
        $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=$id" -ErrorAction SilentlyContinue
        if ($p) { $out += [double]$p.PercentProcessorTime; $mem += [int]($p.WorkingSetPrivate / 1MB) }
      }
      Write-Output "$out $mem"`
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], {
      maxBuffer: 1024 * 1024
    })
    const [cpu, mem] = stdout.trim().split(/\s+/).map(Number)
    return { cpuPercent: cpu || 0, memoryMB: mem || 0 }
  }
  const { stdout } = await run('ps', ['-o', 'pid=,pcpu=,rss=', '-p', pids.join(',')])
  let cpuPercent = 0
  let memoryMB = 0
  for (const line of stdout.trim().split('\n')) {
    const [, pcpu, rss] = line.trim().split(/\s+/)
    cpuPercent += Number(pcpu) || 0
    memoryMB += (Number(rss) || 0) / 1024
  }
  return { cpuPercent, memoryMB: Math.round(memoryMB) }
}

const main = async () => {
  const pages = await urlsFromArgs()
  if (pages.length === 0) {
    console.error('Give me some stream URLs, or --project <path to .cookieclip>.')
    process.exit(1)
  }

  console.log(`ffmpeg: ${FFMPEG}`)
  console.log(`yt-dlp: ${YTDLP}`)
  console.log(`Resolving ${pages.length} streams…`)
  const streams = []
  for (const page of pages) {
    try {
      streams.push({ page, url: await directUrl(page) })
      process.stdout.write('.')
    } catch (err) {
      process.stdout.write('x')
      console.error(`\n  ${page}: ${err.message.split('\n')[0]}`)
    }
  }
  console.log(`\nResolved ${streams.length} of ${pages.length}.`)
  if (streams.length === 0) process.exit(1)

  console.log(
    `Decoding all ${streams.length} for ${SECONDS}s with ${NO_HW ? 'software' : 'hardware'} decode…`
  )

  const children = streams.map(({ url }) =>
    spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-nostats',
        ...(NO_HW ? [] : ['-hwaccel', 'auto']),
        '-i', url,
        '-t', String(SECONDS),
        // Decode and discard: no encoding, no writing, no presentation.
        '-f', 'null',
        '-'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
  )
  for (const c of children) c.stderr.on('data', () => {})

  const pids = children.map((c) => c.pid).filter(Boolean)
  const samples = []
  // Sampled straight away and then twice a second: waiting a full second for
  // the first reading meant a short run finished with nothing recorded at all.
  const take = async () => {
    try {
      samples.push(await sampleProcesses(pids))
    } catch {
      // A process that exited between listing and sampling is normal near the
      // end of the run; a failed sample is not a failed benchmark.
    }
  }
  await take()
  const timer = setInterval(() => void take(), 500)

  await Promise.all(
    children.map((c) => new Promise((resolve) => c.on('close', resolve)))
  )
  clearInterval(timer)
  await new Promise((r) => setTimeout(r, 200))

  const useful = samples.filter((s) => s.cpuPercent > 0)
  if (useful.length === 0) {
    // Worth distinguishing, because one of these is a broken measurement and
    // the other is the measurement working on the wrong input: a local file
    // decodes at 30x real time and is gone before the first sample lands.
    // A live stream arrives at 1x, which is the case this is built for.
    console.log(
      samples.length === 0
        ? '\nNo samples at all — the decoders exited immediately. Check the URLs resolved.'
        : `\n${samples.length} samples, all zero. If these were local files rather than live` +
          ' streams, they finished far faster than real time and there was nothing to measure.'
    )
    return
  }
  const cpus = useful.map((s) => s.cpuPercent)
  const mean = cpus.reduce((a, b) => a + b, 0) / cpus.length

  console.log('')
  console.log(`Native decode — ${streams.length} streams, ${NO_HW ? 'software' : 'hardware'}`)
  console.log(`sampled ${useful.length}s`)
  console.log(`cpu mean / peak   ${mean.toFixed(0)}% / ${Math.max(...cpus).toFixed(0)}% of one core`)
  console.log(`memory peak       ${Math.max(...useful.map((s) => s.memoryMB))} MB across all processes`)
  console.log('')
  console.log('Compare against Settings → Diagnostics → Playback benchmark, same streams.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
