import { useCallback, useEffect, useState } from 'react'
import { formatTimecode } from '@shared/time'
import type { PlatformId } from '@shared/types'
import type { EventOverlapReply, SavedStreamer, StreamerGroup, StreamerVod } from '@shared/ipc'
import { coverageLabel } from '@shared/eventStreams'
import { vodsAtTime, parseLocalDateTime } from '@shared/vodSearch'
import type { VodAtTime } from '@shared/vodSearch'
import { isStreamerGroupIconName } from '@shared/streamerGroupIcons'
import { useStore } from '../store.js'
import { message, title } from './QualityPanel.js'
import StreamerGroupsDialog from './StreamerGroupsDialog.js'
import StreamerAvatar from './StreamerAvatar.js'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Notice,
  SearchInput,
  Select,
  Spinner,
  StatusBadge
} from '../ui/index.js'

/** A coarse "how stale is this" phrase — exact minutes don't matter, only the ballpark. */
function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/** A group's own colour and icon, badge-shaped — Badge itself only knows the fixed status tones. */
/** 1_101_849 → "1.1M". Follower counts are scale, not arithmetic. */
function compactCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) {
    const k = value / 1000
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`
  }
  const m = value / 1_000_000
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`
}

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
      {isStreamerGroupIconName(group.icon) && <Icon name={group.icon} size={12} />}
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
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [linkPickerFor, setLinkPickerFor] = useState<string | null>(null)
  // Best resolution seen for a VOD, fetched only for URLs that turn out to be
  // one half of a same-person multistream pair — most VODs never need this.
  const [qualityByUrl, setQualityByUrl] = useState<Record<string, number | null>>({})
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
        setLastCheckedAt(Date.now())
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

        // Names and pictures fill themselves in behind the list, so it is
        // usable immediately and simply gets better a moment later. Stale
        // ones only — a profile is refreshed about once a week, not on
        // every open — and a failure is silent, since a missing picture is
        // decoration rather than a problem worth interrupting anyone for.
        void window.api
          .refreshStreamerProfiles()
          .then(setStreamers)
          .catch(() => undefined)
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

  /**
   * Add several channels at once — one per line, each either a full channel
   * URL (platform detected from it) or a bare name (added under whichever
   * platform is currently selected). Lets someone paste in a roster they
   * already keep elsewhere instead of adding channels one at a time.
   */
  const bulkAdd = async (): Promise<void> => {
    const lines = [...new Set(bulkText.split('\n').map((l) => l.trim()).filter(Boolean))]
    if (lines.length === 0) return
    setBulkBusy(true)
    let list = streamers
    let addedCount = 0
    let failedCount = 0
    for (const line of lines) {
      const before = list.length
      try {
        list = await window.api.addStreamer(line, platform)
        if (list.length > before) addedCount++
      } catch {
        failedCount++
      }
    }
    setStreamers(list)
    setBulkBusy(false)
    setBulkText('')
    setBulkOpen(false)
    const skipped = lines.length - addedCount - failedCount
    const detail = [
      skipped > 0 ? `${skipped} already saved` : null,
      failedCount > 0 ? `${failedCount} could not be recognised` : null
    ].filter(Boolean)
    toast({
      kind: failedCount > 0 ? 'error' : 'success',
      title: `Added ${addedCount} streamer${addedCount === 1 ? '' : 's'}`,
      message: detail.length > 0 ? detail.join(', ') : 'All lines were added.'
    })
  }

  const remove = async (streamer: SavedStreamer): Promise<void> => {
    try {
      setStreamers(await window.api.removeStreamer(streamer.id))
      if (selected === streamer.id) {
        setSelected(null)
        setVods([])
      }
      toast({
        kind: 'success',
        title: `Removed ${streamer.displayName}`,
        message: 'Their VODs and groups are gone from the list.',
        action: {
          label: 'Undo',
          onClick: () => {
            void window.api.restoreStreamer(streamer).then(setStreamers)
          }
        }
      })
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not remove'), message: message(err) })
    }
  }

  const toggleFavorite = async (streamer: SavedStreamer): Promise<void> => {
    try {
      setStreamers(await window.api.setStreamerFavorite(streamer.id, !streamer.favorite))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not update favourite'), message: message(err) })
    }
  }

  const copyChannelLink = (streamer: SavedStreamer): void => {
    void navigator.clipboard.writeText(streamer.channelUrl)
    toast({ kind: 'success', title: 'Link copied', message: streamer.channelUrl })
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

  const linkPerson = async (idA: string, idB: string): Promise<void> => {
    try {
      setStreamers(await window.api.linkStreamerPerson(idA, idB))
      setLinkPickerFor(null)
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not link streamers'), message: message(err) })
    }
  }

  const unlinkPerson = async (id: string): Promise<void> => {
    try {
      setStreamers(await window.api.unlinkStreamerPerson(id))
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not unlink'), message: message(err) })
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
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)))
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

  interface MultistreamInfo {
    /** True once quality is known for at least two of the linked person's covering VODs. */
    resolved: boolean
    /** False only once resolved and a linked copy is confirmed higher quality. */
    isBest: boolean
    otherNames: string
  }

  /**
   * For every pair (or more) of results that come from streamers linked as
   * the same person, works out which copy is the better watch. Undecided
   * until at least two of them have a known resolution, so nothing is ever
   * demoted on a guess.
   */
  const clusterInfoFor = (
    entries: Array<{ streamerId: string; url: string }>
  ): Map<string, MultistreamInfo> => {
    const byPerson = new Map<string, Array<{ streamerId: string; url: string }>>()
    for (const entry of entries) {
      const personId = streamers.find((s) => s.id === entry.streamerId)?.personId
      if (!personId) continue
      byPerson.set(personId, [...(byPerson.get(personId) ?? []), entry])
    }
    const out = new Map<string, MultistreamInfo>()
    for (const bucket of byPerson.values()) {
      if (bucket.length < 2) continue
      const known = bucket.filter((e) => typeof qualityByUrl[e.url] === 'number')
      const resolved = known.length >= 2
      const bestUrl = resolved
        ? known.reduce((a, b) => ((qualityByUrl[b.url] as number) > (qualityByUrl[a.url] as number) ? b : a)).url
        : null
      for (const entry of bucket) {
        const otherNames = bucket
          .filter((o) => o.url !== entry.url)
          .map((o) => streamers.find((s) => s.id === o.streamerId)?.displayName)
          .filter((n): n is string => Boolean(n))
          .join(', ')
        out.set(entry.url, { resolved, isBest: resolved ? entry.url === bestUrl : true, otherNames })
      }
    }
    return out
  }

  /** Buttons to bulk-import every not-yet-loaded, non-duplicate VOD for one group, colour-matched to it. */
  const groupImportButtons = (
    entries: Array<{ streamerId: string; url: string }>,
    cluster: Map<string, MultistreamInfo>
  ): JSX.Element[] => {
    const byGroup = new Map<string, { group: StreamerGroup; urls: string[] }>()
    for (const entry of entries) {
      if (loaded.has(entry.url) || added.has(entry.url)) continue
      if (cluster.get(entry.url)?.isBest === false) continue
      for (const id of streamers.find((s) => s.id === entry.streamerId)?.groupIds ?? []) {
        const group = groups.find((g) => g.id === id)
        if (!group) continue
        const bucket = byGroup.get(id) ?? { group, urls: [] }
        bucket.urls.push(entry.url)
        byGroup.set(id, bucket)
      }
    }
    return [...byGroup.values()].map(({ group, urls }) => (
      <button
        key={group.id}
        type="button"
        className="group-import-btn"
        style={
          group.color
            ? { borderColor: group.color, backgroundColor: `${group.color}22`, color: group.color }
            : undefined
        }
        onClick={() => urls.forEach((url) => importOne(url))}
      >
        {isStreamerGroupIconName(group.icon) && <Icon name={group.icon} size={12} />}
        Import {group.name} ({urls.length})
      </button>
    ))
  }

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

  const overlapEntries = (overlap?.streams ?? []).map((s) => ({ streamerId: s.streamerId, url: s.vod.url }))
  const atTimeEntries = (atTime ?? []).map((h) => ({ streamerId: h.streamer.id, url: h.vod.url }))
  const overlapCluster = clusterInfoFor(overlapEntries)
  const atTimeCluster = clusterInfoFor(atTimeEntries)
  const overlapGroupButtons = groupImportButtons(overlapEntries, overlapCluster)
  const atTimeGroupButtons = groupImportButtons(atTimeEntries, atTimeCluster)

  // Only URLs that are one half of an unresolved multistream pair need a
  // quality lookup — everything else never touches this.
  useEffect(() => {
    const undecided = [...overlapCluster.entries(), ...atTimeCluster.entries()]
      .filter(([url, info]) => !info.resolved && !(url in qualityByUrl))
      .map(([url]) => url)
    const missing = [...new Set(undecided)]
    if (missing.length === 0) return
    void window.api.streamerVodQuality(missing).then((result) => {
      setQualityByUrl((prev) => ({ ...prev, ...result }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlap, atTime, streamers])

  /** One row shape for a VOD, wherever it came from. */
  const vodRow = (
    key: string,
    thumbnailUrl: string | null | undefined,
    heading: JSX.Element,
    meta: JSX.Element,
    url: string,
    multistream?: MultistreamInfo
  ): JSX.Element => {
    const isAdded = loaded.has(url) || added.has(url)
    const isSecondary = multistream !== undefined && multistream.resolved && !multistream.isBest
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
          <div className="vod-meta">
            {meta}
            {multistream && multistream.otherNames !== '' && (
              <Badge tone={!multistream.resolved ? 'neutral' : multistream.isBest ? 'success' : 'warning'}>
                {!multistream.resolved
                  ? 'Multistream — checking quality…'
                  : multistream.isBest
                    ? `Best quality vs ${multistream.otherNames}`
                    : `Lower quality than ${multistream.otherNames}`}
              </Badge>
            )}
          </div>
        </div>
        <Button
          variant={isSecondary ? 'ghost' : 'primary'}
          size="compact"
          icon={isAdded ? 'check' : 'plus'}
          disabled={isAdded}
          onClick={() => importOne(url)}
        >
          {isAdded ? 'Added' : isSecondary ? 'Load anyway' : 'Load as POV'}
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
            <IconButton
              icon="list"
              size="compact"
              label={bulkOpen ? 'Close bulk add' : 'Add a list of streamers at once'}
              onClick={() => setBulkOpen((v) => !v)}
            />
          </div>

          {bulkOpen && (
            <div className="bulk-add">
              <textarea
                className="ui-input bulk-add-input"
                rows={4}
                placeholder={
                  'One channel per line — a link (twitch.tv/name) or just a name,\nadded under the platform selected above.'
                }
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                aria-label="Streamer names or links, one per line"
              />
              <div className="bulk-add-actions">
                <Button
                  size="compact"
                  variant="primary"
                  icon="plus"
                  loading={bulkBusy}
                  disabled={bulkText.trim() === ''}
                  onClick={() => void bulkAdd()}
                >
                  Add all
                </Button>
                <Button size="compact" variant="ghost" onClick={() => setBulkOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

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
                  ...groups.map((g) => ({ value: g.id, label: g.name }))
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

          {shownStreamers.map((streamer) => {
            const linkedWith = streamer.personId
              ? streamers.filter((s) => s.personId === streamer.personId && s.id !== streamer.id)
              : []
            return (
              <div
                key={streamer.id}
                className={`streamer${selected === streamer.id ? ' active' : ''}`}
              >
                <button className="streamer-pick" onClick={() => void loadVods(streamer.id)}>
                  <StreamerAvatar
                    name={streamer.displayName}
                    platform={streamer.platform}
                    url={streamer.avatarUrl}
                  />
                  <span className="streamer-identity">
                    <span className="streamer-name-row">
                      <span className="streamer-name ellipsis">{streamer.displayName}</span>
                      {streamer.favorite && (
                        <Icon name="star" size={12} className="streamer-pinned" />
                      )}
                    </span>
                    <span className="streamer-sub ellipsis">
                      <span className={`streamer-platform is-${streamer.platform}`}>
                        {streamer.platform}
                      </span>
                      {/* The handle is only worth showing when it is not
                          simply the display name in lower case — otherwise it
                          is the same word twice. */}
                      {streamer.handle.toLowerCase() !== streamer.displayName.toLowerCase() && (
                        <span className="streamer-handle">@{streamer.handle}</span>
                      )}
                      {typeof streamer.followers === 'number' && (
                        <span>{compactCount(streamer.followers)} followers</span>
                      )}
                    </span>
                    {(streamer.groupIds?.length ||
                      linkedWith.length > 0 ||
                      streamer.participation?.length) && (
                      <span className="streamer-chips">
                        {(streamer.groupIds ?? []).map((id) => {
                          const group = groups.find((g) => g.id === id)
                          return group ? <GroupChip key={id} group={group} /> : null
                        })}
                        {linkedWith.map((other) => (
                          <span key={other.id} className="ui-badge person-link-chip">
                            <Icon name="link" size={11} />
                            {other.displayName}
                          </span>
                        ))}
                        {/* What this channel has actually been worked on is
                            what makes the library a profile rather than a
                            list of names. */}
                        {(streamer.participation?.length ?? 0) > 0 && (
                          <span
                            className="streamer-events"
                            title={streamer
                              .participation!.map((p) => p.eventName || p.projectName)
                              .join(', ')}
                          >
                            {streamer.participation!.length} event
                            {streamer.participation!.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </button>

                {/* Five always-visible icons per row was most of what made
                    this list feel cluttered; they appear on hover or focus
                    instead, and stay reachable by keyboard either way. */}
                <span className="streamer-actions">
                  <IconButton
                    icon="star"
                    size="compact"
                    selected={streamer.favorite}
                    label={
                      streamer.favorite
                        ? `Unpin ${streamer.displayName}`
                        : `Pin ${streamer.displayName} to the top`
                    }
                    onClick={() => void toggleFavorite(streamer)}
                  />
                  <IconButton
                    icon="copy"
                    size="compact"
                    label={`Copy ${streamer.displayName}'s channel link`}
                    onClick={() => copyChannelLink(streamer)}
                  />
                  <IconButton
                    icon="link"
                    size="compact"
                    label={
                      linkedWith.length > 0
                        ? `Manage same-person links for ${streamer.displayName}`
                        : `Link ${streamer.displayName} to another platform as the same person`
                    }
                    onClick={() => setLinkPickerFor((prev) => (prev === streamer.id ? null : streamer.id))}
                  />
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
                </span>
                {linkPickerFor === streamer.id && (
                  <div className="link-picker">
                    {linkedWith.map((other) => (
                      <span key={other.id} className="ui-badge person-link-chip">
                        {other.displayName}
                        <button
                          type="button"
                          className="person-link-remove"
                          aria-label={`Unlink ${other.displayName}`}
                          onClick={() => void unlinkPerson(streamer.id)}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </span>
                    ))}
                    <Select
                      size="compact"
                      value=""
                      label={`Link ${streamer.displayName} as the same person as`}
                      options={[
                        { value: '', label: 'Choose a streamer…' },
                        ...streamers
                          .filter((s) => s.id !== streamer.id && !linkedWith.some((o) => o.id === s.id))
                          .map((s) => ({ value: s.id, label: `${s.displayName} (${s.platform})` }))
                      ]}
                      onChange={(value) => {
                        if (value) void linkPerson(streamer.id, value)
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })}
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
                      (entry) =>
                        !loaded.has(entry.vod.url) &&
                        !added.has(entry.vod.url) &&
                        overlapCluster.get(entry.vod.url)?.isBest !== false
                    ) && (
                      <Button
                        size="compact"
                        icon="plus"
                        onClick={() => {
                          for (const entry of overlap.streams) {
                            if (overlapCluster.get(entry.vod.url)?.isBest === false) continue
                            importOne(entry.vod.url)
                          }
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

              {!overlapLoading && overlapGroupButtons.length > 0 && (
                <div className="group-import-row">{overlapGroupButtons}</div>
              )}

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
                    entry.vod.url,
                    overlapCluster.get(entry.vod.url)
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
              {atTimeGroupButtons.length > 0 && (
                <div className="group-import-row">{atTimeGroupButtons}</div>
              )}
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
                  hit.vod.url,
                  atTimeCluster.get(hit.vod.url)
                )
              )}
              <hr className="rule" />
            </>
          )}

          {!loading && selected && lastCheckedAt && (
            <div className="hint vod-checked-row">
              <span>checked {timeAgo(lastCheckedAt)}</span>
              <IconButton
                icon="refresh"
                size="compact"
                label="Check again"
                onClick={() => void loadVods(selected)}
              />
            </div>
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
