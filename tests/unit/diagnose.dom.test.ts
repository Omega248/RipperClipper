import { describe, expect, it } from 'vitest'
import { describeSource } from '../../src/renderer/src/player/diagnose.js'

/**
 * "Src not supported" is what the browser says for an expired signed URL, a
 * sign-in page and a genuinely undecodable file alike. These assertions keep
 * the three apart, because the fix differs for each.
 */

function reply(status: number, contentType = 'video/mp4'): typeof fetch {
  return (async () =>
    new Response(null, { status, headers: { 'content-type': contentType } })) as typeof fetch
}

describe('preview failure diagnosis', () => {
  it('calls out an expired or refused media URL', async () => {
    const text = await describeSource('http://x/y', reply(403))
    expect(text).toMatch(/refused/i)
    expect(text).toMatch(/403/)
  })

  it('calls out media that has gone', async () => {
    expect(await describeSource('http://x/y', reply(404))).toMatch(/no longer at that address/i)
  })

  it('recognises a sign-in page served instead of media', async () => {
    const text = await describeSource('http://x/y', reply(200, 'text/html; charset=utf-8'))
    expect(text).toMatch(/web page/i)
  })

  it('says the file is undecodable only when it really did arrive', async () => {
    const text = await describeSource('http://x/y', reply(206, 'video/webm'))
    expect(text).toMatch(/cannot decode/i)
    expect(text).toMatch(/Export is unaffected/i)
  })

  it('reports a dead connection rather than blaming the format', async () => {
    const failing = (async () => {
      throw new Error('net::ERR_CONNECTION_RESET')
    }) as typeof fetch
    expect(await describeSource('http://x/y', failing)).toMatch(/ERR_CONNECTION_RESET/)
  })
})
