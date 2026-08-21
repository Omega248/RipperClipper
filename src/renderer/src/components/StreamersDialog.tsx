import { useCallback, useEffect, useState } from 'react'
import { formatTimecode } from '@shared/time'
import type { PlatformId } from '@shared/types'
import type { EventOverlapReply, SavedStreamer, StreamerGroup, StreamerVod } from '@shared/ipc'
import { coverageLabel } from '@shared/eventStreams'
import { vodsAtTime, parseLocalDateTime } from '@shared/vodSearch'
import type { VodAtTime } from '@shared/vodSearch'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import StreamerGroupsDialog from './StreamerGroupsDialog.js'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Notice,
  SearchInput,
  Select,
  Spinner,
  StatusBadge
} from '../ui/index.js'

/** A group's own colour and icon, badge-shaped — Badge itself only knows the fixed status tones. */
function GroupChip({ group }: { group: StreamerGroup }): JSX.Element {
  return (
    <span
      className="ui-badge group-chip"
      style={
        group.color
          ? { borderColor: group.color, backgroundColor: `${group.color}22`, color: group.color }
          : undefined
      }
    >
      {group.icon && <span aria-hidden="true">{group.icon}</span>}
      {group.name}
    </span>
  )
}

interface Props {
  onClose: () => void
  /** Load a VOD into the current project, exactly as pasting its link would. */
  onLoadVod: (url: string) => Promise<void>
  /** Name of the clip `overlap` was computed for, so the section can say whose moment it is. */
  overlapClipName: string | null
  /** Fetched proactively by App the moment a clip has a real-world time — already here, not asked for on open. */
  overlap: EventOverlapReply | null
  overlapLoading: boolean
  onRefreshOverlap: () => void
}

/**
 * The streamer library. The same handful of people cover a NoPixel event every
 * week, so their channels are kept between sessions and their recent VODs are
 * one click from being a POV.
 */
