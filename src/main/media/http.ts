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

export async function fetchText(url: string, options: HttpOptions = {}): Promise<string> {
  const res = await requestWithRetry(url, options)
  return res.text()
}

export async function fetchBuffer(url: string, options: HttpOptions = {}): Promise<Buffer> {
  const res = await requestWithRetry(url, options)
  return Buffer.from(await res.arrayBuffer())
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
      if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code: string }).code
        if (code === 'auth-required' || code === 'vod-unavailable' || code === 'invalid-url') {
          throw err
        }
      }
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
