import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { Errors } from '../../shared/errors.js'

/**
 * HTTP helpers for media retrieval: text fetch with retry, and a byte-accurate
 * file download that reports progress and supports cancellation + resume.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export interface HttpOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  retries?: number
}

export function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Reject anything that is not a plain http(s) URL before it reaches ffmpeg. */
export function assertHttpUrl(raw: string): string {
  if (!isValidHttpUrl(raw)) throw Errors.invalidUrl(raw)
  return raw
}

/**
 * ffmpeg's `-headers` argument, built so it cannot carry more than it says.
 *
 * The value is a single CRLF-delimited blob, so a carriage return or newline
 * inside a header name or value *is* a header separator: one bad value and the
 * request carries headers nobody wrote. The headers come from a source object
 * the renderer supplies, so this is reachable without touching the main
 * process. Nothing legitimate here contains a line break.
 *
 * Returns an empty array when there is nothing to send, so callers can spread
 * it unconditionally.
 */
export function headerArgs(headers: Record<string, string> | undefined): string[] {
  if (!headers) return []
  const safe = Object.entries(headers).filter(([name, value]) => {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) return false
    // A header name is a token; anything else is not a name we were given in
    // good faith.
    return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
  })
  if (safe.length === 0) return []
  return ['-headers', safe.map(([name, value]) => `${name}: ${value}`).join('\r\n') + '\r\n']
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<string> {
  const res = await requestWithRetry(url, options)
  return res.text()
}

/**
 * Fetch a whole resource (an HLS segment) into memory.
 *
 * The retry loop lives here rather than only inside `requestWithRetry`
 * because that one can only retry a request that failed before its headers
 * arrived. A connection that dies *mid-body* is the common failure once
 * segments are fetched in parallel, and recovering from it means issuing the
 * request again — which is only possible from out here. Thirty four-hour
 * VODs is on the order of forty thousand segment fetches, so a transient
 * mid-body failure is a certainty, not an edge case, and without this one of
 * them would fail a job outright after an hour of work.
 */
export async function fetchBuffer(url: string, options: HttpOptions = {}): Promise<Buffer> {
  const retries = options.retries ?? 3
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw Errors.cancelled()
    try {
      const res = await requestWithRetry(url, { ...options, retries: 0 })
      return await readBody(res, url, options)
    } catch (err) {
      lastError = err
      if (options.signal?.aborted) throw Errors.cancelled()
      if (isDefinitive(err)) throw err
      if (attempt < retries) await sleep(Math.min(8000, 500 * 2 ** attempt))
    }
  }

  throw lastError instanceof Error
    ? lastError
    : Errors.downloadFailed(`request to ${url} failed`)
}

/** No bytes at all for this long means the connection is dead, not just slow. */
const BODY_IDLE_TIMEOUT_MS = 45_000

/**
 * Read a response body under an *idle* timeout rather than a total one.
 *
 * A fixed overall deadline is the wrong shape once transfers run in parallel:
 * sharing the link between dozens of downloads makes each one slower by
 * design, so a total budget would start cancelling segments that are
 * downloading perfectly well. What actually distinguishes a dead connection
 * is no bytes arriving, so the timer resets on every chunk.
 *
 * The length check at the end matters more here than it looks. Cancelling a
 * reader makes the next `read()` report completion, which is indistinguishable
 * from a clean end of body — so without it a stalled transfer would return a
 * short buffer that gets written into the output file as if it were the whole
 * segment, and the corruption would only show up on playback.
 */
async function readBody(res: Response, url: string, options: HttpOptions): Promise<Buffer> {
  if (!res.body) throw Errors.downloadFailed(`empty response body for ${url}`)

  const idleMs = options.timeoutMs ?? BODY_IDLE_TIMEOUT_MS
  const declared = res.headers.get('content-length')
  const expected = declared ? Number(declared) : null

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => void reader.cancel().catch(() => undefined)
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      cancel()
    }, idleMs)
  }
  options.signal?.addEventListener('abort', cancel, { once: true })

  try {
    arm()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        size += value.byteLength
      }
      arm()
    }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }

  if (options.signal?.aborted) throw Errors.cancelled()
  if (timedOut) {
    throw Errors.downloadFailed(
      `${url} stalled for ${Math.round(idleMs / 1000)}s after ${size} bytes`
    )
  }
  if (expected !== null && Number.isFinite(expected) && size !== expected) {
    throw Errors.downloadFailed(`${url} returned ${size} bytes, expected ${expected}`)
  }

  return Buffer.concat(chunks, size)
}

/** Errors that mean retrying cannot possibly help. */
function isDefinitive(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false
  const code = (err as { code: string }).code
  return (
    code === 'auth-required' ||
    code === 'vod-unavailable' ||
    code === 'invalid-url' ||
    code === 'cancelled'
  )
}

export async function headContentLength(
  url: string,
  options: HttpOptions = {}
): Promise<number | null> {
  try {
    const res = await requestWithRetry(url, { ...options, retries: 1 }, 'HEAD')
    const len = res.headers.get('content-length')
    return len ? Number(len) : null
  } catch {
    return null
  }
}

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number | null
}

/** Stream a URL to disk. Returns the number of bytes written. */
export async function downloadToFile(
  url: string,
  destination: string,
  options: HttpOptions & {
    onProgress?: (p: DownloadProgress) => void
    range?: { start: number; end?: number }
    append?: boolean
  } = {}
): Promise<number> {
  assertHttpUrl(url)
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.range) {
    headers.Range = `bytes=${options.range.start}-${options.range.end ?? ''}`
  }

  const res = await requestWithRetry(url, { ...options, headers })
  const total = res.headers.get('content-length')
  const totalBytes = total ? Number(total) : null
  let received = 0

  if (!res.body) throw Errors.downloadFailed(`empty response body for ${url}`)

  const out = createWriteStream(destination, { flags: options.append ? 'a' : 'w' })
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    options.onProgress?.({ receivedBytes: received, totalBytes })
  })

  await pipeline(source, out, { signal: options.signal })
  return received
}

async function requestWithRetry(
  url: string,
  options: HttpOptions,
  method: 'GET' | 'HEAD' = 'GET'
): Promise<Response> {
  assertHttpUrl(url)
  const retries = options.retries ?? 3
  const timeoutMs = options.timeoutMs ?? 45_000
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw Errors.cancelled()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': DEFAULT_UA, ...(options.headers ?? {}) },
        signal: controller.signal,
        redirect: 'follow'
      })
      if (res.status === 401 || res.status === 403) {
        throw Errors.authRequired('the platform', `HTTP ${res.status} for ${url}`)
      }
      if (res.status === 404 || res.status === 410) {
        throw Errors.vodUnavailable(`HTTP ${res.status} for ${url}`)
      }
      if (!res.ok && res.status !== 206) {
        throw Errors.downloadFailed(`HTTP ${res.status} for ${url}`)
      }
      return res
    } catch (err) {
      lastError = err
      const isAbort =
        options.signal?.aborted === true ||
        (err instanceof Error && err.name === 'AbortError' && options.signal?.aborted)
      if (isAbort) throw Errors.cancelled()
      // Do not retry definitive failures.
      if (isDefinitive(err)) throw err
      if (attempt < retries) {
        await sleep(Math.min(8000, 500 * 2 ** attempt))
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  throw Errors.downloadFailed(
    lastError instanceof Error ? lastError.message : `request to ${url} failed`
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
