import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEditingProject } from '../../src/shared/buildEditingProject.js'
import type { ExportedMedia } from '../../src/shared/buildEditingProject.js'
import { defaultWatermark } from '../../src/shared/watermark.js'
import type { ClipSegment, VodSource } from '../../src/shared/types.js'
import { GenericExporter } from '../../src/main/export/genericExporter.js'
import { ResolveExporter, resolveTransform, py } from '../../src/main/export/resolveExporter.js'
import { FcpxmlExporter, fcpTransform, fileUrl } from '../../src/main/export/fcpxmlExporter.js'
import { freeDirectory } from '../../src/main/export/projectExporters.js'

/**
 * The acceptance criterion this whole subsystem exists to meet: a project is
 * paths, numbers and a small PNG. Twenty four-hour angles have to cost what
 * two ten-minute angles cost, because neither reads a frame of video.
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cookieclip-export-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(angles: number, hoursEach: number, root: string) {
  const sources: VodSource[] = []
  const media: ExportedMedia[] = []
  const mappings: NonNullable<ClipSegment['povMappings']> = []
  const seconds = hoursEach * 3600

  for (let i = 0; i < angles; i++) {
    const id = `s${i}`
    sources.push({
      id,
      platform: i % 2 === 0 ? 'twitch' : 'kick',
      vodId: `v${i}`,
      url: `https://example.test/${i}`,
      title: `Angle ${i}`,
      creator: `Streamer${i}`,
      durationSeconds: seconds,
      playbackKind: 'hls',
      capabilities: { download: true, seek: true, metadata: true }
    } as unknown as VodSource)

    // A real file, but a tiny one: what is being measured is whether the
    // exporter opens it, and a byte is enough to prove it does not.
    const path = join(root, `${id}.mp4`)
    await writeFile(path, 'x')
    media.push({
      sourceId: id,
      clipId: 'clip_1',
      path,
      fileName: `${id}.mp4`,
      durationSeconds: seconds,
      width: i % 3 === 0 ? 2560 : 1920,
      height: i % 3 === 0 ? 1440 : 1080,
      fps: 60
    })
    mappings.push({
      sourceId: id,
      vodStartSeconds: 100 + i,
      vodEndSeconds: 100 + i + seconds,
      requestedStartSeconds: 100 + i,
      requestedEndSeconds: 100 + i + seconds,
      status: 'found',
      confidence: 0.9,
      method: 'metadata',
      authored: i === 0,
      updatedAt: '2026-09-02T00:00:00.000Z'
    } as unknown as NonNullable<ClipSegment['povMappings']>[number])
  }

  const badge = join(root, 'badge.png')
  await writeFile(badge, 'png')

  const clip = {
    id: 'clip_1',
    name: 'Bank job',
    sourceId: 's0',
    startSeconds: 100,
    endSeconds: 100 + seconds,
    durationSeconds: seconds,
    order: 0,
    status: 'idle',
    createdAt: '2026-09-02T00:00:00.000Z',
    povMappings: mappings
  } as unknown as ClipSegment

  return buildEditingProject({
    projectId: 'p1',
    projectName: 'Bank job',
    applicationVersion: '1.0.0',
    clip,
    sources,
    media,
    markers: [],
    watermark: {
      config: { ...defaultWatermark('img'), width: 0.12, opacity: 0.85 },
      assetPath: badge,
      assetName: 'badge.png',
      imageWidth: 400,
      imageHeight: 100
    },
    timeline: { width: 1920, height: 1080, fps: 60 }
  })
}

describe('the generic package', () => {
  it('writes the manifest, the guide and the assets, and copies no media by default', async () => {
    const project = await fixture(3, 0.5, dir)
    const out = join(dir, 'Export')
    const result = await new GenericExporter().export(project, { directory: out, copyMedia: false })

    const folders = await readdir(out)
    expect(folders).toContain('Metadata')
    expect(folders).toContain('Assets')
    expect(folders).toContain('README.html')
    // Media was referenced where it already is, not duplicated.
    expect(folders).not.toContain('Media')

    const manifest = JSON.parse(await readFile(join(out, 'Metadata', 'project.json'), 'utf8'))
    expect(manifest.povs).toHaveLength(3)
    expect(manifest.schemaVersion).toBe(1)
    expect(result.projectFile).toContain('README.html')
  })

  it('copies the media only when asked', async () => {
    const project = await fixture(2, 0.1, dir)
    const out = join(dir, 'Portable')
    await new GenericExporter().export(project, { directory: out, copyMedia: true })
    expect(await readdir(join(out, 'Media'))).toHaveLength(2)
  })

  it('states every angle and its offset in the guide', async () => {
    const project = await fixture(3, 0.5, dir)
    const out = join(dir, 'Export')
    await new GenericExporter().export(project, { directory: out, copyMedia: false })
    const html = await readFile(join(out, 'README.html'), 'utf8')
    expect(html).toContain('Streamer0')
    expect(html).toContain('Streamer2')
    expect(html).toContain('Watermark')
    expect(html).toContain('85.0%')
  })
})

describe('the Resolve adapter', () => {
  it('converts a frame fraction into Resolve pan/tilt/zoom', () => {
    // Top-right badge, 12% of a 1920 frame, from a 400px-wide image: the zoom
    // is 230/400, not 0.12 — mistaking one for the other is how a logo ends up
    // the size of a postage stamp.
    const t = resolveTransform(
      { x: 0.9, y: 0.1, width: 0.12, height: 0.0533, rotation: 0, opacity: 0.85, anchor: 'top-right' },
      { width: 1920, height: 1080 },
      { width: 230, height: 58 }
    )
    expect(t.pan).toBe(768)
    // Tilt is positive upwards — the opposite of screen coordinates.
    expect(t.tilt).toBe(432)
    expect(t.zoomX).toBeCloseTo(1, 1)
    expect(t.opacity).toBe(85)
  })

  it('escapes a Windows path safely', () => {
    /*
     * Asserted as a property rather than as exact text: what matters is that
     * every backslash survives into the literal and that no quote character
     * can end it early. These two used to pin the literal spelling, which
     * meant they passed for a `py()` that emitted raw newlines — see
     * generatedProjectEscaping.test.ts, which runs the output through Python.
     */
    const path = 'C:\\Users\\reece\\a b.mp4'
    expect(JSON.parse(py(path))).toBe(path)
    expect(JSON.parse(py("it's.mp4"))).toBe("it's.mp4")
    expect(py(path)).toContain('\\\\Users')
  })

  it('writes a script that imports every angle and positions the watermark', async () => {
    const project = await fixture(4, 0.25, dir)
    const out = join(dir, 'Resolve')
    const result = await new ResolveExporter().export(project, { directory: out, copyMedia: false })

    const script = await readFile(result.projectFile!, 'utf8')
    expect(script).toContain('CreateProject')
    expect(script).toContain('AppendToTimeline')
    expect(script).toContain("SetProperty('Opacity'")
    expect(script).toContain('POV | Twitch | Streamer0')
    for (let i = 0; i < 4; i++) expect(script).toContain(`s${i}.mp4`)
    // Four angles plus the watermark track.
    expect(script).toContain("timeline.GetTrackCount('video') < 5")
  })
})

