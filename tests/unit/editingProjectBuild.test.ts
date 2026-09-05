import { describe, expect, it } from 'vitest'
import { buildEditingProject, trackName, watermarkTransform } from '../../src/shared/buildEditingProject.js'
import type { ExportedMedia } from '../../src/shared/buildEditingProject.js'
import { defaultWatermark } from '../../src/shared/watermark.js'
import type { ClipSegment, VodSource } from '../../src/shared/types.js'

function source(id: string, creator: string, platform: 'twitch' | 'kick' | 'youtube'): VodSource {
  return {
    id,
    platform,
    vodId: `v_${id}`,
    url: `https://example.test/${id}`,
    title: `${creator} broadcast`,
    creator,
    durationSeconds: 4 * 3600,
    playbackKind: 'hls',
    capabilities: { download: true, seek: true, metadata: true }
  } as unknown as VodSource
}

function media(sourceId: string, clipId: string, seconds: number): ExportedMedia {
  return {
    sourceId,
    clipId,
    path: `C:/Exports/${sourceId}.mp4`,
    fileName: `${sourceId}.mp4`,
    durationSeconds: seconds,
    width: 1920,
    height: 1080,
    fps: 60
  }
}

function clip(mappings: ClipSegment['povMappings']): ClipSegment {
  return {
    id: 'clip_1',
    name: 'Insane fight',
    sourceId: 'a',
    startSeconds: 100,
    endSeconds: 160,
    durationSeconds: 60,
    order: 0,
    status: 'idle',
    createdAt: '2026-09-02T00:00:00.000Z',
    povMappings: mappings
  } as unknown as ClipSegment
}

const mapping = (
  sourceId: string,
  requested: number,
  vodStart: number,
  vodEnd: number,
  authored = false
): NonNullable<ClipSegment['povMappings']>[number] =>
  ({
    sourceId,
    vodStartSeconds: vodStart,
    vodEndSeconds: vodEnd,
    requestedStartSeconds: requested,
    requestedEndSeconds: requested + 60,
    status: 'found',
    confidence: 0.9,
    method: 'metadata',
    authored,
    updatedAt: '2026-09-02T00:00:00.000Z'
  }) as unknown as NonNullable<ClipSegment['povMappings']>[number]

