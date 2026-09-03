/**
 * Minimal, dependency-free HLS parsing focused on what a range extractor needs:
 * the segment timeline of a media playlist, and the variants of a master playlist.
 *
 * Pure functions — unit tested without network access.
 */

export interface HlsVariant {
  uri: string
  bandwidth: number
  averageBandwidth?: number
  width?: number
  height?: number
  frameRate?: number
  codecs?: string
  name?: string
  audioGroup?: string
}

export interface HlsMedia {
  type: string
  groupId: string
  name: string
  uri?: string
  isDefault: boolean
  channels?: number
}

export interface HlsMasterPlaylist {
  kind: 'master'
  variants: HlsVariant[]
  media: HlsMedia[]
}

export interface HlsSegment {
  uri: string
  durationSeconds: number
  /**
   * This segment's media sequence number.
   *
   * The only stable identity a segment has across playlist refreshes. A live
   * playlist is a sliding window: the same media moves down it and
   * `startSeconds` is recomputed from the new first segment every poll, so
   * comparing positions or times across two fetches identifies the wrong
   * media. Sequence numbers do not move.
   */
  sequence: number
  /**
   * Wall-clock time of this segment's first frame, from #EXT-X-PROGRAM-DATE-TIME,
   * in epoch seconds. This is what maps live media onto the event clock — see
   * shared/live.ts. Absent on playlists that do not carry the tag.
   */
  programDateTime?: number
  /** Start time of this segment within the playlist timeline. */
  startSeconds: number
  endSeconds: number
  byteRange?: { length: number; offset: number }
  discontinuity: boolean
  /** #EXT-X-MAP init segment that applies to this segment, if any. */
  mapUri?: string
}

export interface HlsMediaPlaylist {
  kind: 'media'
  targetDuration: number
  totalDurationSeconds: number
  segments: HlsSegment[]
  /**
   * `#EXT-X-ENDLIST` is present: the broadcast is over and this playlist will
   * not grow again. Its absence is what makes a playlist live.
   */
  endList: boolean
  /** #EXT-X-MEDIA-SEQUENCE, the sequence number of the first segment listed. */
  mediaSequence: number
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist

export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text)
}

export function parsePlaylist(text: string, baseUrl: string): HlsPlaylist {
  return isMasterPlaylist(text) ? parseMaster(text, baseUrl) : parseMedia(text, baseUrl)
}

export function parseMaster(text: string, baseUrl: string): HlsMasterPlaylist {
  const lines = splitLines(text)
  const variants: HlsVariant[] = []
  const media: HlsMedia[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length))
      media.push({
        type: attrs.TYPE ?? 'UNKNOWN',
        groupId: attrs['GROUP-ID'] ?? '',
        name: attrs.NAME ?? '',
        uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : undefined,
        isDefault: (attrs.DEFAULT ?? 'NO').toUpperCase() === 'YES',
        channels: attrs.CHANNELS ? Number(attrs.CHANNELS.split('/')[0]) : undefined
      })
      continue
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue

    const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length))
    // The URI is the next non-comment line.
    let uri: string | null = null
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].startsWith('#')) continue
      uri = lines[j]
      i = j
      break
    }
    if (!uri) continue

    const resolution = attrs.RESOLUTION?.split('x')
    variants.push({
      uri: resolveUrl(uri, baseUrl),
      bandwidth: Number(attrs.BANDWIDTH ?? 0),
      averageBandwidth: attrs['AVERAGE-BANDWIDTH']
        ? Number(attrs['AVERAGE-BANDWIDTH'])
        : undefined,
      width: resolution ? Number(resolution[0]) : undefined,
      height: resolution ? Number(resolution[1]) : undefined,
      frameRate: attrs['FRAME-RATE'] ? Number(attrs['FRAME-RATE']) : undefined,
      codecs: attrs.CODECS,
      name: attrs.NAME ?? attrs.VIDEO,
      audioGroup: attrs.AUDIO
    })
  }

  return { kind: 'master', variants, media }
}