describe('the Final Cut adapter', () => {
  it('converts a frame fraction into Final Cut position and scale', () => {
    const t = fcpTransform(
      { x: 0.9, y: 0.1, width: 0.12, height: 0.0533, rotation: 0, opacity: 0.85, anchor: 'top-right' },
      { width: 1920, height: 1080 },
      { width: 230, height: 58 }
    )
    // Percent of frame from the centre, Y positive upwards.
    expect(t.positionX).toBeCloseTo(40, 1)
    expect(t.positionY).toBeCloseTo(40, 1)
  })

  it('writes rational time and a file URL, never a decimal or a raw path', async () => {
    const project = await fixture(3, 0.25, dir)
    const out = join(dir, 'FCP')
    const result = await new FcpxmlExporter().export(project, { directory: out, copyMedia: false })
    const xml = await readFile(result.projectFile!, 'utf8')

    expect(xml).toContain('<fcpxml version="1.9">')
    expect(xml).toContain('frameDuration="1/60s"')
    expect(xml).toContain('file://')
    expect(xml).toContain('<adjust-transform')
    // Lanes are what make angles play at once instead of one after another.
    expect(xml).toContain('lane="1"')
    expect(xml).toContain('lane="2"')
    expect(xml).not.toMatch(/duration="\d+\.\d+"/)
  })

  it('escapes a name that would otherwise break the document', async () => {
    const project = await fixture(1, 0.1, dir)
    const named = { ...project, name: 'Rob & <Steal>' }
    const out = join(dir, 'FCP2')
    const result = await new FcpxmlExporter().export(named, { directory: out, copyMedia: false })
    const xml = await readFile(result.projectFile!, 'utf8')
    expect(xml).toContain('Rob &amp; &lt;Steal&gt;')
    expect(xml).not.toContain('<Steal>')
  })

  it('exports the FCPXML at a version it names', async () => {
    const project = await fixture(1, 0.1, dir)
    const result = await new FcpxmlExporter().export(project, {
      directory: join(dir, 'FCP3'),
      copyMedia: false
    })
    expect(result.notes.join(' ')).toContain('1.9')
    expect(result.notes.join(' ')).toContain('not a native Final Cut library')
  })
})