describe('building an editing project', () => {
  const sources = [source('a', 'MissBombastic', 'twitch'), source('b', 'NinjaJessica', 'kick')]

  it('names tracks after the person, not "Video 1"', () => {
    expect(trackName(sources[0])).toBe('POV | Twitch | MissBombastic')
    expect(trackName(sources[1])).toBe('POV | Kick | NinjaJessica')
  })

  it('puts every angle on its own track at the same instant', () => {
    const built = buildEditingProject({
      projectId: 'p1',
      projectName: 'Bank job',
      applicationVersion: '1.0.0',
      clip: clip([mapping('a', 100, 100, 160, true), mapping('b', 940, 940, 1000)]),
      sources,
      media: [media('a', 'clip_1', 60), media('b', 'clip_1', 60)],
      markers: [],
      watermark: null,
      timeline: { width: 1920, height: 1080, fps: 60 }
    })

    expect(built.timeline.tracks.map((t) => t.name)).toEqual([
      'POV | Twitch | MissBombastic',
      'POV | Kick | NinjaJessica'
    ])
    // Both angles cover the whole moment, so both start at zero: that is what
    // "already synchronised" means when it reaches the editor.
    for (const track of built.timeline.tracks) {
      expect(track.clips[0].timelineStartSeconds).toBe(0)
    }
    expect(built.povs.find((p) => p.streamerName === 'NinjaJessica')?.syncOffsetSeconds).toBe(840)
  })

  it('places a late angle late, rather than at zero', () => {
    // This POV started rolling 12s after the moment began: its file is short,
    // and it belongs 12s into the timeline. Laying it at zero is the bug.
    const built = buildEditingProject({
      projectId: 'p1',
      projectName: 'Bank job',
      applicationVersion: '1.0.0',
      clip: clip([mapping('a', 100, 100, 160, true), mapping('b', 940, 952, 1000)]),
      sources,
      media: [media('a', 'clip_1', 60), media('b', 'clip_1', 48)],
      markers: [],
      watermark: null,
      timeline: { width: 1920, height: 1080, fps: 60 }
    })

    const late = built.timeline.tracks.find((t) => t.name.includes('NinjaJessica'))!
    expect(late.clips[0].timelineStartSeconds).toBe(12)
    expect(late.clips[0].timelineEndSeconds).toBe(60)
  })

  it('adds one watermark overlay, not one per angle', () => {
    const built = buildEditingProject({
      projectId: 'p1',
      projectName: 'Bank job',
      applicationVersion: '1.0.0',
      clip: clip([mapping('a', 100, 100, 160, true), mapping('b', 940, 940, 1000)]),
      sources,
      media: [media('a', 'clip_1', 60), media('b', 'clip_1', 60)],
      markers: [],
      watermark: {
        config: { ...defaultWatermark('img'), width: 0.12 },
        assetPath: 'C:/Assets/badge.png',
        assetName: 'badge.png',
        imageWidth: 400,
        imageHeight: 100
      },
      timeline: { width: 1920, height: 1080, fps: 60 }
    })

    const overlays = built.timeline.tracks.filter((t) => t.type === 'overlay')
    expect(overlays).toHaveLength(1)
    expect(overlays[0].clips[0].timelineEndSeconds).toBe(60)
    expect(built.watermark?.transform.width).toBeCloseTo(0.12, 5)
  })

  it('never modifies or invents a media path', () => {
    const built = buildEditingProject({
      projectId: 'p1',
      projectName: 'Bank job',
      applicationVersion: '1.0.0',
      clip: clip([mapping('a', 100, 100, 160, true)]),
      sources,
      media: [media('a', 'clip_1', 60)],
      markers: [],
      watermark: null,
      timeline: { width: 1920, height: 1080, fps: 60 }
    })
    expect(built.media[0].path).toBe('C:/Exports/a.mp4')
  })

  it('leaves out an angle that produced no file', () => {
    const built = buildEditingProject({
      projectId: 'p1',
      projectName: 'Bank job',
      applicationVersion: '1.0.0',
      clip: clip([mapping('a', 100, 100, 160, true), mapping('b', 940, 940, 1000)]),
      sources,
      media: [media('a', 'clip_1', 60)],
      markers: [],
      watermark: null,
      timeline: { width: 1920, height: 1080, fps: 60 }
    })
    // An empty track reads as a missing file in an editor, which is worse than
    // an angle that is simply not there.
    expect(built.timeline.tracks).toHaveLength(1)
    expect(built.povs).toHaveLength(1)
  })
})

describe('the watermark as a fraction of the frame', () => {
  const config = { ...defaultWatermark('img'), width: 0.12 }

  it('lands in the same place at any resolution', () => {
    const hd = watermarkTransform(config, { width: 1920, height: 1080 }, { width: 400, height: 100 })
    const uhd = watermarkTransform(config, { width: 3840, height: 2160 }, { width: 400, height: 100 })

    expect(uhd.x).toBeCloseTo(hd.x, 5)
    expect(uhd.y).toBeCloseTo(hd.y, 5)
    expect(uhd.width).toBeCloseTo(hd.width, 5)
    expect(uhd.height).toBeCloseTo(hd.height, 5)
  })

  it('keeps the image proportions', () => {
    const t = watermarkTransform(config, { width: 1920, height: 1080 }, { width: 400, height: 100 })
    const pixelWidth = t.width * 1920
    const pixelHeight = t.height * 1080
    expect(pixelWidth / pixelHeight).toBeCloseTo(4, 1)
  })

  it('carries opacity and rotation through unchanged', () => {
    const t = watermarkTransform(
      { ...config, opacity: 0.85, rotation: 12 },
      { width: 1920, height: 1080 },
      { width: 400, height: 100 }
    )
    expect(t.opacity).toBe(0.85)
    expect(t.rotation).toBe(12)
  })
})
