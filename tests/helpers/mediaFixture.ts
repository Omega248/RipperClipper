import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runChecked } from '../../src/main/services/process.js'

/**
 * Builds a real, locally generated "VOD" that behaves like a platform HLS VOD:
 * 12 chunks of 10 seconds, each with a distinct solid colour and a distinct
 * audio tone. Because content is identifiable at every timestamp, a test can
 * prove that the exporter cut the *right* part of the source, not merely that
 * it produced a file of roughly the right length.
 */

export const CHUNK_SECONDS = 10
export const CHUNK_COUNT = 12
export const TOTAL_SECONDS = CHUNK_SECONDS * CHUNK_COUNT
export const FPS = 30
export const GOP_SECONDS = 2

/** RGB of each 10-second chunk, and the audio frequency that goes with it. */
export const CHUNKS = [
  { hex: '0xE00000', rgb: [224, 0, 0], freq: 220 },
  { hex: '0x00C000', rgb: [0, 192, 0], freq: 262 },
  { hex: '0x0000E0', rgb: [0, 0, 224], freq: 294 },
  { hex: '0xE0E000', rgb: [224, 224, 0], freq: 330 },
  { hex: '0xE000E0', rgb: [224, 0, 224], freq: 349 },
  { hex: '0x00E0E0', rgb: [0, 224, 224], freq: 392 },
  { hex: '0xFFFFFF', rgb: [255, 255, 255], freq: 440 },
  { hex: '0x202020', rgb: [32, 32, 32], freq: 494 },
  { hex: '0xE07000', rgb: [224, 112, 0], freq: 523 },
  { hex: '0x7000E0', rgb: [112, 0, 224], freq: 587 },
  { hex: '0x00E070', rgb: [0, 224, 112], freq: 659 },
  { hex: '0x707070', rgb: [112, 112, 112], freq: 698 }
] as const

export interface Fixture {
  root: string
  sourceMp4: string
  hlsDir: string
  masterPlaylist: string
  mediaPlaylist: string
}

export function chunkIndexAt(seconds: number): number {
  return Math.min(CHUNK_COUNT - 1, Math.max(0, Math.floor(seconds / CHUNK_SECONDS)))
}

