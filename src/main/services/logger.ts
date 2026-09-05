import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { WriteStream } from 'node:fs'
import type { LogLevel } from '../../shared/types.js'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_LOG_BYTES = 5 * 1024 * 1024

/**
 * Structured JSONL logger with credential redaction.
 *
 * Anything that looks like a token, cookie, signature or client secret is
 * replaced before it reaches disk — including inside resolved media URLs,
 * which routinely carry signed query parameters.
 */
const SENSITIVE_KEYS = /^(authorization|cookie|cookies|set-cookie|client_secret|access_token|refresh_token|token|password|api_key|apikey|x-api-key)$/i

const SENSITIVE_QUERY = /^(sig|signature|token|hdnts|expire|ip|key|s|access_token|pot|n)$/i

export class Logger {
  private stream: WriteStream | null = null
  private level: LogLevel = 'info'
  private readonly file: string
  private readonly listeners = new Set<(line: string) => void>()

  constructor(directory: string, filename = 'cookie-clipper.log') {
    mkdirSync(directory, { recursive: true })
    this.file = join(directory, filename)
    this.rotateIfNeeded()
    this.stream = this.open()
  }

  /**
   * The log file, with the one listener that keeps it from being fatal.
   *
   * `createWriteStream` had no `error` handler, and a write stream that
   * errors with nothing listening throws — so the logger, whose entire job is
   * to be the thing still working when other things are not, could take the
   * process down. It is reachable without anything exotic: userData on a
   * redirected or network profile that goes away, a removable drive, a full
   * disk, permissions changing under a running app.
   *
   * It was also self-feeding. The main process reports an uncaught exception
   * by calling `log.error`, which writes to this same stream, which throws
   * again.
   *
   * On failure the file is dropped and everything else carries on: the
   * in-app log viewer still receives every line through `listeners`, errors
   * still reach the console, and one line says the file stopped so a missing
   * log is not a mystery later.
   */
  private open(): WriteStream {
    const stream = createWriteStream(this.file, { flags: 'a' })
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (this.stream !== stream) return
      this.stream = null
      console.error(
        `[logger] Could not write to ${this.file} (${err.code ?? err.message}). ` +
          'Logging to file has stopped; the app is unaffected.'
      )
    })
    return stream
  }

  get path(): string {
    return this.file
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  onLine(cb: (line: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  debug(scope: string, message: string, data?: unknown): void {
    this.write('debug', scope, message, data)
  }
  info(scope: string, message: string, data?: unknown): void {
    this.write('info', scope, message, data)
  }
  warn(scope: string, message: string, data?: unknown): void {
    this.write('warn', scope, message, data)
  }
  error(scope: string, message: string, data?: unknown): void {
    this.write('error', scope, message, data)
  }

  tail(lines: number): string {
    if (!existsSync(this.file)) return ''
    const content = readFileSync(this.file, 'utf8')
    const all = content.split('\n').filter(Boolean)
    return all.slice(-lines).join('\n')
  }

  /** Flush and close the log file. Awaiting this guarantees the file is on disk. */
  close(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (!stream) return Promise.resolve()
    return new Promise((resolve) => stream.end(() => resolve()))
  }

  private write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      // The message itself can carry a signed media URL, so it is redacted too.
      message: redactString(message),
      ...(data === undefined ? {} : { data: redact(data) })
    }
    const line = JSON.stringify(entry)
    this.stream?.write(line + '\n')
    for (const listener of this.listeners) listener(line)
    if (level === 'error') console.error(`[${scope}] ${entry.message}`)
  }

  private rotateIfNeeded(): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_LOG_BYTES) {
        renameSync(this.file, `${this.file}.1`)
      }
    } catch {
      // Rotation is best-effort; never block startup on it.
    }
  }
}

/** Replace credentials in arbitrary structures before logging. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack }
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(val, depth + 1)
    }
    return out
  }
  return value
}

export function redactString(input: string): string {
  if (input.length > 4000) input = `${input.slice(0, 4000)}…[truncated]`
  return input.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url))
}

/** Keep origin + path so logs stay useful, drop signed query parameters. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key) || url.searchParams.get(key)!.length > 64) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    return url.toString()
  } catch {
    return raw
  }
}