export function parseMedia(text: string, baseUrl: string): HlsMediaPlaylist {
  const lines = splitLines(text)
  const segments: HlsSegment[] = []
  let targetDuration = 0
  let pendingDuration: number | null = null
  let pendingByteRange: { length: number; offset: number } | undefined
  let pendingDiscontinuity = false
  let currentMap: string | undefined
  let cursor = 0
  let endList = false
  let lastByteEnd = 0
  let mediaSequence = 0
  let sequence: number | null = null
  // Carried forward: PROGRAM-DATE-TIME is usually stamped once and every
  // following segment's time is implied by the durations since.
  let clock: number | undefined

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0
      if (sequence === null) sequence = mediaSequence
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const ms = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim())
      // A re-stamp resets the clock; drift between the stamp and the
      // accumulated durations is the platform's, and the stamp is the one to
      // believe.
      if (!Number.isNaN(ms)) clock = ms / 1000
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0
    } else if (line.startsWith('#EXTINF:')) {
      const value = line.slice('#EXTINF:'.length).split(',')[0]
      pendingDuration = Number(value)
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const raw = line.slice('#EXT-X-BYTERANGE:'.length)
      const [lenStr, offStr] = raw.split('@')
      const length = Number(lenStr)
      const offset = offStr === undefined ? lastByteEnd : Number(offStr)
      pendingByteRange = { length, offset }
      lastByteEnd = offset + length
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length))
      currentMap = attrs.URI ? resolveUrl(attrs.URI, baseUrl) : undefined
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true
    } else if (!line.startsWith('#')) {
      const duration = pendingDuration ?? 0
      if (sequence === null) sequence = mediaSequence
      segments.push({
        uri: resolveUrl(line, baseUrl),
        durationSeconds: duration,
        startSeconds: round(cursor),
        endSeconds: round(cursor + duration),
        sequence,
        programDateTime: clock === undefined ? undefined : round(clock),
        byteRange: pendingByteRange,
        discontinuity: pendingDiscontinuity,
        mapUri: currentMap
      })
      cursor += duration
      if (clock !== undefined) clock += duration
      sequence += 1
      pendingDuration = null
      pendingByteRange = undefined
      pendingDiscontinuity = false
    }
  }

  return {
    kind: 'media',
    targetDuration,
    totalDurationSeconds: round(cursor),
    segments,
    endList,
    mediaSequence
  }
}

export interface SegmentSelection {
  segments: HlsSegment[]
  /** Timeline start of the first selected segment. */
  windowStartSeconds: number
  windowEndSeconds: number
  /** Offset of the requested start within the concatenated selection. */
  offsetSeconds: number
  totalDurationSeconds: number
  mapUri?: string
}

/**
 * Select exactly the segments that cover [startSeconds, endSeconds].
 *
 * `paddingSeconds` extends the window on both sides so that keyframe-aligned
 * cutting still has material to work with — it never pulls the whole VOD.
 */
export function selectSegments(
  playlist: HlsMediaPlaylist,
  startSeconds: number,
  endSeconds: number,
  paddingSeconds = 0
): SegmentSelection {
  if (playlist.segments.length === 0) {
    return {
      segments: [],
      windowStartSeconds: 0,
      windowEndSeconds: 0,
      offsetSeconds: 0,
      totalDurationSeconds: 0
    }
  }
  const from = Math.max(0, startSeconds - paddingSeconds)
  const to = endSeconds + paddingSeconds

  const selected = playlist.segments.filter(
    (seg) => seg.endSeconds > from + 1e-6 && seg.startSeconds < to - 1e-6
  )

  if (selected.length === 0) {
    // Range sits past the end of the playlist: fall back to the final segment.
    const last = playlist.segments[playlist.segments.length - 1]
    return {
      segments: [last],
      windowStartSeconds: last.startSeconds,
      windowEndSeconds: last.endSeconds,
      offsetSeconds: Math.max(0, startSeconds - last.startSeconds),
      totalDurationSeconds: last.durationSeconds,
      mapUri: last.mapUri
    }
  }

  const windowStart = selected[0].startSeconds
  const windowEnd = selected[selected.length - 1].endSeconds
  return {
    segments: selected,
    windowStartSeconds: windowStart,
    windowEndSeconds: windowEnd,
    offsetSeconds: round(Math.max(0, startSeconds - windowStart)),
    totalDurationSeconds: round(windowEnd - windowStart),
    mapUri: selected[0].mapUri
  }
}

