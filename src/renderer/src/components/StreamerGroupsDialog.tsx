import { useState } from 'react'
import type { SavedStreamer, StreamerGroup } from '@shared/ipc'
import { STREAMER_GROUP_COLORS } from '@shared/streamerGroupColors'
import { STREAMER_GROUP_ICON_NAMES, isStreamerGroupIconName } from '@shared/streamerGroupIcons'
import { Button, Checkbox, Dialog, Icon, IconButton, Input } from '../ui/index.js'

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
 * A fixed set of icons, not free text — see shared/streamerGroupIcons.ts for
 * why. "No icon" is a real, first-class choice: a name and a colour alone
 * are already enough to tell groups apart.
 */
function IconPicker({
  value,
  onChange
}: {
  value: string
  onChange: (icon: string) => void
}): JSX.Element {
  return (
    <div className="group-icon-picker" role="radiogroup" aria-label="Icon">
      <button
        type="button"
        role="radio"
        aria-checked={value === ''}
        aria-label="No icon"
        className={`group-icon-option${value === '' ? ' is-selected' : ''}`}
        onClick={() => onChange('')}
      >
        <Icon name="close" />
      </button>
      {STREAMER_GROUP_ICON_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={value === name}
          aria-label={name}
          className={`group-icon-option${value === name ? ' is-selected' : ''}`}
          onClick={() => onChange(name)}
        >
          <Icon name={name} />
        </button>
      ))}
    </div>
  )
}

/** A group's swatch, icon (if any) and name, as one row — reused for both the checkbox label and the plain list row. */
function GroupLabel({ group }: { group: StreamerGroup }): JSX.Element {
  return (
    <span className="group-label">
      <span
        className="group-swatch group-swatch-static"
        style={{ backgroundColor: group.color ?? 'var(--neutral-border)' }}
      />
      {isStreamerGroupIconName(group.icon) && <Icon name={group.icon} size={14} />}
      {group.name}
    </span>
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
                  <IconPicker value={editing.icon} onChange={(icon) => setEditing({ ...editing, icon })} />
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
                      label={<GroupLabel group={g} />}
                    />
                  ) : (
                    <GroupLabel group={g} />
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

        <Input
          placeholder="New group name"
          aria-label="New group name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitCreate()
          }}
        />
        <IconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} />
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
