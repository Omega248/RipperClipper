import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { executableNames, locateExecutable } from '../../src/main/services/locate.js'

let dir: string
let originalPath: string | undefined

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\necho hi\n')
  if (process.platform !== 'win32') await chmod(path, 0o755)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vodclip-locate-'))
  originalPath = process.env.PATH
})

afterEach(async () => {
  process.env.PATH = originalPath
  await rm(dir, { recursive: true, force: true })
})

describe('locateExecutable', () => {
  it('prefers an explicit override over everything else', async () => {
    const custom = join(dir, 'my-yt-dlp')
    await makeExecutable(custom)
    const result = await locateExecutable(executableNames('yt-dlp'), { override: custom })
    expect(result.path).toBe(custom)
  })

  it('ignores an override that does not exist and keeps looking', async () => {
    const bundled = join(dir, 'bundled')
    await mkdir(bundled, { recursive: true })
    const real = join(bundled, executableNames('ffmpeg')[0])
    await makeExecutable(real)

    const result = await locateExecutable(executableNames('ffmpeg'), {
      override: join(dir, 'does-not-exist'),
      bundledDir: bundled
    })
    expect(result.path).toBe(real)
  })

  it('finds a tool on the PATH', async () => {
    const onPath = join(dir, executableNames('yt-dlp')[0])
    await makeExecutable(onPath)
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ''}`

    const result = await locateExecutable(executableNames('yt-dlp'))
    expect(result.path).toBe(onPath)
  })

  it('accepts any of the known name variants', async () => {
    const names = executableNames('yt-dlp')
    const alternate = join(dir, names[names.length - 1])
    await makeExecutable(alternate)
    const result = await locateExecutable(names, { bundledDir: dir })
    expect(result.path).toBe(alternate)
  })

  it('reports every location it tried when nothing is found', async () => {
    process.env.PATH = dir
    const result = await locateExecutable(executableNames('definitely-not-a-real-tool'))
    expect(result.path).toBeNull()
    expect(result.searched.length).toBeGreaterThan(0)
    expect(result.searched.some((p) => p.startsWith(dir))).toBe(true)
  })

  it('survives unreadable directories on the search path', async () => {
    process.env.PATH = [join(dir, 'nope'), dir].join(delimiter)
    const target = join(dir, executableNames('ffprobe')[0])
    await makeExecutable(target)
    const result = await locateExecutable(executableNames('ffprobe'))
    expect(result.path).toBe(target)
  })
})

describe('a folder is not a program', () => {
  it('never returns a directory that happens to have the right name', async () => {
    // "tools/python" is a folder containing an interpreter, not the
    // interpreter — and on Linux a directory passes an executable-bit check.
    const dir = join(tmpdir(), `locate-dir-${Date.now()}`)
    await mkdir(join(dir, 'python'), { recursive: true })
    const found = await locateExecutable(['python'], { bundledDir: dir })
    // It may find a real interpreter elsewhere; what it must never do is hand
    // back the folder, which is what tried to get spawned.
    expect(found.path).not.toBe(join(dir, 'python'))
    await rm(dir, { recursive: true, force: true })
  })
})
