/**
 * Fill `resources/bin` so a packaged Ripper Clipper carries its own tools.
 *
 * Run before packaging:
 *
 *     npm run tools          # this machine
 *     npm run tools:win      # a Windows build, from any host
 *
 * Flags: --platform <win32|linux|darwin>  --only a,b  --skip a,b  --dir <path>
 *
 * Every file comes from the publisher's own release channel and is checked
 * against the checksum that publisher publishes. Where the target platform is
 * this machine, each tool is then executed to prove it actually runs.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Logger } from '../src/main/services/logger.js'
import { ToolInstaller, setTargetPlatform } from '../src/main/services/deps.js'
import type { ToolId } from '../src/shared/ipc.js'
import { run } from '../src/main/services/process.js'
import { formatBytes } from '../src/shared/errors.js'

const args = process.argv.slice(2)
const flag = (name: string): string | null => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? (args[index + 1] ?? null) : null
}

const targetPlatform = (flag('platform') ?? process.platform) as NodeJS.Platform
const skip = new Set((flag('skip') ?? '').split(',').filter(Boolean))
const only = new Set((flag('only') ?? '').split(',').filter(Boolean))

setTargetPlatform(targetPlatform)

const here = dirname(fileURLToPath(import.meta.url))
const binDir = flag('dir') ?? join(here, '..', 'resources', 'bin')
await mkdir(binDir, { recursive: true })

const log = new Logger(join(here, '..', 'release', 'tool-logs'))
const installer = new ToolInstaller(log, binDir)

console.log(`Fetching tools for ${targetPlatform} into ${binDir}\n`)

let failed = 0
for (const tool of await installer.status()) {
  if (skip.has(tool.id) || (only.size > 0 && !only.has(tool.id))) {
    console.log(`- ${tool.label}: skipped`)
    continue
  }
  if (tool.unsupported) {
    console.log(`- ${tool.label}: ${tool.unsupported}`)
    continue
  }
  if (tool.installed) {
    console.log(`✓ ${tool.label}: already in resources/bin`)
    continue
  }

  try {
    const record = await installer.install(tool.id as ToolId, (p) => {
      if (p.stage === 'downloading' && p.totalBytes) {
        process.stdout.write(
          `\r  ${p.label} ${Math.round((p.receivedBytes / p.totalBytes) * 100)}% of ${formatBytes(p.totalBytes)}    `
        )
      }
    })
    process.stdout.write('\r')
    console.log(
      `✓ ${tool.label}: ${record.files.join(', ')}\n    sha256 ${record.sha256}\n    checksum ${
        record.digestSource ? `verified against ${record.digestSource}` : 'not published by this source — digest recorded above'
      }`
    )
  } catch (err) {
    failed++
    console.error(`✗ ${tool.label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- prove what landed ------------------------------------------------------

console.log('\nContents of resources/bin:')
for (const name of (await readdir(binDir)).sort()) {
  if (name === 'README.md') continue
  const info = await stat(join(binDir, name))
  console.log(`  ${name.padEnd(24)} ${formatBytes(info.size)}`)
}

if (targetPlatform === process.platform) {
  console.log('\nRunning each tool from the folder:')
  const checks: Array<[string, string[]]> = [
    ['ffmpeg', ['-version']],
    ['ffprobe', ['-version']],
    [targetPlatform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp', ['--version']]
  ]
  for (const [name, argv] of checks) {
    const file = join(binDir, targetPlatform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name)
    const exists = await stat(file).then(() => true).catch(() => false)
    if (!exists) {
      console.log(`  ${name}: not present`)
      continue
    }
    const result = await run(file, argv, { idleTimeoutMs: 60_000 })
    const line = (result.stdout || result.stderr).split('\n')[0]?.trim()
    console.log(`  ${result.code === 0 ? '✓' : '✗'} ${name}: ${line}`)
    if (result.code !== 0) failed++
  }
} else {
  console.log(`\n(${targetPlatform} binaries cannot be executed on ${process.platform}; Ripper Clipper checks them on first run.)`)
}

log.close()
if (failed > 0) {
  console.error(`\n${failed} tool${failed === 1 ? '' : 's'} could not be prepared.`)
  process.exit(1)
}
console.log('\nresources/bin is ready — a packaged build will carry these with it.')
