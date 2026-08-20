/**
 * What the media URL actually answers, in words the editor can act on.
 * Exported so the diagnosis can be unit tested against a stub fetch.
 */
export async function describeSource(
  url: string,
  doFetch: typeof fetch = fetch
): Promise<string> {
  try {
    const response = await doFetch(url, { headers: { range: 'bytes=0-1' } })
    if (response.status === 403 || response.status === 401) {
      return 'The platform refused the request for the media itself (HTTP ' +
        `${response.status}) — the stream address has usually expired. Load the VOD again.`
    }
    if (response.status === 404 || response.status === 410) {
      return `The media is no longer at that address (HTTP ${response.status}).`
    }
    if (response.status >= 500) {
      return `The platform's media server answered HTTP ${response.status}.`
    }
    const type = response.headers.get('content-type') ?? 'an unknown type'
    if (/text\/html/i.test(type)) {
      return 'The platform returned a web page instead of media, which usually means it wants a sign-in.'
    }
    return `The media loaded (HTTP ${response.status}, ${type}) but this build cannot decode it. Export is unaffected — it uses FFmpeg, not the browser player.`
  } catch (err) {
    return `The media request did not complete: ${err instanceof Error ? err.message : String(err)}.`
  }
}
