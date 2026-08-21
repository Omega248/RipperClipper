import { useState } from 'react'
import type { SavedStreamer, StreamerGroup } from '@shared/ipc'
import { Button, Checkbox, Dialog, IconButton, Input } from '../ui/index.js'

interface Props {
  groups: StreamerGroup[]
  /** When set, each group also shows a checkbox for this streamer's membership. */
  streamer?: SavedStreamer | null
  onClose: () => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onToggleMembership?: (groupId: string, member: boolean) => void
}

/**
 * Groups exist for one reason: finding everyone on one side of an event
 * without remembering who currently plays for it. This dialog both assigns
 * one streamer to groups (when opened from their row) and manages the group
 * list itself (rename, delete) — the same list either way, just with or
 * without the membership checkboxes.
 */
export default function StreamerGroupsDialog({
  groups,
  streamer,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onToggleMembership
}: Props): JSX.Element {
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const commitRename = (): void => {
    if (!renaming) return
    onRename(renaming.id, renaming.name)
    setRenaming(null)
  }

  const commitCreate = (): void => {
    const trimmed = newName.trim()
    if (trimmed === '') return
    onCreate(trimmed)
    setNewName('')
  }

  return (
    <Dialog
      title={streamer ? `Groups for ${streamer.displayName}` : 'Manage groups'}
      description={
        streamer
          ? "Which groups this streamer's current character belongs to — PD, a gang, EMS…"
          : 'Rename or delete a group. Deleting one removes it from every streamer it was assigned to.'
      }
      size="small"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="rows">
        {groups.length === 0 && <div className="hint">No groups yet — add one below.</div>}

        {groups.length > 0 && (
          <ul className="version-history-list">
            {groups.map((g) => (
              <li key={g.id} className="version-history-row">
                {renaming?.id === g.id ? (
                  <Input
                    autoFocus
                    size="compact"
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: g.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={commitRename}
                  />
                ) : streamer && onToggleMembership ? (
                  <Checkbox
                    checked={streamer.groupIds?.includes(g.id) ?? false}
                    onChange={(checked) => onToggleMembership(g.id, checked)}
                    label={g.name}
                  />
                ) : (
                  <span>{g.name}</span>
                )}
                <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                  <IconButton
                    icon="edit"
                    size="compact"
                    label={`Rename "${g.name}"`}
                    onClick={() => setRenaming({ id: g.id, name: g.name })}
                  />
                  <IconButton
                    icon="trash"
                    size="compact"
                    label={`Delete "${g.name}"`}
                    onClick={() => onDelete(g.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Input
            placeholder="New group name"
            aria-label="New group name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCreate()
            }}
          />
          <Button icon="plus" disabled={newName.trim() === ''} onClick={commitCreate}>
            Add
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
