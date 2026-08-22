import { useEffect, useMemo, useState } from 'react'
import type { SavedStreamer, StreamerGroup, StreamerVod } from '@shared/ipc'
import { isStreamerGroupIconName } from '@shared/streamerGroupIcons'
import { UNGROUPED, useStore } from '../store.js'
import StreamerAvatar from './StreamerAvatar.js'
import StreamerGroupsDialog from './StreamerGroupsDialog.js'
import { message, title } from './QualityPanel.js'
import { Button, EmptyState, Icon, PageHeader, SearchInput, Spinner } from '../ui/index.js'

/**
 * The streamer library, as a place rather than a modal.
 *
 * Groups are the reason this earns a page. They have existed in the data
 * model for a long time with no surface beyond a management dialog, and a
 * group is only useful when you can *filter* by it — "show me everyone in PD"
 * is the question the multi-POV workflow actually asks. Chips across the top
 * make that one click, and a streamer wearing several badges makes the
 * many-to-many nature obvious without explaining it.
 */
export default function StreamersPage(): JSX.Element {
  const streamers = useStore((s) => s.streamers)
  const setStreamers = useStore((s) => s.setStreamers)
  const groupFilter = useStore((s) => s.streamerGroupFilter)
  const setGroupFilter = useStore((s) => s.setStreamerGroupFilter)
  const toast = useStore((s) => s.toast)

  const [groups, setGroups] = useState<StreamerGroup[]>([])
  const [search, setSearch] = useState('')
  const [groupsDialog, setGroupsDialog] = useState<SavedStreamer | 'manage' | null>(null)
  const [vodsBySource, setVodsBySource] = useState<Record<string, StreamerVod[]>>({})
  const [loadingVods, setLoadingVods] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [saved, loadedGroups] = await Promise.all([
          window.api.listStreamers(),
          window.api.listStreamerGroups()
        ])
        setStreamers(saved)
        setGroups(loadedGroups)
        // Names and pictures fill in behind the grid, so it is usable at once
        // and simply gets better a moment later.
        void window.api.refreshStreamerProfiles().then(setStreamers).catch(() => undefined)
      } catch (err) {
        toast({ kind: 'error', title: title(err, 'Could not read your streamers'), message: message(err) })
      }
    })()
  }, [setStreamers, toast])

  /** How many streamers each chip would show — the count belongs on the chip. */
  const counts = useMemo(() => {
    const byGroup = new Map<string, number>()
    let ungrouped = 0
    for (const streamer of streamers) {
      const ids = streamer.groupIds ?? []
      if (ids.length === 0) ungrouped++
      for (const id of ids) byGroup.set(id, (byGroup.get(id) ?? 0) + 1)
    }
    return { byGroup, ungrouped }
  }, [streamers])

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return streamers
      .filter((s) => {
        if (groupFilter === UNGROUPED) return (s.groupIds ?? []).length === 0
        if (groupFilter !== null) return (s.groupIds ?? []).includes(groupFilter)
        return true
      })
      .filter(
        (s) =>
          needle === '' ||
          s.displayName.toLowerCase().includes(needle) ||
          s.handle.toLowerCase().includes(needle)
      )
      .sort((a, b) => {
        // Pinned first, then most recently used — the same order the old
        // dialog used, so muscle memory survives the move.
        if (Boolean(a.favorite) !== Boolean(b.favorite)) return a.favorite ? -1 : 1
        return (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt)
      })
  }, [streamers, groupFilter, search])

  const loadVods = async (streamer: SavedStreamer): Promise<void> => {
    if (vodsBySource[streamer.id]) return
    setLoadingVods(streamer.id)
    try {
      const list = await window.api.streamerVods(streamer.id)
      setVodsBySource((prev) => ({ ...prev, [streamer.id]: list }))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not list VODs'), message: message(err) })
    } finally {
      setLoadingVods(null)
    }
  }

  return (
    <div className="page streamers-page">
      <PageHeader
        title="Streamers"
        description="The people whose broadcasts you clip, and the groups they belong to."
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search streamers…" />
            <Button variant="primary" icon="plus" onClick={() => setGroupsDialog('manage')}>
              Manage groups
            </Button>
          </>
        }
      />

      <div className="group-filters" role="group" aria-label="Filter by group">
        <GroupChipButton
          label="All"
          count={streamers.length}
          on={groupFilter === null}
          onClick={() => setGroupFilter(null)}
        />
        {groups.map((group) => (
          <GroupChipButton
            key={group.id}
            label={group.name}
            colour={group.color}
            icon={group.icon}
            count={counts.byGroup.get(group.id) ?? 0}
            on={groupFilter === group.id}
            onClick={() => setGroupFilter(groupFilter === group.id ? null : group.id)}
          />
        ))}
        <GroupChipButton
          label="Ungrouped"
          count={counts.ungrouped}
          on={groupFilter === UNGROUPED}
          onClick={() => setGroupFilter(groupFilter === UNGROUPED ? null : UNGROUPED)}
        />

        <span className="group-filter-divider" aria-hidden="true" />
        <Button size="compact" variant="ghost" icon="plus" onClick={() => setGroupsDialog('manage')}>
          New group
        </Button>
        <span className="spacer" />
        <span className="hint inline">
          A streamer can sit in more than one group — affiliation is rarely exclusive.
        </span>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon="users"
          title={streamers.length === 0 ? 'No streamers saved yet.' : 'Nothing matches that filter.'}
          description={
            streamers.length === 0
              ? 'Loading a POV remembers its channel automatically, or add one by hand.'
              : undefined
          }
        />
      ) : (
        <div className="streamer-grid">
          {shown.map((streamer) => (
            <StreamerCard
              key={streamer.id}
              streamer={streamer}
              groups={groups}
              vods={vodsBySource[streamer.id]}
              loading={loadingVods === streamer.id}
              onViewVods={() => void loadVods(streamer)}
              onEditGroups={() => setGroupsDialog(streamer)}
            />
          ))}
        </div>
      )}

      {groupsDialog && (
        <StreamerGroupsDialog
          groups={groups}
          streamer={groupsDialog === 'manage' ? null : groupsDialog}
          onClose={() => setGroupsDialog(null)}
          onCreate={(name, icon, color) =>
            void window.api.createStreamerGroup(name, icon, color).then(setGroups)
          }
          onUpdate={(id, patch) => void window.api.updateStreamerGroup(id, patch).then(setGroups)}
          onDelete={(id) =>
            void window.api.deleteStreamerGroup(id).then((next) => {
              setGroups(next)
              // Deleting a group cannot leave the filter pointing at it, or
              // the grid would silently show nothing with no way back.
              if (groupFilter === id) setGroupFilter(null)
              void window.api.listStreamers().then(setStreamers)
            })
          }
          onToggleMembership={
            groupsDialog === 'manage'
              ? undefined
              : (groupId, member) => {
                  const current = groupsDialog.groupIds ?? []
                  const next = member
                    ? [...new Set([...current, groupId])]
                    : current.filter((g) => g !== groupId)
                  void window.api.setStreamerGroups(groupsDialog.id, next).then((saved) => {
                    setStreamers(saved)
                    setGroupsDialog(saved.find((x) => x.id === groupsDialog.id) ?? null)
                  })
                }
          }
        />
      )}
    </div>
  )
}

