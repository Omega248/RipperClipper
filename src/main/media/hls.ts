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
  endList: boolean
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

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
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
      segments.push({
        uri: resolveUrl(line, baseUrl),
        durationSeconds: duration,
        startSeconds: round(cursor),
        endSeconds: round(cursor + duration),
        byteRange: pendingByteRange,
        discontinuity: pendingDiscontinuity,
        mapUri: currentMap
      })
      cursor += duration
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
    endList
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
