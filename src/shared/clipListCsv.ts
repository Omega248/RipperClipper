/**
 * The clip list as a spreadsheet — for tracking exports outside the app,
 * or handing a shot list to someone who isn't running it.
 *
 * Pure and deterministic: given the same rows, the same CSV comes out, so
 * this is exercised directly by a unit test rather than through the UI.
 */

export interface ClipListRow {
  name: string
  videoPov: string
  audioPov: string
  durationSeconds: number
  resolution: string
  watermarked: boolean
  path: string
}

const COLUMNS = ['Name', 'Video POV', 'Audio POV', 'Duration', 'Resolution', 'Watermarked', 'File'] as const

function csvField(value: string): string {
  // Quote whenever the value could otherwise be misread as more than one
  // field or run past its own line — a comma, a quote, or a newline.
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

export function buildClipListCsv(rows: ClipListRow[]): string {
  const lines = [COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.videoPov,
        row.audioPov,
        formatClock(row.durationSeconds),
        row.resolution,
        row.watermarked ? 'Yes' : 'No',
        row.path
      ]
        .map(csvField)
        .join(',')
    )
  }
  // CRLF: what every spreadsheet app expects from a .csv, Excel included.
  return lines.join('\r\n') + '\r\n'
}