describe('twenty angles of four hours each', () => {
  it('costs what the metadata costs, not what the video costs', async () => {
    const project = await fixture(20, 4, dir)
    expect(project.povs).toHaveLength(20)
    // 80 hours of source material, described.
    expect(project.media.reduce((n, m) => n + m.durationSeconds, 0)).toBe(20 * 4 * 3600)

    const started = Date.now()
    const result = await new ResolveExporter().export(project, {
      directory: join(dir, 'Big'),
      copyMedia: false
    })
    const elapsed = Date.now() - started

    // The real assertion is not the clock — it is that the only files written
    // are text, and the only files read are none.
    expect(elapsed).toBeLessThan(5000)
    expect(result.files.every((f) => /\.(py|json|html)$/.test(f))).toBe(true)

    const script = await readFile(result.projectFile!, 'utf8')
    expect(script).toContain('s19.mp4')
    expect(script).toContain("timeline.GetTrackCount('video') < 21")
  })

  it('handles angles of different resolutions without touching them', async () => {
    const project = await fixture(6, 1, dir)
    const sizes = new Set(project.media.map((m) => `${m.width}x${m.height}`))
    expect(sizes.size).toBeGreaterThan(1)
    // Scaling is the editor's job; the model records what each angle is.
    expect(project.timeline.width).toBe(1920)
  })
})

describe('export destinations', () => {
  it('never silently overwrites an existing project folder', async () => {
    const first = await freeDirectory(dir, 'Bank job')
    expect(first).toBe(join(dir, 'Bank job'))
    await new GenericExporter().export(await fixture(1, 0.1, dir), {
      directory: first,
      copyMedia: false
    })
    const second = await freeDirectory(dir, 'Bank job')
    expect(second).toBe(join(dir, 'Bank job (2)'))
  })

  it('strips characters Windows will not accept in a folder name', async () => {
    const path = await freeDirectory(dir, 'Rob: the <bank>')
    expect(path).toBe(join(dir, 'Rob- the -bank-'))
  })
})

describe('validation', () => {
  it('refuses a project whose media has gone', async () => {
    const project = await fixture(2, 0.1, dir)
    await rm(project.media[0].path)
    const { ProjectExportService } = await import('../../src/main/export/projectExporters.js')
    const { Logger } = await import('../../src/main/services/logger.js')
    const log = new Logger(join(dir, 'logs'))
    try {
      const result = await new ProjectExportService(log).validate(project, 'resolve')
      expect(result.ok).toBe(false)
      expect(result.issues.some((i) => i.message.includes('no longer where it was exported'))).toBe(true)
    } finally {
      log.close()
    }
  })

  it('warns about mixed frame rates rather than conforming anything', async () => {
    const project = await fixture(2, 0.1, dir)
    const mixed = {
      ...project,
      media: [project.media[0], { ...project.media[1], fps: 30 }]
    }
    const result = new GenericExporter().validate(mixed)
    expect(result.ok).toBe(true)
    expect(result.issues.some((i) => i.message.includes('frame rate'))).toBe(true)
  })
})

