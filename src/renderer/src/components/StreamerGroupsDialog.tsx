import { useState } from 'react'
import type { SavedStreamer, StreamerGroup } from '@shared/ipc'
import { STREAMER_GROUP_COLORS } from '@shared/streamerGroupColors'
import { Button, Checkbox, Dialog, IconButton, Input } from '../ui/index.js'

interface Props {
  groups: StreamerGroup[]
  /** When set, each group also shows a checkbox for this streamer's membership. */
  streamer?: SavedStreamer | null
  onClose: () => void
  onCreate: (name: string, icon: string, color: string) => void
  onUpdate: (id: string, patch: { name: string; icon: string; color: string }) => void
  onDelete: (id: string) => void
  onToggleMembership?: (groupId: string, member: boolean) => void
}

interface Draft {
  name: string
  icon: string
  color: string
}

function ColorSwatches({
  value,
  onChange
}: {
  value: string
  onChange: (color: string) => void
}): JSX.Element {
  return (
    <div className="group-swatches" role="radiogroup" aria-label="Colour">
      {STREAMER_GROUP_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={`Colour ${c}`}
          className={`group-swatch${value === c ? ' is-selected' : ''}`}
          style={{ backgroundColor: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}

/**
 * Groups exist for one reason: finding everyone on one side of an event
 * without remembering who currently plays for it. This dialog both assigns
 * one streamer to groups (when opened from their row) and manages the group
 * list itself (create, restyle, delete) — the same list either way, just
 * with or without the membership checkboxes.
 */
export default function StreamerGroupsDialog({
  groups,
  streamer,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onToggleMembership
}: Props): JSX.Element {
  const [draft, setDraft] = useState<Draft>({
    name: '',
    icon: '',
    color: STREAMER_GROUP_COLORS[groups.length % STREAMER_GROUP_COLORS.length]
  })
  const [editing, setEditing] = useState<({ id: string } & Draft) | null>(null)

  const commitCreate = (): void => {
    const name = draft.name.trim()
    if (name === '') return
    onCreate(name, draft.icon.trim(), draft.color)
    setDraft({
      name: '',
      icon: '',
      color: STREAMER_GROUP_COLORS[(groups.length + 1) % STREAMER_GROUP_COLORS.length]
    })
  }

  const commitEdit = (): void => {
    if (!editing || editing.name.trim() === '') return
    onUpdate(editing.id, { name: editing.name.trim(), icon: editing.icon.trim(), color: editing.color })
    setEditing(null)
  }

  return (
    <Dialog
      title={streamer ? `Groups for ${streamer.displayName}` : 'Manage groups'}
      description={
        streamer
          ? "Which groups this streamer's current character belongs to — PD, a gang, EMS…"
          : 'Create, restyle or delete a group. Deleting one removes it from every streamer it was assigned to.'
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
            {groups.map((g) =>
              editing?.id === g.id ? (
                <li key={g.id} className="version-history-row group-edit-row">
                  <div className="group-edit-fields">
                    <Input
                      autoFocus
                      size="compact"
                      value={editing.name}
                      aria-label="Group name"
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                    <Input
                      size="compact"
                      className="group-icon-input"
                      value={editing.icon}
                      placeholder="🚓"
                      aria-label="Group icon (emoji)"
                      maxLength={4}
                      onChange={(e) => setEditing({ ...editing, icon: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                  </div>
                  <ColorSwatches value={editing.color} onChange={(color) => setEditing({ ...editing, color })} />
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <IconButton icon="check" size="compact" label="Save" onClick={commitEdit} />
                    <IconButton icon="close" size="compact" label="Cancel" onClick={() => setEditing(null)} />
                  </div>
                </li>
              ) : (
                <li key={g.id} className="version-history-row">
                  {streamer && onToggleMembership ? (
                    <Checkbox
                      checked={streamer.groupIds?.includes(g.id) ?? false}
                      onChange={(checked) => onToggleMembership(g.id, checked)}
                      label={
                        <span className="group-label">
                          <span
                            className="group-swatch group-swatch-static"
                            style={{ backgroundColor: g.color ?? 'var(--neutral-border)' }}
                          />
                          {g.icon && <span aria-hidden="true">{g.icon}</span>}
                          {g.name}
                        </span>
                      }
                    />
                  ) : (
                    <span className="group-label">
                      <span
                        className="group-swatch group-swatch-static"
                        style={{ backgroundColor: g.color ?? 'var(--neutral-border)' }}
                      />
                      {g.icon && <span aria-hidden="true">{g.icon}</span>}
                      {g.name}
                    </span>
                  )}
                  <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                    <IconButton
                      icon="edit"
                      size="compact"
                      label={`Edit "${g.name}"`}
                      onClick={() =>
                        setEditing({
                          id: g.id,
                          name: g.name,
                          icon: g.icon ?? '',
                          color: g.color ?? STREAMER_GROUP_COLORS[0]
                        })
                      }
                    />
                    <IconButton
                      icon="trash"
                      size="compact"
                      label={`Delete "${g.name}"`}
                      onClick={() => onDelete(g.id)}
                    />
                  </div>
                </li>
              )
            )}
          </ul>
        )}

        <div className="group-edit-fields">
          <Input
            placeholder="New group name"
            aria-label="New group name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCreate()
            }}
          />
          <Input
            className="group-icon-input"
            placeholder="🚓"
            aria-label="New group icon (emoji)"
            maxLength={4}
            value={draft.icon}
            onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCreate()
            }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <ColorSwatches value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
          <Button icon="plus" disabled={draft.name.trim() === ''} onClick={commitCreate}>
            Add group
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
