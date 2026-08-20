import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Logger } from '../../src/main/services/logger.js'
import { CacheManager } from '../../src/main/services/cache.js'
import { FfmpegService } from '../../src/main/media/ffmpeg.js'
import { RangeFetcher } from '../../src/main/media/rangeFetcher.js'
import { Exporter } from '../../src/main/media/exporter.js'
import { ExportQueue } from '../../src/main/services/queue.js'
import { ProjectStore } from '../../src/main/services/projects.js'
import { addClip, reorderClips } from '../../src/shared/clips.js'
import { formatTimecode } from '../../src/shared/time.js'
import { DEFAULT_EXPORT_SETTINGS } from '../../src/shared/defaults.js'
import type { SelectedStreams } from '../../src/main/media/formats.js'
import type { ExportJob, ProjectFile, StreamInfo, VodSource } from '../../src/shared/types.js'
import { CHUNKS, TOTAL_SECONDS, buildFixture, chunkIndexAt, sampleColor, sampleFrequency } from '../helpers/mediaFixture.js'
import { startMediaServer } from '../helpers/mediaServer.js'
import type { MediaServer } from '../helpers/mediaServer.js'

/**
 * The full workflow from the specification, run against real media:
 *
 *   load VOD → create three named ranges → reorder → save project →
 *   "close" the app → reopen the project → verify the selections →
 *   export → verify the files play, with video, audio and A/V sync.
 *
 * A machine-readable report of the produced files is written to
 * tests/.artifacts/workflow-report.md.
 */

let root: string
let log: Logger
let ffmpeg: FfmpegService
let exporter: Exporter
let server: MediaServer
let projects: ProjectStore
let outDir: string
let sourceSizeBytes = 0
const reportLines: string[] = []

const SOURCE: VodSource = {
  id: 'test:workflow',
  platform: 'twitch',
  vodId: 'workflow',
  url: 'https://example.invalid/videos/workflow',
  title: 'Escape From Tarkov — Ranked Session',
  creator: 'StreamerName',
  durationSeconds: TOTAL_SECONDS,
  createdAt: '2026-08-17T09:00:00.000Z',
  playbackKind: 'hls',
  capabilities: { metadata: true, playback: true, rangeDownload: true, requiresAuth: false, notes: [] },
  formatsInspected: true
}

function streams(): SelectedStreams {
  const video: StreamInfo = {
    id: 'chunked',
    container: 'ts',
    codec: 'avc1.42c01e',
    width: 640,
    height: 360,
    fps: 30,
    bitrate: 1_200_000,
    protocol: 'hls',
    label: '360p',
    url: `${server.url}/hls/master.m3u8`,
    hasVideo: true,
    hasAudio: true
  }
  return { video, audio: null, muxed: true, notes: [] }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cookieclip-workflow-'))
  outDir = join(root, 'Videos', 'Ripper Clipper')
  log = new Logger(join(root, 'logs'))
  ffmpeg = new FfmpegService(log)
  const info = await ffmpeg.detect({})
  if (!info.available) throw new Error('FFmpeg is required to run the workflow test')

  const fixture = await buildFixture(root)
  sourceSizeBytes = (await stat(fixture.sourceMp4)).size
  server = await startMediaServer(fixture.root)

  const cache = new CacheManager(log, join(root, 'cache'), 256 * 1024 * 1024)
  await cache.ensure()
  exporter = new Exporter(log, ffmpeg, new RangeFetcher(log, ffmpeg, cache, join(root, 'work')))
  projects = new ProjectStore(log, join(root, 'state'))
}, 300_000)

afterAll(async () => {
  await server?.close()
  if (reportLines.length > 0) {
    const dir = resolve('tests/.artifacts')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'workflow-report.md'), reportLines.join('\n'), 'utf8')
  }
  await log?.close()
  await rm(root, { recursive: true, force: true })
})