/** Rank variants best-first: resolution, then frame rate, then bandwidth. */
/**
 * A label a person would recognise for a variant.
 *
 * A variant's own NAME is preferred, but Twitch does not put one on
 * `EXT-X-STREAM-INF` at all — it names the *media group* instead, so the
 * parser's `NAME ?? VIDEO` fallback yields the group id and the source
 * rendition ends up labelled "chunked". The human name is right there on the
 * matching `EXT-X-MEDIA` line, and joining them by group id is what turns
 * "chunked" back into "1080p60" in a quality picker.
 *
 * Falls through to the resolution when neither says anything useful.
 */
/**
 * How long the recording actually is, according to the media itself.
 *
 * Platforms report a duration and sometimes that duration is a lie. Kick
 * returns `duration: 0` for a broadcast it has not finished processing —
 * measured on a 1.11-hour VOD that was complete, public, and carried
 * `#EXT-X-ENDLIST`. The app believed the zero, and a zero-length POV is not a
 * degraded POV: it has no span on the timeline, no coverage row, no window to
 * sync against, and the decoder gives up on it. One angle of a two-angle event
 * simply did not work.
 *
 * The playlist has always known. Summing `#EXTINF` is what `parseMedia`
 * already does; this only picks a variant to ask.
 *
 * The cheapest rendition, because every variant lists the same segments and
 * only the duration is wanted — there is no reason to pull the 1080p60 index
 * to count its rows.
 *
 * For a playlist still growing the sum is what has been published so far,
 * which is the same thing `durationSeconds` already means for a live source:
 * a floor that moves, not a length.
 */
export async function durationFromPlaylist(
  variants: HlsVariant[],
  fetchText: (url: string) => Promise<string>
): Promise<number | undefined> {
  const cheapest = variants
    .filter((v) => v.uri)
    .sort((a, b) => (a.bandwidth || Infinity) - (b.bandwidth || Infinity))[0]
  if (!cheapest) return undefined
  try {
    const media = parseMedia(await fetchText(cheapest.uri), cheapest.uri)
    return media.totalDurationSeconds > 0 ? media.totalDurationSeconds : undefined
  } catch {
    // A duration we could not confirm is not worth failing a resolve over —
    // the caller keeps whatever the platform said, including zero.
    return undefined
  }
}

export function variantLabel(variant: HlsVariant, media: HlsMedia[]): string | undefined {
  const named = media.find((m) => m.groupId === variant.name && m.name.trim() !== '')
  if (named) return named.name
  if (variant.name && variant.name.trim() !== '') return variant.name
  if (variant.height) return variant.frameRate && variant.frameRate > 31
    ? `${variant.height}p${Math.round(variant.frameRate)}`
    : `${variant.height}p`
  return undefined
}

/**
 * The video (or audio) codec out of an HLS `CODECS` attribute.
 *
 * Lives here rather than in each platform because the attribute is HLS's, not
 * the platform's — it was copied into two adapters before this.
 */
export function firstCodec(codecs: string | undefined, kind: 'video' | 'audio'): string | undefined {
  if (!codecs) return undefined
  const parts = codecs.split(',').map((c) => c.trim()).filter(Boolean)
  const isAudio = (c: string): boolean => /^(mp4a|opus|ac-3|ec-3|vorbis)/i.test(c)
  return parts.find((c) => (kind === 'audio' ? isAudio(c) : !isAudio(c)))
}

export function sortVariants(variants: HlsVariant[]): HlsVariant[] {
  return [...variants].sort((a, b) => {
    const areaA = (a.width ?? 0) * (a.height ?? 0)
    const areaB = (b.width ?? 0) * (b.height ?? 0)
    if (areaA !== areaB) return areaB - areaA
    const fpsA = a.frameRate ?? 0
    const fpsB = b.frameRate ?? 0
    if (fpsA !== fpsB) return fpsB - fpsA
    return (b.averageBandwidth ?? b.bandwidth) - (a.averageBandwidth ?? a.bandwidth)
  })
}

export function resolveUrl(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).toString()
  } catch {
    return uri
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {}
  // KEY=VALUE or KEY="VALUE", comma separated, commas allowed inside quotes.
  const re = /([A-Za-z0-9-]+)=("([^"]*)"|[^,]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    out[match[1]] = match[3] !== undefined ? match[3] : match[2]
  }
  return out
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