export async function buildFixture(root: string, ffmpeg = 'ffmpeg'): Promise<Fixture> {
  const chunksDir = join(root, 'chunks')
  const hlsDir = join(root, 'hls')
  await mkdir(chunksDir, { recursive: true })
  await mkdir(hlsDir, { recursive: true })

  // One encoded file per chunk, all with identical parameters so they can be
  // concatenated with a stream copy.
  const parts: string[] = []
  for (let i = 0; i < CHUNK_COUNT; i++) {
    const chunk = CHUNKS[i]
    const out = join(chunksDir, `chunk-${String(i).padStart(2, '0')}.mp4`)
    await runChecked(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${chunk.hex}:s=640x360:r=${FPS}:d=${CHUNK_SECONDS}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${chunk.freq}:sample_rate=48000:duration=${CHUNK_SECONDS}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'stillimage',
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(FPS * GOP_SECONDS),
      '-keyint_min',
      String(FPS * GOP_SECONDS),
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      out
    ])
    parts.push(out)
  }

  const listPath = join(root, 'concat.txt')
  await writeFile(listPath, parts.map((p) => `file '${p}'`).join('\n'), 'utf8')

  const sourceMp4 = join(root, 'source.mp4')
  await runChecked(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    sourceMp4
  ])

  // Segment into HLS exactly as a platform would.
  const mediaPlaylist = join(hlsDir, 'index.m3u8')
  await runChecked(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    sourceMp4,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'vod',
    '-hls_list_size',
    '0',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    join(hlsDir, 'seg%03d.ts'),
    mediaPlaylist
  ])

  const masterPlaylist = join(hlsDir, 'master.m3u8')
  await writeFile(
    masterPlaylist,
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360,FRAME-RATE=${FPS}.000,CODECS="avc1.42c01e,mp4a.40.2"`,
      'index.m3u8',
      ''
    ].join('\n'),
    'utf8'
  )

  return { root, sourceMp4, hlsDir, masterPlaylist, mediaPlaylist }
}

/** Average RGB of the frame at `atSeconds` inside a local media file. */
export async function sampleColor(
  file: string,
  atSeconds: number,
  ffmpeg = 'ffmpeg'
): Promise<[number, number, number]> {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        'scale=1:1',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const buffers: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => buffers.push(b))
    let stderr = ''
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
    child.on('error', reject)
    child.on('close', () => {
      const data = Buffer.concat(buffers)
      if (data.length < 3) {
        reject(new Error(`no frame decoded at ${atSeconds}s from ${file}: ${stderr}`))
        return
      }
      resolve([data[0], data[1], data[2]])
    })
  })
}

/** Dominant audio frequency around `atSeconds`, via an FFT of a short window. */
export async function sampleFrequency(
  file: string,
  atSeconds: number,
  ffmpeg = 'ffmpeg'
): Promise<number> {
  const { spawn } = await import('node:child_process')
  const sampleRate = 8000
  const windowSeconds = 0.5
  const pcm: Buffer = await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-t',
        String(windowSeconds),
        '-i',
        file,
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-f',
        'f32le',
        'pipe:1'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const buffers: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => buffers.push(b))
    child.on('error', reject)
    child.on('close', () => resolve(Buffer.concat(buffers)))
  })

  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4))
  if (samples.length < 256) throw new Error(`no audio decoded at ${atSeconds}s from ${file}`)

  // Goertzel over the fixture's candidate tones is enough and avoids a full FFT.
  let bestFreq = 0
  let bestPower = -Infinity
  for (const chunk of CHUNKS) {
    const power = goertzel(samples, chunk.freq, sampleRate)
    if (power > bestPower) {
      bestPower = power
      bestFreq = chunk.freq
    }
  }
  return bestFreq
}

function goertzel(samples: Float32Array, frequency: number, sampleRate: number): number {
  const k = Math.round((samples.length * frequency) / sampleRate)
  const omega = (2 * Math.PI * k) / samples.length
  const coeff = 2 * Math.cos(omega)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/**
 * A deliberately fat copy of the same VOD, for tests about *how* a file is read.
 *
 * The ordinary fixture is about two megabytes — smaller than the five-megabyte
 * container-analysis bound the HTTP fetcher gives ffmpeg — so opening it reads
 * the whole thing and no seek is ever needed. Any test asking "did it seek to
 * the clip, or read the whole file?" therefore cannot tell the two apart, and
 * whether a Range request happens to appear comes down to timing. Above the
 * probe bound the question has exactly one answer, and it is the one that
 * matters for a six-hour broadcast.
 *
 * Getting there needs incompressible content, not a bigger bitrate setting: a
 * solid colour encodes to almost nothing however many bits x264 is offered, so
 * asking for `-b:v 3M` produces the same two megabytes. Film grain is what
 * makes the file big. It averages out — `sampleColor` scales a frame to a
 * single pixel — so colour and tone assertions still hold second by second.
 *
 * Built on demand rather than in `buildFixture`, so only the test that needs
 * it pays for it.
 */
export const BULKY_MIN_BYTES = 8 * 1024 * 1024

export async function buildBulkySource(
  root: string,
  ffmpeg = 'ffmpeg'
): Promise<{ path: string; bytes: number }> {
  const path = join(root, 'bulky.mp4')
  await runChecked(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    join(root, 'source.mp4'),
    // Smaller frame, noisier picture: the size has to come from entropy, and
    // a quarter of the pixels keeps the encode quick while still producing
    // tens of megabytes.
    '-vf',
    'scale=320:180,noise=alls=8:allf=t+u',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(FPS * GOP_SECONDS),
    '-keyint_min',
    String(FPS * GOP_SECONDS),
    '-sc_threshold',
    '0',
    '-crf',
    '20',
    '-c:a',
    'copy',
    // The index at the front, as a platform would serve it: without this
    // ffmpeg must seek to the end for the index, and the seek a test proves
    // would be that one rather than the seek to the clip.
    '-movflags',
    '+faststart',
    path
  ])
  const bytes = (await stat(path)).size
  if (bytes < BULKY_MIN_BYTES) {
    // Loud rather than silent: a fixture that quietly shrinks below the
    // fetcher's probe bound turns the test that uses it into one that cannot
    // fail.
    throw new Error(
      `bulky fixture is only ${bytes} bytes; it must exceed the fetcher's 5MB probe bound`
    )
  }
  return { path, bytes }
}