function GroupChipButton({
  label,
  count,
  on,
  colour,
  icon,
  onClick
}: {
  label: string
  count: number
  on: boolean
  colour?: string
  icon?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button type="button" className={`group-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={onClick}>
      {/* All and Ungrouped are not groups, so they carry no colour. */}
      {colour &&
        (isStreamerGroupIconName(icon) ? (
          <span className="group-chip-glyph" style={{ color: colour }}>
            <Icon name={icon} size={11} />
          </span>
        ) : (
          <span className="group-chip-dot" style={{ background: colour }} aria-hidden="true" />
        ))}
      <span className="ellipsis">{label}</span>
      <span className="group-chip-count mono">{count}</span>
    </button>
  )
}

function StreamerCard({
  streamer,
  groups,
  vods,
  loading,
  onViewVods,
  onEditGroups
}: {
  streamer: SavedStreamer
  groups: StreamerGroup[]
  vods: StreamerVod[] | undefined
  loading: boolean
  onViewVods: () => void
  onEditGroups: () => void
}): JSX.Element {
  const mine = (streamer.groupIds ?? [])
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is StreamerGroup => Boolean(g))
  const latest = vods?.[0]

  return (
    <div className="streamer-card">
      <StreamerAvatar
        name={streamer.displayName}
        platform={streamer.platform}
        url={streamer.avatarUrl}
        size={46}
      />

      <div className="streamer-card-body">
        <div className="streamer-card-name">
          <span className="ellipsis">{streamer.displayName}</span>
          {/* One badge per group: the many-to-many is the point, and a row of
              them says it better than any label could. */}
          {mine.map((group) => (
            <span
              key={group.id}
              className="group-badge"
              style={{
                color: group.color,
                background: `color-mix(in srgb, ${group.color} 20%, transparent)`,
                borderColor: `color-mix(in srgb, ${group.color} 45%, transparent)`
              }}
            >
              {group.name}
            </span>
          ))}
        </div>

        <div className="streamer-card-meta ellipsis">
          <span className={`streamer-platform is-${streamer.platform}`}>{streamer.platform}</span>
          {vods ? <span>{vods.length} saved VODs</span> : <span>@{streamer.handle}</span>}
        </div>

        <div className="streamer-card-meta is-dim ellipsis">
          {loading ? (
            <>
              <Spinner /> Reading recent broadcasts…
            </>
          ) : latest ? (
            `Latest: ${latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString() : 'unknown date'} · ${latest.title}`
          ) : vods ? (
            'No recent broadcasts found.'
          ) : streamer.lastUsedAt ? (
            `Last used ${new Date(streamer.lastUsedAt).toLocaleDateString()}`
          ) : (
            'Not used yet'
          )}
        </div>
      </div>

      <div className="streamer-card-actions">
        <Button size="compact" variant="ghost" onClick={onEditGroups}>
          Groups
        </Button>
        <Button size="compact" variant="ghost" onClick={onViewVods}>
          View VODs
          <Icon name="chevron-right" size={12} />
        </Button>
      </div>
    </div>
  )
}
