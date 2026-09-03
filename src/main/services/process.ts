import { spawn } from 'node:child_process'
import { constants as osConstants, setPriority } from 'node:os'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Safe child-process helper.
 *
 * Every call goes through spawn() with an explicit argument array and
 * `shell: false`, so untrusted URLs and filenames can never be interpreted by a
 * shell. There is no string-concatenated command anywhere in the app.
 */

/**
 * How much of the machine a child process is allowed to take.
 *
 * Nothing this app runs is more important than whatever the person is
 * actually looking at. FFmpeg will use every cycle it is given, and at normal
 * priority that means competing head-on with the foreground window for the
 * scheduler — which is what a machine "freezing up" during an export actually
 * is. Below the foreground, ffmpeg still gets every idle cycle (so a batch
 * left running alone finishes just as fast) and gives them back the instant
 * anything else asks.
 *
 * - `normal`   the OS default. For quick metadata reads that finish in
 *              milliseconds, where the scheduling hint would cost more than
 *              the work.
 * - `background` exports: everything the person is waiting on.
 * - `idle`     filmstrips, waveforms, scene detection — work nobody asked
 *              for by name, which should never be felt at all.
 */
export type ProcessPriority = 'normal' | 'background' | 'idle'

export interface RunOptions {
  /** Scheduling priority for the child. Defaults to `normal`. */
  priority?: ProcessPriority
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
  /**
   * True when the run was killed because it went quiet for `idleTimeoutMs`.
   *
   * Distinct from `aborted` because the two mean opposite things to the
   * person: one is something they asked for, the other is a failure they
   * need told about. They used to share the `aborted` flag, so a wedged
   * ffmpeg — a stalled read, a hung encode — surfaced as `Errors.cancelled()`
   * and the export was filed as "Cancelled" by somebody who cancelled
   * nothing. It then could not be retried (`retryAllFailed` only takes
   * `failed`) and "Clear finished" removed it, so the only record that it had
   * ever gone wrong disappeared.
   */
  timedOut: boolean
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
      resolve({ code: null, signal: null, stdout: '', stderr: '', aborted: true, timedOut: false })
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

    applyPriority(child.pid, options.priority)

    const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER
    let stdout = ''
    let stderr = ''
    let aborted = false
    let timedOut = false
    let settled = false
    let idleTimer: NodeJS.Timeout | null = null

    const bumpIdle = (): void => {
      if (!options.idleTimeoutMs) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
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
      resolve({ code, signal, stdout, stderr, aborted, timedOut })
    })

    bumpIdle()
  })
}

/**
 * Lower the child's scheduling priority, if the OS lets us.
 *
 * Best-effort by design: lowering your own child's priority is permitted
 * everywhere this app runs, but a hardened policy or a container can still
 * refuse it, and a process that exits between spawn and this call leaves
 * nothing to set. None of that is worth failing an export over — the work
 * runs, it just runs at the default priority.
 */
function applyPriority(pid: number | undefined, priority: ProcessPriority | undefined): void {
  if (!pid || !priority || priority === 'normal') return
  try {
    setPriority(
      pid,
      priority === 'idle' ? osConstants.priority.PRIORITY_LOW : osConstants.priority.PRIORITY_BELOW_NORMAL
    )
  } catch {
    // Nothing to do about it, and nothing worth telling the user.
  }
}

/** Run and throw a ProcessError unless the exit code is 0. */
export async function runChecked(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<RunResult> {
  const result = await run(command, args, options)
  if (result.aborted) return result
  /*
   * A stall is a failure, not a quiet success.
   *
   * This returned the result unexamined whenever the run had been killed,
   * and the idle timeout used to look like an abort — so `keyframes()` got
   * an empty stdout, `JSON.parse('')` threw, and its catch reported "no
   * keyframes found", silently forcing a full re-encode of a clip that only
   * needed a copy.
   */
  if (result.timedOut) {
    throw new ProcessError(
      `${command} produced no output for ${Math.round((options.idleTimeoutMs ?? 0) / 1000)}s and was stopped`,
      result,
      command,
      args
    )
  }
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