describe('file URLs', () => {
  it('turns a path into something FCPXML can reference', () => {
    expect(fileUrl(join(dir, 'a b.mp4'))).toMatch(/^file:\/\//)
    expect(fileUrl(join(dir, 'a b.mp4'))).toContain('a%20b.mp4')
  })
})

describe('the Movavi adapter', () => {
  it('generates no project file, and says why', async () => {
    const { MovaviExporter } = await import('../../src/main/export/movaviExporter.js')
    const project = await fixture(3, 0.5, dir)
    const result = await new MovaviExporter().export(project, {
      directory: join(dir, 'Movavi'),
      copyMedia: false
    })

    // Nothing that pretends to be a .mepx.
    expect(result.files.some((f) => f.endsWith('.mepx'))).toBe(false)
    expect(result.notes.join(' ')).toContain('publishes no project format')
  })

  it('tells the truth about the angles already being in sync', async () => {
    const { MovaviExporter } = await import('../../src/main/export/movaviExporter.js')
    // Every angle covers the whole moment, so every file starts at the same
    // instant — which is the one fact that makes Movavi usable without a
    // project format.
    const project = await fixture(4, 0.5, dir)
    const result = await new MovaviExporter().export(project, {
      directory: join(dir, 'Movavi2'),
      copyMedia: false
    })
    expect(result.notes.join(' ')).toContain('dropping them all at the start')

    const csv = await readFile(join(dir, 'Movavi2', 'Editor', 'movavi-timeline.csv'), 'utf8')
    expect(csv).toContain('"Track","Angle","Platform"')
    for (const row of csv.split('\r\n').slice(1, 5)) {
      if (row.startsWith('"')) expect(row).toContain('"00:00:00:00"')
    }
  })

  it('singles out an angle that started late instead of claiming it is aligned', async () => {
    const { MovaviExporter, lateAngles } = await import('../../src/main/export/movaviExporter.js')
    const project = await fixture(3, 0.5, dir)
    // One angle's recording began 12s after the moment did.
    const shifted = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((t, i) =>
          i === 1 && t.type === 'video'
            ? { ...t, clips: [{ ...t.clips[0], timelineStartSeconds: 12 }] }
            : t
        )
      }
    }
    expect(lateAngles(shifted)).toHaveLength(1)

    const exporter = new MovaviExporter()
    expect(exporter.validate(shifted).issues.some((i) => i.message.includes('started recording after'))).toBe(true)

    const result = await exporter.export(shifted, { directory: join(dir, 'Movavi3'), copyMedia: false })
    expect(result.notes.join(' ')).toContain('2 of 3 angles line up')
  })

  it('numbers the copies so a drag-and-drop import lands in track order', async () => {
    const { MovaviExporter } = await import('../../src/main/export/movaviExporter.js')
    const project = await fixture(3, 0.1, dir)
    const out = join(dir, 'Movavi4')
    await new MovaviExporter().export(project, { directory: out, copyMedia: true })
    const files = (await readdir(join(out, 'Media'))).sort()
    expect(files[0]).toMatch(/^01 - /)
    expect(files[2]).toMatch(/^03 - /)
  })

  it('puts the watermark numbers where they can be typed in', async () => {
    const { MovaviExporter } = await import('../../src/main/export/movaviExporter.js')
    const project = await fixture(2, 0.1, dir)
    await new MovaviExporter().export(project, { directory: join(dir, 'Movavi5'), copyMedia: false })
    const csv = await readFile(join(dir, 'Movavi5', 'Editor', 'movavi-timeline.csv'), 'utf8')
    expect(csv).toContain('"Watermark","Value","Note"')
    expect(csv).toContain('"Opacity","85%"')
    expect(csv).toContain('"12.0%"')
  })
})

describe('the package is written once', () => {
  it('copies each angle exactly once, however many stages ran', async () => {
    // Every adapter prepares the package and then writes the manifest. When
    // both steps copied the media, the numbered copies came out
    // "02 - 02 - name.mp4" and every byte was written twice.
    const { MovaviExporter } = await import('../../src/main/export/movaviExporter.js')
    const project = await fixture(3, 0.1, dir)
    const out = join(dir, 'Once')
    await new MovaviExporter().export(project, { directory: out, copyMedia: true })
    const files = await readdir(join(out, 'Media'))
    expect(files).toHaveLength(3)
    expect(files.every((f) => /^\d\d - s\d\.mp4$/.test(f))).toBe(true)
  })
})
