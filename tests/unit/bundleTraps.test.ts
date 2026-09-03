import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A trap that costs an afternoon if it is not pinned.
 *
 * electron-vite injects its CommonJS shim after the last ESM import it finds
 * in the built main bundle, and it finds them with a regex over the text
 * rather than by parsing. The pattern is roughly `import` followed by a quote —
 * so a *string* ending in the word "import", which is emitted as
 * `"Media import"`, reads to that regex as the beginning of an import
 * statement. The shim is then spliced into the middle of whatever literal that
 * string was part of, and the entire main process fails to build with an
 * "Unterminated string literal" pointing at a line that is perfectly fine.
 *
 * It happened once, in the export setup guide, where "Media import" was the
 * natural label. The fix is trivial once you know ("Importing media"); finding
 * it is not.
 */
const MAIN = fileURLToPath(new URL('../../src/main', import.meta.url))

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...tsFiles(path))
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('main-process bundle traps', () => {
  it('has no string literal ending in the word "import"', () => {
    const offenders: string[] = []
    for (const file of tsFiles(MAIN)) {
      const text = readFileSync(file, 'utf8')
      text.split('\n').forEach((line, index) => {
        // Comments are stripped before the shim is injected, so only code
        // counts — including this file's own explanation of the trap.
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
        // A quote closing immediately after the word, in either quoting style.
        if (/\bimport['"]/.test(line) && !/^\s*(import|export)\b/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
