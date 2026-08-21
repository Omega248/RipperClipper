/**
 * A GitHub release body arrives as rendered HTML (GitHub renders the
 * markdown server-side before electron-updater ever sees it), not the
 * markdown source. Turning it into readable plain text — rather than either
 * showing the raw tags or trusting external HTML into the DOM via
 * `dangerouslySetInnerHTML` — is what actually makes "a quick summary of
 * what's changed" readable and safe at the same time.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(li|h[1-6]|p|ul|ol|div|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}