describe('complete workflow', () => {
  const projectPath = () => join(root, 'My Stream Highlights.cookieclip')

  it('creates, names, reorders and saves three ranges', async () => {
    let project: ProjectFile = { ...projects.createProject('My Stream Highlights'), sources: [SOURCE] }

    project = {
      ...project,
      clips: addClip(
        addClip(
          addClip(
            [],
            { name: 'Funny Death', sourceId: SOURCE.id, startSeconds: 12.5, endSeconds: 19.25 },
            SOURCE.durationSeconds
          ),
          { name: 'Insane Tarkov Fight', sourceId: SOURCE.id, startSeconds: 44, endSeconds: 51.5 },
          SOURCE.durationSeconds
        ),
        { name: 'Final Reaction', sourceId: SOURCE.id, startSeconds: 101, endSeconds: 108 },
        SOURCE.durationSeconds
      )
    }

    expect(project.clips.map((c) => c.name)).toEqual([
      'Funny Death',
      'Insane Tarkov Fight',
      'Final Reaction'
    ])

    // Reorder non-chronologically: 3, 1, 2.
    project = { ...project, clips: reorderClips(project.clips, 2, 0) }
    expect(project.clips.map((c) => c.name)).toEqual([
      'Final Reaction',
      'Funny Death',
      'Insane Tarkov Fight'
    ])

    await projects.save(project, projectPath())
    const size = await stat(projectPath())
    expect(size.size).toBeGreaterThan(0)
    // The project stays lightweight: it references the VOD, it does not embed it.
    expect(size.size).toBeLessThan(sourceSizeBytes / 100)
  })

  it('reopens the project with every selection intact', async () => {
    const reopened = await projects.open(projectPath())
    expect(reopened.name).toBe('My Stream Highlights')
    expect(reopened.sources[0].url).toBe(SOURCE.url)
    expect(reopened.clips.map((c) => c.name)).toEqual([
      'Final Reaction',
      'Funny Death',
      'Insane Tarkov Fight'
    ])
    expect(reopened.clips.map((c) => c.startSeconds)).toEqual([101, 12.5, 44])
    expect(reopened.clips.map((c) => c.order)).toEqual([0, 1, 2])
    expect(reopened.clips[0].durationSeconds).toBe(7)
  })

  it('exports the reopened selections and produces playable files', async () => {
    const project = await projects.open(projectPath())
    const queue = new ExportQueue(log, exporter, join(root, 'queue-work'))
    queue.setConcurrency(2)

    await queue.enqueue({
      source: project.sources[0],
      clips: project.clips.map((c) => ({
        id: c.id,
        name: c.name,
        startSeconds: c.startSeconds,
        endSeconds: c.endSeconds
      })),
      streams: streams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'smart', keyframeToleranceSeconds: 0.5 },
      outputDirectory: outDir
    })

    const jobs = await waitFor(queue)
    expect(jobs.map((j) => j.progress.stage)).toEqual(['complete', 'complete', 'complete'])

    reportLines.push('# Ripper Clipper — end-to-end workflow report', '')
    reportLines.push(`Source: locally generated ${TOTAL_SECONDS}s HLS VOD (${server.url}/hls/master.m3u8)`)
    reportLines.push(`Source file size: ${sourceSizeBytes} bytes`, '')
    reportLines.push('| # | Clip | Range | File | Size | Duration | Video | Audio | A/V skew |')
    reportLines.push('|---|------|-------|------|------|----------|-------|-------|----------|')

    const files = await readdir(outDir)
    // Every export carries the streamer and the date after the clip's own name.
    expect(files.sort().map((f) => f.replace(/ - .*$/, ''))).toEqual(
      ['Final Reaction', 'Funny Death', 'Insane Tarkov Fight'].sort()
    )
    expect(files.every((f) => / - .+ - \d{4}-\d{2}-\d{2}\.mp4$/.test(f))).toBe(true)

    for (const [index, job] of jobs.entries()) {
      const clip = project.clips[index]
      const v = job.verification!

      expect(v.ok).toBe(true)
      expect(v.sizeBytes).toBeGreaterThan(1000)
      expect(v.video.present).toBe(true)
      expect(v.audio.present).toBe(true)
      expect(v.avSkewSeconds ?? 0).toBeLessThan(0.35)
      expect(v.durationSeconds).toBeGreaterThan(clip.durationSeconds - 0.5)

      // The exported media really is the requested part of the VOD.
      const rgb = await sampleColor(job.outputPath!, 0.3)
      const expectedChunk = CHUNKS[chunkIndexAt(clip.startSeconds + 0.3)]
      const distance = Math.sqrt(
        (rgb[0] - expectedChunk.rgb[0]) ** 2 +
          (rgb[1] - expectedChunk.rgb[1]) ** 2 +
          (rgb[2] - expectedChunk.rgb[2]) ** 2
      )
      expect(distance, `${clip.name} first frame colour`).toBeLessThan(60)
      expect(await sampleFrequency(job.outputPath!, 0.2)).toBe(expectedChunk.freq)

      reportLines.push(
        `| ${index + 1} | ${clip.name} | ${formatTimecode(clip.startSeconds)} → ${formatTimecode(clip.endSeconds)} | ` +
          `${job.outputPath!.split(/[\\/]/).pop()} | ${v.sizeBytes} B | ${v.durationSeconds.toFixed(3)}s | ` +
          `${v.video.codec} ${v.video.width}×${v.video.height} @${Math.round(v.video.fps ?? 0)} | ` +
          `${v.audio.codec} ${v.audio.sampleRate} Hz ${v.audio.channels}ch | ` +
          `${(v.avSkewSeconds ?? 0).toFixed(3)}s |`
      )
    }

    const downloaded = server.bytesServed()
    reportLines.push(
      '',
      `Total bytes served for all three clips: ${downloaded} of a ${sourceSizeBytes}-byte VOD ` +
        `(${((downloaded / sourceSizeBytes) * 100).toFixed(0)}%).`
    )
  })

  it('never overwrites an existing export', async () => {
    const project = await projects.open(projectPath())
    const queue = new ExportQueue(log, exporter, join(root, 'queue-work-2'))
    await queue.enqueue({
      source: project.sources[0],
      clips: [
        {
          id: project.clips[0].id,
          name: project.clips[0].name,
          startSeconds: project.clips[0].startSeconds,
          endSeconds: project.clips[0].endSeconds
        }
      ],
      streams: streams(),
      settings: { ...DEFAULT_EXPORT_SETTINGS, cutMode: 'copy' },
      outputDirectory: outDir
    })
    const jobs = await waitFor(queue)
    expect(jobs[0].progress.stage).toBe('complete')
    // The first export of this clip already exists, so the second is given a
    // suffix rather than replacing it.
    expect(jobs[0].outputPath!).toMatch(/Final Reaction - .+ \(2\)\.mp4$/)

    const files = await readdir(outDir)
    const reactions = files.filter((f) => f.startsWith('Final Reaction'))
    expect(reactions).toHaveLength(2)
    expect(reactions.some((f) => / \(2\)\.mp4$/.test(f))).toBe(true)
  })
})

async function waitFor(queue: ExportQueue): Promise<ExportJob[]> {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const jobs = queue.list()
    if (
      jobs.length > 0 &&
      jobs.every((j) => ['complete', 'failed', 'cancelled'].includes(j.progress.stage))
    ) {
      return jobs
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('queue did not finish in time')
}