export default function StreamersDialog({
  onClose,
  onLoadVod,
  overlapClipName,
  overlap,
  overlapLoading,
  onRefreshOverlap
}: Props): JSX.Element {
  const toast = useStore((s) => s.toast)
  const sources = useStore((s) => s.project?.sources)
  const [streamers, setStreamers] = useState<SavedStreamer[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [vods, setVods] = useState<StreamerVod[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [when, setWhen] = useState('')
  const [atTime, setAtTime] = useState<Array<VodAtTime<StreamerVod> & { streamer: SavedStreamer }> | null>(null)
  const [searching, setSearching] = useState(false)
  const [platform, setPlatform] = useState<PlatformId>('twitch')
  const [filter, setFilter] = useState('')
  // Optimistic: a click marks a row "Added" instantly instead of waiting on
  // the load to finish, so importing several POVs back to back never blocks
  // on the slowest one. Reverted only if the load actually fails.
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [groups, setGroups] = useState<StreamerGroup[]>([])
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  // Applies to both "Live during…" and "Who was live at…" results: 'time'
  // keeps them closest-to-the-moment first (how they already arrive), 'group'
  // clusters a group's members together, so everyone on one side of an event
  // reads as one block instead of being scattered through the list.
  const [sortMode, setSortMode] = useState<'time' | 'group'>('time')
  // A streamer opens the dialog to assign their groups; 'manage' opens it to
  // rename/delete groups themselves, with no membership checkboxes.
  const [groupsDialog, setGroupsDialog] = useState<SavedStreamer | 'manage' | null>(null)

  const loadVods = useCallback(
    async (id: string): Promise<void> => {
      setSelected(id)
      setLoading(true)
      setListError(null)
      setVods([])
      try {
        setVods(await window.api.streamerVods(id))
      } catch (err) {
        setListError(`${title(err, 'Could not list VODs')}: ${message(err)}`)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // Open on the streamer used most recently and show their VODs straight away.
  useEffect(() => {
    void (async () => {
      try {
        const [saved] = await Promise.all([
          window.api.listStreamers(),
          window.api.listStreamerGroups().then(setGroups)
        ])
        setStreamers(saved)
        const recent = [...saved].sort((a, b) =>
          (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt)
        )[0]
        if (recent) void loadVods(recent.id)
      } catch (err) {
        setListError(`${title(err, 'Could not read your streamers')}: ${message(err)}`)
      }
    })()
  }, [loadVods])

  /**
   * Who was live at a given moment. One request per saved streamer, run only on
   * an explicit search — polling every keystroke would hammer the platforms and
   * starve the player, which is a mistake this app has made once already.
   */
  const searchAtTime = async (): Promise<void> => {
    const whenMs = parseLocalDateTime(when)
    if (whenMs === null) return
    setSearching(true)
    setListError(null)
    try {
      const results = await Promise.all(
        streamers.map(async (streamer) => {
          try {
            const vods = await window.api.streamerVods(streamer.id)
            return vodsAtTime(vods, whenMs).map((hit) => ({ ...hit, streamer }))
          } catch {
            // One unreachable channel must not sink the whole search.
            return []
          }
        })
      )
      const flat = results.flat().sort((a, b) => a.offsetSeconds - b.offsetSeconds)
      setAtTime(flat)
      if (flat.length === 0) {
        setListError(
          `No saved streamer has a VOD covering ${new Date(whenMs).toLocaleString()}. Their VODs may have expired, or the platform did not report when the broadcast started.`
        )
      }
    } finally {
      setSearching(false)
    }
  }

  const add = async (): Promise<void> => {
    if (input.trim() === '') return
    try {
      const next = await window.api.addStreamer(input.trim(), platform)
      setStreamers(next)
      setInput('')
      const added = next[next.length - 1]
      if (added) void loadVods(added.id)
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not add that channel'), message: message(err) })
    }
  }

  const remove = async (streamer: SavedStreamer): Promise<void> => {
    try {
      setStreamers(await window.api.removeStreamer(streamer.id))
      if (selected === streamer.id) {
        setSelected(null)
        setVods([])
      }
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not remove'), message: message(err) })
    }
  }

  const createGroup = async (name: string, icon: string, color: string): Promise<void> => {
    try {
      setGroups(await window.api.createStreamerGroup(name, icon, color))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not create that group'), message: message(err) })
    }
  }

  const updateGroup = async (
    id: string,
    patch: { name: string; icon: string; color: string }
  ): Promise<void> => {
    try {
      setGroups(await window.api.updateStreamerGroup(id, patch))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not update that group'), message: message(err) })
    }
  }

  const deleteGroup = async (id: string): Promise<void> => {
    try {
      setGroups(await window.api.deleteStreamerGroup(id))
      setStreamers((prev) =>
        prev.map((s) => (s.groupIds?.includes(id) ? { ...s, groupIds: s.groupIds.filter((g) => g !== id) } : s))
      )
      if (groupFilter === id) setGroupFilter(null)
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not delete that group'), message: message(err) })
    }
  }

  const toggleMembership = async (streamer: SavedStreamer, groupId: string, member: boolean): Promise<void> => {
    const current = streamer.groupIds ?? []
    const next = member ? [...current, groupId] : current.filter((g) => g !== groupId)
    try {
      const updated = await window.api.setStreamerGroups(streamer.id, next)
      setStreamers(updated)
      // Keep the dialog's own copy of the streamer in sync so its checkboxes
      // reflect the change immediately rather than on the next open.
      setGroupsDialog((prev) =>
        prev && prev !== 'manage' && prev.id === streamer.id
          ? (updated.find((s) => s.id === streamer.id) ?? prev)
          : prev
      )
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not update groups'), message: message(err) })
    }
  }

  const loaded = new Set((sources ?? []).map((s) => s.url))

  /** Fires the load in the background; the row flips to "Added" right away. */
  const importOne = (url: string): void => {
    if (loaded.has(url) || added.has(url)) return
    setAdded((prev) => new Set(prev).add(url))
    void onLoadVod(url).then(() => {
      const stillMissing = !useStore.getState().project?.sources.some((s) => s.url === url)
      if (stillMissing) {
        setAdded((prev) => {
          const next = new Set(prev)
          next.delete(url)
          return next
        })
      }
    })
  }

  const needle = filter.trim().toLowerCase()
  const shownStreamers = streamers
    .filter((st) => needle === '' || st.displayName.toLowerCase().includes(needle))
    .filter((st) => groupFilter === null || st.groupIds?.includes(groupFilter))
  const shownVods =
    needle === '' ? vods : vods.filter((v) => v.title.toLowerCase().includes(needle))

  /** A streamer's groups, alphabetised, as one sortable string — ungrouped sorts last. */
  const groupSortKey = (streamerId: string): string => {
    const ids = streamers.find((s) => s.id === streamerId)?.groupIds ?? []
    const names = ids.map((id) => groups.find((g) => g.id === id)?.name).filter((n): n is string => Boolean(n))
    return names.length > 0 ? names.slice().sort().join(', ') : '￿'
  }

  const streamerGroupChips = (streamerId: string): JSX.Element[] =>
    (streamers.find((s) => s.id === streamerId)?.groupIds ?? [])
      .map((id) => groups.find((g) => g.id === id))
      .filter((g): g is StreamerGroup => Boolean(g))
      .map((g) => <GroupChip key={g.id} group={g} />)

  const sortedAtTime =
    sortMode === 'time' || !atTime
      ? atTime
      : [...atTime].sort(
          (a, b) =>
            groupSortKey(a.streamer.id).localeCompare(groupSortKey(b.streamer.id)) ||
            a.offsetSeconds - b.offsetSeconds
        )

  const sortedOverlapStreams =
    sortMode === 'time' || !overlap
      ? (overlap?.streams ?? [])
      : [...overlap.streams].sort(
          (a, b) =>
            groupSortKey(a.streamerId).localeCompare(groupSortKey(b.streamerId)) ||
            a.coverage.offsetSeconds - b.coverage.offsetSeconds
        )

  /** One row shape for a VOD, wherever it came from. */
  const vodRow = (
    key: string,
    thumbnailUrl: string | null | undefined,
    heading: JSX.Element,
    meta: JSX.Element,
    url: string
  ): JSX.Element => {
    const isAdded = loaded.has(url) || added.has(url)
    return (
      <div className="vod" key={key}>
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <div className="vod-thumb-blank" aria-hidden="true">
            No preview
          </div>
        )}
        <div className="vod-text">
          <div className="vod-title">{heading}</div>
          <div className="vod-meta">{meta}</div>
        </div>
        <Button
          variant="primary"
          size="compact"
          icon={isAdded ? 'check' : 'plus'}
          disabled={isAdded}
          onClick={() => importOne(url)}
        >
          {isAdded ? 'Added' : 'Load as POV'}
        </Button>
      </div>
    )
  }

  return (
    <>
    <Dialog
      title="Streamers"
      description="The people whose broadcasts you clip, and their recent VODs."
      size="large"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="streamers-layout">
        <aside className="streamer-list">
          <div className="add-streamer">
            <Select
              value={platform}
              label="Platform"
              options={[
                { value: 'twitch', label: 'Twitch' },
                { value: 'kick', label: 'Kick' },
                { value: 'youtube', label: 'YouTube' }
              ]}
              onChange={(value) => setPlatform(value as PlatformId)}
            />
            <Input
              placeholder="Channel name or link"
              value={input}
              aria-label="Channel name or link"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
            />
            <Button variant="primary" icon="plus" onClick={() => void add()}>
              Save
            </Button>
          </div>

          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder="Search streamers and VODs"
            label="Search streamers and VODs"
          />

          {(groups.length > 0 || streamers.length > 0) && (
            <div className="group-filter-row">
              <Select
                size="compact"
                value={groupFilter ?? ''}
                onChange={(value) => setGroupFilter(value === '' ? null : value)}
                label="Filter by group"
                options={[
                  { value: '', label: 'All groups' },
                  ...groups.map((g) => ({
                    value: g.id,
                    label: [g.icon, g.name].filter(Boolean).join(' ')
                  }))
                ]}
              />
              <Button size="compact" variant="ghost" icon="settings" onClick={() => setGroupsDialog('manage')}>
                Manage groups
              </Button>
            </div>
          )}

          {streamers.length === 0 && (
            <EmptyState
              icon="users"
              title="No streamers saved"
              description="Add the people who stream the events you clip. Their recent broadcasts then show up here every session."
            />
          )}

          {streamers.length > 0 && shownStreamers.length === 0 && (
            <EmptyState
              icon="search"
              title="No results found"
              description={`No saved streamer matches "${filter.trim()}".`}
              action={{ label: 'Clear search', onClick: () => setFilter('') }}
            />
          )}

          {shownStreamers.map((streamer) => (
            <div
              key={streamer.id}
              className={`streamer${selected === streamer.id ? ' active' : ''}`}
            >
              <button className="streamer-pick" onClick={() => void loadVods(streamer.id)}>
                <span className="streamer-name">{streamer.displayName}</span>
                <span className="streamer-meta">
                  <span className="tag">{streamer.platform}</span>
                  {streamer.lastUsedAt && (
                    <span>used {new Date(streamer.lastUsedAt).toLocaleDateString()}</span>
                  )}
                  {(streamer.groupIds ?? []).map((id) => {
                    const group = groups.find((g) => g.id === id)
                    return group ? <GroupChip key={id} group={group} /> : null
                  })}
                </span>
              </button>
              <IconButton
                icon="users"
                size="compact"
                label={`Edit groups for ${streamer.displayName}`}
                onClick={() => setGroupsDialog(streamer)}
              />
              <IconButton
                icon="trash"
                size="compact"
                label={`Remove ${streamer.displayName}`}
                onClick={() => void remove(streamer)}
              />
            </div>
          ))}
        </aside>

        <section className="streamer-vods">
          {overlapClipName && (
            <div className="overlap-section">
              <div className="overlap-head">
                <h3>Live during &ldquo;{overlapClipName}&rdquo;</h3>
                <div className="overlap-head-actions">
                  {!overlapLoading &&
                    overlap &&
                    overlap.streams.some(
                      (entry) => !loaded.has(entry.vod.url) && !added.has(entry.vod.url)
                    ) && (
                      <Button
                        size="compact"
                        icon="plus"
                        onClick={() => {
                          for (const entry of overlap.streams) importOne(entry.vod.url)
                        }}
                      >
                        Import all
                      </Button>
                    )}
                  <IconButton
                    icon="refresh"
                    size="compact"
                    label="Check again"
                    onClick={onRefreshOverlap}
                  />
                </div>
              </div>

              {overlapLoading && <Spinner label="Asking each saved channel…" />}

              {!overlapLoading && overlap && overlap.streams.length === 0 && (
                <p className="hint">
                  None of your saved streamers has a broadcast covering this clip's moment.
                </p>
              )}

              {!overlapLoading &&
                overlap &&
                sortedOverlapStreams.map((entry) =>
                  vodRow(
                    `overlap-${entry.streamerId}-${entry.vod.url}`,
                    entry.vod.thumbnailUrl,
                    <>
                      <span className="tag">{entry.platform}</span> {entry.streamerName} —{' '}
                      {entry.vod.title}
                    </>,
                    <>
                      <span>{coverageLabel(entry.coverage)}</span>
                      {entry.coverage.certain && (
                        <span className="mono">
                          {formatTimecode(entry.coverage.offsetSeconds, { millis: false })} in
                        </span>
                      )}
                      {entry.availability === 'loaded' && (
                        <StatusBadge status="complete" label="Already loaded" />
                      )}
                      {streamerGroupChips(entry.streamerId)}
                    </>,
                    entry.vod.url
                  )
                )}

              {!overlapLoading && overlap && overlap.unreachable.length > 0 && (
                <Notice tone="warning">
                  Could not reach {overlap.unreachable.join(', ')}, so this list may be incomplete.
                </Notice>
              )}

              <hr className="rule" />
            </div>
          )}

          <div className="at-time">
            <label htmlFor="at-when">Who was live at</label>
            <Input
              id="at-when"
              type="datetime-local"
              value={when}
              style={{ width: 210 }}
              onChange={(e) => setWhen(e.target.value)}
            />
            <Button
              icon="search"
              loading={searching}
              disabled={parseLocalDateTime(when) === null || streamers.length === 0}
              onClick={() => void searchAtTime()}
              title="Search every saved streamer for a broadcast that was running then"
            >
              Find POVs
            </Button>
            {atTime && (
              <Button variant="ghost" onClick={() => setAtTime(null)}>
                Clear
              </Button>
            )}
            {groups.length > 0 && (
              <Select
                size="compact"
                value={sortMode}
                onChange={(value) => setSortMode(value as 'time' | 'group')}
                label="Sort results by"
                options={[
                  { value: 'time', label: 'Sort: closest time' },
                  { value: 'group', label: 'Sort: by group' }
                ]}
              />
            )}
          </div>

          {atTime && atTime.length > 0 && (
            <>
              <p className="hint">
                {atTime.length} broadcast{atTime.length === 1 ? '' : 's'} covering{' '}
                {new Date(parseLocalDateTime(when)!).toLocaleString()}. Loading one seeks straight to
                that moment once its timing is known.
              </p>
              {sortedAtTime!.map((hit) =>
                vodRow(
                  `${hit.streamer.id}-${hit.vod.url}`,
                  hit.vod.thumbnailUrl,
                  <>
                    <span className="tag">{hit.streamer.platform}</span> {hit.streamer.displayName} —{' '}
                    {hit.vod.title}
                  </>,
                  <>
                    <span>{formatTimecode(hit.offsetSeconds, { millis: false })} in</span>
                    {!hit.certain && (
                      <Badge tone="warning" glyph="▲">
                        Length unknown
                      </Badge>
                    )}
                    {hit.vod.publishedAt && (
                      <span>started {new Date(hit.vod.publishedAt).toLocaleString()}</span>
                    )}
                    {streamerGroupChips(hit.streamer.id)}
                  </>,
                  hit.vod.url
                )
              )}
              <hr className="rule" />
            </>
          )}

          {loading && <Spinner label="Asking the platform for recent broadcasts…" />}
          {listError && <Notice tone="warning">{listError}</Notice>}
          {!loading && !listError && selected && vods.length === 0 && (
            <EmptyState
              icon="file"
              title="No broadcasts came back"
              description="Platforms delete VODs after a while, and subscriber-only ones are not listed publicly."
            />
          )}
          {!loading && !selected && (
            <EmptyState
              icon="users"
              title="Pick a streamer"
              description="Choose someone on the left to see their recent broadcasts."
            />
          )}

          {shownVods.map((vod) =>
            vodRow(
              vod.url,
              vod.thumbnailUrl,
              <>{vod.title}</>,
              <>
                {vod.publishedAt && <span>{new Date(vod.publishedAt).toLocaleString()}</span>}
                {vod.durationSeconds !== null && (
                  <span>{formatTimecode(vod.durationSeconds, { millis: false })}</span>
                )}
                {vod.viewCount !== undefined && <span>{vod.viewCount.toLocaleString()} views</span>}
              </>,
              vod.url
            )
          )}
        </section>
      </div>
    </Dialog>

    {groupsDialog && (
      <StreamerGroupsDialog
        groups={groups}
        streamer={groupsDialog === 'manage' ? null : groupsDialog}
        onClose={() => setGroupsDialog(null)}
        onCreate={(name, icon, color) => void createGroup(name, icon, color)}
        onUpdate={(id, patch) => void updateGroup(id, patch)}
        onDelete={(id) => void deleteGroup(id)}
        onToggleMembership={
          groupsDialog === 'manage'
            ? undefined
            : (groupId, member) => void toggleMembership(groupsDialog, groupId, member)
        }
      />
    )}
    </>
  )
}
