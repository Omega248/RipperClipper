import { useMemo, useState } from 'react'
import { Dialog, MenuList } from '../ui/index.js'
import type { MenuItem } from '../ui/index.js'

/** A palette row: a menu item that also knows which group it belongs to. */
export interface PaletteItem extends MenuItem {
  group: string
}

/**
 * Ctrl+K — the app's global find.
 *
 * It searches across the whole app rather than the open page, so it works
 * with nothing open. Results are grouped by what they *are*, and the groups
 * keep the order they were given: actions first, because the fastest thing to
 * reach should be the thing you meant to do, not the first clip that matches.
 *
 * Headings are attached after filtering, not before. A group whose first item
 * is filtered out must still be titled by whichever of its items survived.
 */
export default function CommandPalette({
  items,
  onClose
}: {
  items: PaletteItem[]
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  const filtered = useMemo(() => {
    const matches =
      needle === '' ? items : items.filter((i) => i.label.toLowerCase().includes(needle))
    let lastGroup: string | null = null
    return matches.map((item) => {
      const first = item.group !== lastGroup
      lastGroup = item.group
      return first ? { ...item, heading: item.group, separatorBefore: true } : item
    })
  }, [items, needle])

  // The first row is pre-highlighted by MenuList, so Enter runs it.
  const runFirst = (): void => {
    const first = filtered.find((i) => !i.disabled)
    if (!first) return
    first.onSelect()
    onClose()
  }

  return (
    <Dialog title="Jump to…" size="small" onClose={onClose}>
      <input
        className="ui-input"
        autoFocus
        placeholder="Search projects, streamers, VODs, clips"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') runFirst()
        }}
        aria-label="Search projects, streamers, VODs and clips"
      />
      {filtered.length === 0 ? (
        <div className="ui-empty palette-empty">
          <h3>Nothing matches “{query}”</h3>
          <p>Search runs across projects, streamers, VODs and clips — not just this page.</p>
        </div>
      ) : (
        <MenuList items={filtered} onDone={onClose} />
      )}
    </Dialog>
  )
}
