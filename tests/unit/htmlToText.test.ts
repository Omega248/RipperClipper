import { describe, expect, it } from 'vitest'
import { stripHtml } from '../../src/shared/htmlToText.js'

/**
 * GitHub release bodies arrive pre-rendered to HTML — confirmed live against
 * the real feed while testing the update popup, which is exactly what
 * surfaced this: the popup was showing raw `<h2>`/`<li>` tags as text.
 */
describe('stripHtml', () => {
  it('turns list items into bullet lines', () => {
    expect(stripHtml('<ul><li>First</li><li>Second</li></ul>')).toBe('• First\n• Second')
  })

  it('turns headings and paragraphs into their own lines', () => {
    expect(stripHtml('<h2>What\'s new</h2><p>Some details.</p>')).toBe("What's new\nSome details.")
  })

  it('strips inline formatting tags without losing their text', () => {
    expect(stripHtml('<p><strong>Clips</strong></p>')).toBe('Clips')
    expect(stripHtml('<li>The <code>?</code> key opens it.</li>')).toBe('• The ? key opens it.')
  })

  it('decodes common HTML entities', () => {
    expect(stripHtml('<p>Cats &amp; dogs &mdash;? &quot;really&quot; &#39;fine&#39;</p>')).toContain(
      'Cats & dogs'
    )
    expect(stripHtml('<p>&lt;tag&gt; &amp; &quot;quoted&quot; &#39;text&#39;</p>')).toBe(
      '<tag> & "quoted" \'text\''
    )
  })

  it('collapses blank lines left behind by empty tags', () => {
    expect(stripHtml('<ul>\n<li>One</li>\n</ul>\n<p></p>\n<p>Two</p>')).toBe('• One\nTwo')
  })

  it('matches the real shape of a GitHub-rendered release body', () => {
    const html =
      "<h2>What's new</h2>\n<ul>\n<li>Creating a clip now prompts for a name.</li>\n<li>Sort the clip list by duration.</li>\n</ul>\n<h2>Notes</h2>\n<ul>\n<li>Unsigned build.</li>\n</ul>"
    expect(stripHtml(html)).toBe(
      "What's new\n• Creating a clip now prompts for a name.\n• Sort the clip list by duration.\nNotes\n• Unsigned build."
    )
  })

  it('returns plain text unchanged', () => {
    expect(stripHtml('Just a plain sentence.')).toBe('Just a plain sentence.')
  })

  it('handles an empty string', () => {
    expect(stripHtml('')).toBe('')
  })
})
