import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { py } from '../../src/main/export/resolveExporter.js'
import { xmlEscape } from '../../src/main/export/fcpxmlExporter.js'

/**
 * Every string a generated project file carries is attacker-supplied.
 *
 * A `.rcpkg` package exists to be shared, and `readPackage` shape-checks it
 * rather than sanitising it: the project name is "any non-empty string", and
 * clip and POV names are cast straight through. Those names then land in a
 * Python script the person is told to run inside Resolve, and in an FCPXML
 * Final Cut parses. So the escaping is not a nicety — it is the boundary.
 *
 * These are the characters that break each format. They are tested against
 * the real escapers rather than a copy of them.
 */

/** Strings that have to survive a round trip into a generated project file. */
const HOSTILE: Array<{ what: string; value: string }> = [
  { what: 'an apostrophe', value: "Tony's angle" },
  { what: 'a Windows path', value: 'C:\\clips\\bank job\\a.mp4' },
  { what: 'a newline', value: 'Bank job\nheist' },
  { what: 'a carriage return', value: 'Bank job\rheist' },
  { what: 'a tab', value: 'Bank\tjob' },
  { what: 'a double quote', value: 'the "big" one' },
  { what: 'a Python docstring terminator', value: 'x """ + __import__("os").name + """' },
  { what: 'a backslash before a quote', value: "path\\'; import os; #" },
  { what: 'unicode', value: 'Ω 漢字 🎬' },
  { what: 'an XML-illegal control character', value: 'Bank\u0001job' }
]

describe('strings reaching a generated Resolve script', () => {
  it('always produces a Python literal that parses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-py-'))
    try {
      for (const { what, value } of HOSTILE) {
        const script = join(dir, 'gen.py')
        // The literal is all that is under test, so the script does nothing
        // else: if it runs, the escaping held.
        writeFileSync(script, `name = ${py(value)}\nprint("ok")\n`, 'utf8')
        let out: string
        try {
          out = execFileSync('python', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (err) {
          throw new Error(`py() emitted a script Python cannot parse for ${what}: ${String(err)}`)
        }
        expect(out.trim(), what).toBe('ok')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips the value exactly, so a name is not silently altered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-py-'))
    try {
      for (const { what, value } of HOSTILE) {
        const script = join(dir, 'gen.py')
        // repr() of the parsed value, compared against JSON of the original:
        // both are unambiguous, so a lost backslash or a swallowed newline
        // shows up rather than passing as "close enough".
        writeFileSync(
          script,
          `import json, sys\nname = ${py(value)}\nsys.stdout.write(json.dumps(name))\n`,
          'utf8'
        )
        const out = execFileSync('python', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        expect(JSON.parse(out), what).toBe(value)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cannot be escaped from to inject Python', () => {
    // The docstring terminator is the interesting one: it is the only
    // character sequence that ends a `"""` block, and the header of the
    // generated script is one.
    const literal = py('"""\nimport os\n"""')
    expect(literal).not.toMatch(/\n/)
  })
})

describe('strings reaching a generated FCPXML', () => {
  it('escapes every character XML gives meaning to', () => {
    expect(xmlEscape('a & b')).toBe('a &amp; b')
    expect(xmlEscape('<tag>')).toBe('&lt;tag&gt;')
    expect(xmlEscape('say "hi"')).toBe('say &quot;hi&quot;')
    expect(xmlEscape("it's")).toBe('it&apos;s')
    // Escaping must not double-escape an ampersand it just introduced.
    expect(xmlEscape('&lt;')).toBe('&amp;lt;')
  })

  it('removes characters XML 1.0 cannot carry at all', () => {
    /*
     * A control character is not escapable in XML 1.0 — `&#x1;` is as illegal
     * as the raw byte, so there is nothing to do but drop it. Left in, Final
     * Cut rejects the whole file with a parse error, which reads to the person
     * as "Ripper Clipper produced a broken export".
     */
    expect(xmlEscape('Bank\u0001job')).toBe('Bankjob')
    expect(xmlEscape('Bank\u0000job')).toBe('Bankjob')
    // Tab, newline and carriage return are the three that are legal.
    expect(xmlEscape('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })
})
