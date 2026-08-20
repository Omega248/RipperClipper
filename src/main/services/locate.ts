import { access, constants, readdir, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/**
 * Finding external tools (ffmpeg, ffprobe, yt-dlp) on the user's machine.
 *
 * The PATH is not enough on its own: a package manager that installs a tool
 * *while the app is running* — or a terminal opened before the install — leaves
 * the app with a stale PATH, and the tool appears missing even though it is
 * there. So every well-known install location is checked too, including the
 * shim folders used by WinGet, Scoop and Chocolatey, and a shallow scan of
 * WinGet's package directory.
 */

/**
 * The folder Ripper Clipper installs tools into. Set once at startup; searched
 * before PATH so a managed copy always wins over whatever else is lying around.
 */
let managedDir: string | null = null

export function setManagedToolsDir(dir: string | null): void {
  managedDir = dir
}

export function managedToolsDir(): string | null {
  return managedDir
}

export interface LocateOptions {
  /** Explicit path configured by the user. Always wins when it works. */
  override?: string | null
  /** Directory shipped alongside the app (resources/bin). */
  bundledDir?: string | null
}

export interface LocateResult {
  path: string | null
  /** Every location that was tried, for diagnostics. */
  searched: string[]
}

export async function locateExecutable(
  names: string[],
  options: LocateOptions = {}
): Promise<LocateResult> {
  const candidates: string[] = []
  const push = (value: string | null | undefined): void => {
    if (value && !candidates.includes(value)) candidates.push(value)
  }

  push(options.override)
  for (const dir of await searchDirectories(options.bundledDir)) {
    for (const name of names) push(join(dir, name))
  }

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return { path: candidate, searched: candidates }
  }
  return { path: null, searched: candidates }
}

/** Executable name variants for a tool on the current platform. */
export function executableNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`] : [base]
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    // X_OK is ignored on Windows, where existence is the meaningful check.
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    // A directory passes the access check — "tools/python" is a folder, not an
    // interpreter — so the file test is the one that matters.
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function searchDirectories(bundledDir: string | null | undefined): Promise<string[]> {
  const dirs: string[] = []
  const push = (value: string | null | undefined): void => {
    if (value && !dirs.includes(value)) dirs.push(value)
  }

  // A copy the editor downloaded is newer than whatever shipped in the build —
  // yt-dlp in particular has to be updatable — so it wins.
  push(managedDir)
  push(bundledDir)
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) push(dir)

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    const appData = process.env.APPDATA
    const userProfile = process.env.USERPROFILE
    const programFiles = process.env.ProgramFiles
    const programData = process.env.ProgramData

    // WinGet installs a shim here and adds it to the *user* PATH, which a
    // long-running shell (and therefore this process) may not have picked up.
    if (localAppData) push(join(localAppData, 'Microsoft', 'WinGet', 'Links'))
    // Scoop and Chocolatey equivalents.
    if (userProfile) push(join(userProfile, 'scoop', 'shims'))
    if (programData) push(join(programData, 'chocolatey', 'bin'))
    if (appData) push(join(appData, 'npm'))
    if (programFiles) {
      push(join(programFiles, 'ffmpeg', 'bin'))
      push(join(programFiles, 'yt-dlp'))
    }
    push('C:\\ffmpeg\\bin')
    push('C:\\yt-dlp')

    // WinGet unpacks portable tools into per-package folders; the shim above
    // usually covers this, but scan one level deep as a last resort.
    if (localAppData) {
      dirs.push(...(await shallowScan(join(localAppData, 'Microsoft', 'WinGet', 'Packages'))))
    }
  } else {
    push('/usr/local/bin')
    push('/usr/bin')
    push('/opt/homebrew/bin')
    push('/snap/bin')
  }

  return dirs
}

/** Immediate subdirectories of `root`, or nothing if it is unreadable. */
async function shallowScan(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name))
  } catch {
    return []
  }
}
