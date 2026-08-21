import { useState } from 'react'
import { Dialog, MenuList } from '../ui/index.js'
import type { MenuItem } from '../ui/index.js'

/**
 * Ctrl+K. One search box over every clip and every dialog-opening action, so
 * jumping to a specific clip or opening a specific panel never means hunting
 * through the sidebar or the toolbar first.
 */
export default function CommandPalette({
  items,
  onClose
}: {
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const filtered = needle === '' ? items : items.filter((i) => i.label.toLowerCase().includes(needle))

  return (
    <Dialog title="Jump to…" size="small" onClose={onClose}>
      <input
        className="ui-input"
        autoFocus
        placeholder="Search clips and actions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && filtered.length > 0) {
            filtered[0].onSelect()
            onClose()
          }
        }}
        aria-label="Search clips and actions"
      />
      {filtered.length === 0 ? (
        <p className="hint">No matches.</p>
      ) : (
        <MenuList items={filtered} onDone={onClose} />
      )}
    </Dialog>
  )
}
