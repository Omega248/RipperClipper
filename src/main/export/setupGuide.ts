import { basename } from 'node:path'
import type { EditingProject } from '../../shared/editingProject.js'
import { timecode } from '../../shared/editingProject.js'
import type { EditorCapabilities } from '../../shared/editorCapabilities.js'
import { SUPPORT_LABEL, SUPPORT_MARK } from '../../shared/editorCapabilities.js'

/**
 * The page in the export folder that says what this is.
 *
 * Written for whoever opens the folder in a week with no memory of making it:
 * what the angles are, how far each one is shifted, exactly where the
 * watermark goes, and — the part that matters most — which steps the app did
 * and which are left to them. An honest "you will have to place this yourself"
 * beats a confident instruction that turns out to be wrong.
 */
/*
 * A note on wording, which is not a style preference.
 *
 * A string in a main-process file must never *end* with the word "import".
 * electron-vite finds the last ESM import in the built bundle with a textual
 * regex and splices its CommonJS shim in after it — and `"Media import"`,
 * emitted with double quotes, looks exactly like the start of `import "…"` to
 * that regex. The shim then lands in the middle of this template literal and
 * the whole main bundle fails to parse, with an error pointing at a line that
 * has nothing wrong with it. `stringsEndingInImport` in the tests guards it.
 */
export function setupGuideHtml(
  project: EditingProject,
  editor: EditorCapabilities,
  steps: string[]
): string {
  const wm = project.watermark
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

  const capability = (label: string, value: string): string =>
    `<tr><td>${escape(label)}</td><td class="mark">${escape(
      SUPPORT_MARK[value as keyof typeof SUPPORT_MARK] ?? '?'
    )}</td><td>${escape(SUPPORT_LABEL[value as keyof typeof SUPPORT_LABEL] ?? value)}</td></tr>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escape(project.name)} — ${escape(editor.name)}</title>
<style>
 :root{color-scheme:dark light}
 body{margin:0;padding:32px;font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;
      background:#14151a;color:#e6e7ea;max-width:900px}
 h1{font-size:24px;margin:0 0 4px}
 h2{font-size:16px;margin:32px 0 10px;color:#b9bcc4;font-weight:600}
 p{margin:0 0 12px;color:#c9ccd3}
 table{border-collapse:collapse;width:100%;margin:0 0 12px;font-size:14px}
 th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #262932;vertical-align:top}
 th{color:#8f939d;font-weight:600}
 td.mark{width:28px;text-align:center}
 code{background:#1d1f26;padding:2px 6px;border-radius:4px;font:13px ui-monospace,Consolas,monospace}
 ol{padding-left:22px}li{margin:0 0 8px}
 .note{border-left:3px solid #5b6cff;background:#181b26;padding:12px 16px;margin:0 0 16px;border-radius:0 6px 6px 0}
 .warn{border-left-color:#d9a441;background:#221d16}
 @media (prefers-color-scheme: light){
  body{background:#fff;color:#14151a}
  th,td{border-bottom-color:#e4e6ea}
  code{background:#f1f2f5}
  .note{background:#f4f6ff}.warn{background:#fdf6e8}
 }
</style></head><body>
<h1>${escape(project.name)}</h1>
<p>${project.povs.length} angle${project.povs.length === 1 ? '' : 's'},
   ${escape(timecode(project.timeline.durationSeconds, project.timeline.fps))} long,
   ${project.timeline.width}×${project.timeline.height} at ${project.timeline.fps} fps.
   Prepared for <strong>${escape(editor.name)}</strong>.</p>

<div class="note">
 <strong>The source recordings were not modified, and no video was re-encoded to make this.</strong>
 The watermark travels as a position and an opacity, so it stays adjustable in ${escape(editor.name)}.
</div>

<h2>What is automatic here</h2>
<p>${escape(editor.mechanism)}.</p>
<table>
 <tr><th>Capability</th><th></th><th></th></tr>
 ${capability('Importing media', editor.mediaImport)}
 ${capability('Timeline creation', editor.timelineCreation)}
 ${capability('Watermark overlay', editor.imageOverlay)}
 ${capability('Position and size', editor.transform)}
 ${capability('Opacity', editor.opacity)}
 ${capability('Markers', editor.markers)}
</table>
${
  editor.limitations.length > 0
    ? `<div class="note warn"><strong>Worth knowing.</strong><ul>${editor.limitations
        .map((l) => `<li>${escape(l)}</li>`)
        .join('')}</ul></div>`
    : ''
}

<h2>Steps</h2>
<ol>${steps.map((s) => `<li>${escape(s)}</li>`).join('')}</ol>

<h2>Angles</h2>
<table>
 <tr><th>Angle</th><th>Platform</th><th>Sync offset</th><th>Source</th><th>File</th></tr>
 ${project.povs
   .map((pov) => {
     const media = project.media.find((m) => m.id === pov.mediaId)
     return `<tr><td>${escape(pov.streamerName)}</td><td>${escape(pov.platform)}</td>
      <td><code>${pov.syncOffsetSeconds >= 0 ? '+' : ''}${pov.syncOffsetSeconds.toFixed(3)}s</code></td>
      <td>${media ? `${media.width}×${media.height} · ${media.fps} fps` : '—'}</td>
      <td><code>${escape(media ? basename(media.path) : '—')}</code></td></tr>`
   })
   .join('')}
</table>

<h2>Watermark</h2>
${
  wm && wm.config.enabled
    ? `<table>
 <tr><th>Setting</th><th colspan="2">Value</th></tr>
 <tr><td>Image</td><td colspan="2"><code>${escape(basename(wm.assetPath))}</code></td></tr>
 <tr><td>Anchor</td><td colspan="2">${escape(wm.transform.anchor)}</td></tr>
 <tr><td>Centre</td><td colspan="2">x ${pct(wm.transform.x)}, y ${pct(wm.transform.y)} of the frame</td></tr>
 <tr><td>Size</td><td colspan="2">${pct(wm.transform.width)} of frame width (${Math.round(
   wm.transform.width * project.timeline.width
 )}×${Math.round(wm.transform.height * project.timeline.height)} px at this timeline size)</td></tr>
 <tr><td>Opacity</td><td colspan="2">${pct(wm.transform.opacity)}</td></tr>
 <tr><td>Rotation</td><td colspan="2">${wm.transform.rotation}°</td></tr>
 <tr><td>Duration</td><td colspan="2">the whole timeline</td></tr>
</table>
<p>The percentages are fractions of the frame, so they hold at any resolution — the same
   numbers place the logo identically on a 1080p or a 2160p timeline.</p>`
    : '<p>No watermark is configured for this project.</p>'
}

<h2>Files</h2>
<table>
 <tr><th>Folder</th><th colspan="2">What is in it</th></tr>
 <tr><td><code>Media/</code></td><td colspan="2">The exported angles${
   project.media.length > 0 && !project.media[0].path.includes('Media')
     ? ' — referenced in place rather than copied, to avoid duplicating them'
     : ''
 }</td></tr>
 <tr><td><code>Assets/</code></td><td colspan="2">The watermark image</td></tr>
 <tr><td><code>Metadata/</code></td><td colspan="2"><code>project.json</code>, <code>povs.json</code>, <code>watermark.json</code> — enough to rebuild this project</td></tr>
 <tr><td><code>Editor/</code></td><td colspan="2">What was generated for ${escape(editor.name)}</td></tr>
</table>
</body></html>`
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
