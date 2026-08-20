import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Safe child-process helper.
 *
 * Every call goes through spawn() with an explicit argument array and
 * `shell: false`, so untrusted URLs and filenames can never be interpreted by a
 * shell. There is no string-concatenated command anywhere in the app.
 */

export interface RunOptions {
  /** Called for each chunk of stderr (ffmpeg writes progress there). */
  onStderr?: (chunk: string) => void
  onStdout?: (chunk: string) => void
  signal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Kill the process if it produces no output for this many ms. */
  idleTimeoutMs?: number
  maxBufferBytes?: number
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** True when the run was stopped through the AbortSignal. */
  aborted: boolean
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
    readonly command: string,
    readonly args: string[]
  ) {
    super(message)
    this.name = 'ProcessError'
  }
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', aborted: true })
      return
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      reject(err)
      return
    }

    const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER
    let stdout = ''
    let stderr = ''
    let aborted = false
    let settled = false
    let idleTimer: NodeJS.Timeout | null = null

    const bumpIdle = (): void => {
      if (!options.idleTimeoutMs) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        aborted = true
        kill()
      }, options.idleTimeoutMs)
    }

    const kill = (): void => {
      if (child.killed || child.exitCode !== null) return
      // SIGTERM first so ffmpeg can finalise; escalate if it ignores us.
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      }, 4000).unref?.()
    }

    const onAbort = (): void => {
      aborted = true
      kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      bumpIdle()
      if (stdout.length < maxBuffer) stdout += chunk
      options.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      bumpIdle()
      if (stderr.length < maxBuffer) stderr += chunk
      options.onStderr?.(chunk)
    })

    const cleanup = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code, signal, stdout, stderr, aborted })
    })

    bumpIdle()
  })
}

/** Run and throw a ProcessError unless the exit code is 0. */
export async function runChecked(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const result = await run(command, args, options)
  if (result.aborted) return result
  if (result.code !== 0) {
    throw new ProcessError(
      `${command} exited with code ${result.code ?? 'null'}`,
      result,
      command,
      args
    )
  }
  return result
}
