import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LiveNow,
  PlatformComparison,
  SavedStreamer,
  StreamerGroup,
  StreamerVod,
  StreamerVodShelf,
  VodCrawlProgress
} from '@shared/ipc'
import { isStreamerGroupIconName } from '@shared/streamerGroupIcons'
import { formatDuration } from '@shared/time'
import { personAvatar, personName } from '@shared/people'
import { UNGROUPED, useStore } from '../store.js'
import StreamerAvatar from './StreamerAvatar.js'
import StreamerGroupsDialog from './StreamerGroupsDialog.js'
import { message, title } from './QualityPanel.js'
import {
  Button,
  EmptyState,
  Icon,
  PageHeader,
  PromptDialog,
  SearchInput,
  Spinner
} from '../ui/index.js'

/**
 * The streamer library, as a place rather than a modal.
 *
 * Master-detail rather than a grid of cards, because the thing a person comes
 * here to do is find one broadcast out of somebody's hundreds. A card can say
 * "312 saved VODs"; only a list can let you look through them. So the left
 * column is the roster — narrow, scannable, filterable by group — and the
 * whole rest of the page belongs to whoever is selected.
 *
 * Groups still earn the chips across the top: "show me everyone in PD" is the
 * question the multi-POV workflow actually asks, and a streamer wearing
 * several badges makes the many-to-many obvious without explaining it.
 *
 * The back catalogue arrives slowly — see VodCrawler, which dates one
 * broadcast every few seconds and stands aside during exports. That pace is
 * deliberate, so this page states it plainly rather than letting a
 * half-filled list read as a broken one.
 */
export default function StreamersPage({
  onLoadVod
}: {
  onLoadVod: (url: string) => Promise<void>
}): JSX.Element {
  const streamers = useStore((s) => s.streamers)
  const setStreamers = useStore((s) => s.setStreamers)
  const groupFilter = useStore((s) => s.streamerGroupFilter)
  const setGroupFilter = useStore((s) => s.setStreamerGroupFilter)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setRoute = useStore((s) => s.setRoute)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  // In the store, not local state: the groups are loaded at startup and the
  // rail's group filter reads the same list, so a group renamed here is
  // renamed everywhere without a second fetch.
  const groups = useStore((s) => s.streamerGroups)
  const setGroups = useStore((s) => s.setStreamerGroups)
  const [search, setSearch] = useState('')
  const [vodSearch, setVodSearch] = useState('')
  const [groupsDialog, setGroupsDialog] = useState<SavedStreamer | 'manage' | null>(null)
  const [adding, setAdding] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [shelves, setShelves] = useState<Record<string, StreamerVodShelf | null>>({})
  const [loadingShelf, setLoadingShelf] = useState<string | null>(null)
  const [crawl, setCrawl] = useState<VodCrawlProgress | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  // Both shared with the Backlog and loaded at startup, so the roster draws
  // complete — names, groups and live badges — on its first paint instead of
  // rearranging itself once its own fetches land.
  const live = useStore((s) => s.liveNow)
  const setLive = useStore((s) => s.setLiveNow)

  useEffect(() => {
    void (async () => {
      try {
        const [saved, loadedGroups, progress] = await Promise.all([
          window.api.listStreamers(),
          window.api.listStreamerGroups(),
          window.api.vodCrawlProgress()
        ])
        setStreamers(saved)
        setGroups(loadedGroups)
        setCrawl(progress)
        // Names and pictures fill in behind the list, so it is usable at once
        // and simply gets better a moment later.
        void window.api.refreshStreamerProfiles().then(setStreamers).catch(() => undefined)
      } catch (err) {
        toast({
          kind: 'error',
          title: title(err, 'Could not read your streamers'),
          message: message(err)
        })
      }
    })()
  }, [setStreamers, toast])

  const fetchShelf = useCallback(
    async (id: string, showSpinner: boolean): Promise<void> => {
      if (showSpinner) setLoadingShelf(id)
      try {
        // Asking for a shelf also moves that streamer to the front of the
        // crawl — looking at someone is the clearest statement of what
        // matters now.
        const shelf = await window.api.streamerShelf(id)
        setShelves((prev) => ({ ...prev, [id]: shelf }))
      } catch (err) {
        toast({
          kind: 'error',
          title: title(err, 'Could not read that back catalogue'),
          message: message(err)
        })
      } finally {
        if (showSpinner) setLoadingShelf((cur) => (cur === id ? null : cur))
      }
    },
    [toast]
  )

  /**
   * Follow the crawl on whoever is being looked at.
   *
   * The crawl writes a date every few seconds; without this the list a person
   * is staring at would stay frozen until they clicked away and back. Held in
   * a ref so a progress event does not have to re-subscribe.
   */
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId
  const lastPending = useRef<number | null>(null)

  useEffect(() => {
    return window.api.onVodCrawl((progress) => {
      setCrawl(progress)
      const id = selectedRef.current
      // Only when something could actually have changed on this shelf: a date
      // was recorded somewhere (the pending count moved), or this streamer is
      // the one being read. A tick that only says "still going" is not worth
      // a round trip.
      const moved = lastPending.current !== null && progress.pending !== lastPending.current
      lastPending.current = progress.pending
      if (id && (moved || progress.active !== null)) void fetchShelf(id, false)
    })
  }, [fetchShelf])

  /**
   * Who is on air, rechecked while the page is open.
   *
   * Not persisted anywhere: a live badge is only worth showing if it is
   * current, so it is asked for on arrival and once a minute after, and
   * forgotten when the page closes.
   */
  useEffect(() => {
    let cancelled = false
    const check = (): void => {
      void window.api
        .streamersLive()
        .then((next) => {
          if (!cancelled) setLive(next)
        })
        .catch(() => undefined)
    }
    // The saved snapshot is already in the store from startup, so the roster
    // draws with its live badges in place rather than rearranging itself a
    // second after you look at it. This is the real check, which overwrites it.
    check()
    const timer = setInterval(check, 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  /**
   * Adding a channel by hand. `remember` already saves the channel behind any
   * POV that gets loaded, so this is for the streamer you have not clipped yet
   * — the one you want in the roster before the stream starts.
   */
  const addStreamer = async (input: string): Promise<void> => {
    setAdding(false)
    const trimmed = input.trim()
    if (trimmed === '') return
    const known = new Set(streamers.map((s) => s.id))
    try {
      const saved = await window.api.addStreamer(trimmed)
      setStreamers(saved)
      const added = saved.find((s) => !known.has(s.id))
      if (added) {
        // A filter or a search that hides the row you just added reads as a
        // failed add, so the roster goes back to showing everything.
        setGroupFilter(null)
        setSearch('')
        select(added.id)
        toast({
          kind: 'success',
          title: `Added ${added.displayName}`,
          message: 'Their back catalogue is read in the background.'
        })
      } else {
        toast({
          kind: 'info',
          title: 'Already in your streamers',
          message: `${trimmed} is in the roster.`
        })
      }
    } catch (err) {
      toast({
        kind: 'error',
        title: title(err, 'Could not add that streamer'),
        message: message(err)
      })
    }
  }

  const select = (id: string): void => {
    setSelectedId(id)
    setVodSearch('')
    if (!shelves[id]) void fetchShelf(id, true)
    else void fetchShelf(id, false)
  }

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
        // On air first: someone broadcasting right now is the most useful row
        // on the page, and it is the one thing here that stops being true.
        const liveA = live[a.id] !== undefined
        const liveB = live[b.id] !== undefined
        if (liveA !== liveB) return liveA ? -1 : 1
        // Then pinned, then most recently used — the same order the old dialog
        // used, so muscle memory survives the move.
        if (Boolean(a.favorite) !== Boolean(b.favorite)) return a.favorite ? -1 : 1
        return (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt)
      })
  }, [streamers, groupFilter, search, live])

  /**
   * One row per person, not per account.
   *
   * A restreamer with a Kick, a Twitch and a YouTube channel is one person the
   * editor cares about, and three rows saying the same name is a roster you
   * have to read twice to count. `personId` is what links them (see
   * `linkPerson`); an unlinked streamer is a person of one.
   *
   * The account that fronts the row is whichever is actually on air — that is
   * the one you would click — falling back to the most recently used.
   */
  const people = useMemo(() => {
    const byPerson = new Map<string, SavedStreamer[]>()
    for (const streamer of shown) {
      const key = streamer.personId ?? streamer.id
      const group = byPerson.get(key)
      if (group) group.push(streamer)
      else byPerson.set(key, [streamer])
    }
    return [...byPerson.values()].map((accounts) => {
      const ranked = accounts.slice().sort((a, b) => {
        const liveA = live[a.id] !== undefined
        const liveB = live[b.id] !== undefined
        if (liveA !== liveB) return liveA ? -1 : 1
        return (b.lastUsedAt ?? b.addedAt).localeCompare(a.lastUsedAt ?? a.addedAt)
      })
      return { primary: ranked[0], accounts: ranked }
    })
  }, [shown, live])

  // A filter that hides the selected streamer would leave the right-hand side
  // showing somebody the roster no longer lists.
  useEffect(() => {
    if (selectedId && !shown.some((s) => s.id === selectedId)) setSelectedId(null)
  }, [shown, selectedId])

  // Opening on an empty pane wastes the largest part of the page and makes the
  // roster look like it does nothing, so the top row — whoever is on air, else
  // whoever was used last — is shown straight away.
  useEffect(() => {
    if (selectedId !== null || people.length === 0) return
    const first = people[0].primary.id
    setSelectedId(first)
    void fetchShelf(first, true)
  }, [people, selectedId, fetchShelf])

  const onAir = useMemo(() => Object.keys(live).length, [live])

  const selected = shown.find((s) => s.id === selectedId) ?? null

  const open = async (vod: StreamerVod): Promise<void> => {
    setOpening(vod.url)
    try {
      await onLoadVod(vod.url)
      // loadVod reports its own failures and resolves either way, so success
      // is read from the library rather than assumed: navigating to an empty
      // workspace after a failed resolve would be worse than staying put.
      const project = useStore.getState().project
      const landed = project?.sources.find((s) => s.url === vod.url)
      if (landed) {
        setActiveSource(landed.id)
        setRoute('workspace')
        setPage('video')
      }
    } finally {
      setOpening((cur) => (cur === vod.url ? null : cur))
    }
  }

  return (
    <div className="page streamers-page">
      <PageHeader
        title="Streamers"
        description="The people whose broadcasts you clip, and everything they have broadcast."
        meta={
          streamers.length === 0 ? undefined : (
            <>
              <span>
                {streamers.length} {streamers.length === 1 ? 'streamer' : 'streamers'}
              </span>
              {onAir > 0 && (
                <span className="streamers-meta-live">
                  <span className="live-badge-dot" aria-hidden="true" />
                  {onAir} on air
                </span>
              )}
            </>
          )
        }
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search streamers…" />
            <Button icon="users" onClick={() => setGroupsDialog('manage')}>
              Manage groups
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              Add streamer
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
        <CrawlNote progress={crawl} />
      </div>

      <div className="streamers-split">
        <aside className="streamer-rail" aria-label="Streamers">
          {shown.length === 0 ? (
            <p className="streamer-rail-empty">
              {streamers.length === 0
                ? 'No streamers yet. Add one, or load a POV — its channel is remembered automatically.'
                : 'Nothing matches that filter.'}
            </p>
          ) : (
            people.map(({ primary, accounts }) => (
              <StreamerRow
                key={primary.id}
                streamer={primary}
                accounts={accounts}
                groups={groups}
                shelf={shelves[primary.id] ?? null}
                live={live[primary.id] ?? null}
                liveByStreamer={live}
                selected={accounts.some((a) => a.id === selectedId)}
                onSelect={(id) => select(id)}
              />
            ))
          )}
        </aside>

        <section className="streamer-detail" aria-label="Broadcasts">
          {!selected ? (
            <EmptyState
              icon="users"
              title={streamers.length === 0 ? 'No streamers yet.' : 'Pick a streamer.'}
              description={
                streamers.length === 0
                  ? 'Paste a channel address — twitch.tv/name, kick.com/name or youtube.com/@name — and their broadcasts are read in the background.'
                  : 'Their broadcasts appear here — the back catalogue fills in on its own, oldest channels first.'
              }
              action={
                streamers.length === 0
                  ? { label: 'Add streamer', icon: 'plus', onClick: () => setAdding(true) }
                  : undefined
              }
            />
          ) : (
            <StreamerDetail
              streamer={selected}
              groups={groups}
              shelf={shelves[selected.id] ?? null}
              live={live[selected.id] ?? null}
              siblings={
                selected.personId
                  ? streamers.filter((s) => s.personId === selected.personId)
                  : [selected]
              }
              allStreamers={streamers}
              onMerge={(ids) => {
                void (async () => {
                  try {
                    let saved = streamers
                    for (const other of ids) {
                      saved = await window.api.linkStreamerPerson(selected.id, other)
                    }
                    setStreamers(saved)
                  } catch (err) {
                    toast({
                      kind: 'error',
                      title: title(err, 'Could not merge those rows'),
                      message: message(err)
                    })
                  }
                })()
              }}
              liveByStreamer={live}
              onSwitch={select}
              onDiscover={() => {
                void window.api
                  .discoverStreamerSiblings(selected.id)
                  .then(setStreamers)
                  .catch((err) =>
                    toast({
                      kind: 'error',
                      title: title(err, 'Could not check the other platforms'),
                      message: message(err)
                    })
                  )
              }}
              loading={loadingShelf === selected.id}
              crawl={crawl}
              search={vodSearch}
              opening={opening}
              onSearch={setVodSearch}
              onEditGroups={() => setGroupsDialog(selected)}
              onRefresh={() => {
                void window.api.refreshStreamerVods(selected.id)
                toast({
                  kind: 'info',
                  title: 'Moved to the front of the queue',
                  message: `${selected.displayName}'s channel is read next.`
                })
              }}
              onOpen={open}
              onError={(err) =>
                toast({
                  kind: 'error',
                  title: title(err, 'Could not compare platforms'),
                  message: message(err)
                })
              }
            />
          )}
        </section>
      </div>

      {adding && (
        <PromptDialog
          title="Add streamer"
          description="A name on its own is enough — Twitch, Kick and YouTube are checked for it. A channel address works too."
          label="Name or channel address"
          confirmLabel="Add"
          onConfirm={(value) => void addStreamer(value)}
          onCancel={() => setAdding(false)}
        />
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
              // the roster would silently show nothing with no way back.
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

/**
 * What the background crawl is doing, in one line.
 *
 * Without this a library that is still filling in is indistinguishable from
 * one that is broken, and the honest answer — "it is working through them,
 * slowly, on purpose" — is short enough to just say.
 */
function CrawlNote({ progress }: { progress: VodCrawlProgress | null }): JSX.Element {
  if (!progress || (progress.pending === 0 && !progress.active && !progress.waiting)) {
    return <span className="hint inline">A streamer can sit in more than one group.</span>
  }
  if (progress.waiting) {
    return (
      <span className="crawl-note" role="status">
        <Icon name="pause" size={11} />
        Back catalogue paused while an export is running.
      </span>
    )
  }
  return (
    <span className="crawl-note" role="status">
      <Spinner />
      {progress.active ? `Reading ${progress.active}` : 'Filling in the back catalogue'}
      {progress.pending > 0 && (
        <span className="crawl-note-count mono">{progress.pending.toLocaleString()} to date</span>
      )}
    </span>
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
    <button
      type="button"
      className={`group-chip${on ? ' on' : ''}`}
      aria-pressed={on}
      onClick={onClick}
    >
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

function StreamerRow({
  streamer,
  accounts,
  groups,
  shelf,
  live,
  liveByStreamer,
  selected,
  onSelect
}: {
  streamer: SavedStreamer
  /** Every account this person restreams to, the fronting one included. */
  accounts: SavedStreamer[]
  groups: StreamerGroup[]
  shelf: StreamerVodShelf | null
  live: LiveNow | null
  liveByStreamer: Record<string, LiveNow>
  selected: boolean
  onSelect: (streamerId: string) => void
}): JSX.Element {
  const mine = (streamer.groupIds ?? [])
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is StreamerGroup => Boolean(g))

  return (
    <button
      type="button"
      className={`streamer-row${selected ? ' is-selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(streamer.id)}
    >
      <StreamerAvatar
        name={personName(accounts)}
        platform={streamer.platform}
        url={personAvatar(accounts)}
        size={28}
      />
      <span className="streamer-row-main">
        <span className="streamer-row-name ellipsis">
          {streamer.favorite && <Icon name="star" size={10} />}
          <span className="ellipsis">{personName(accounts)}</span>
          {/* Beside the name, not out on the right: a person on three
              platforms needs that whole line for them, and at 272px the third
              one was being cut in half by the badge. */}
          {live && <LiveBadge live={live} />}
        </span>
        <span className="streamer-row-sub ellipsis">
          {/* Every platform this person restreams to, on the one row. Three
              rows saying the same name is a roster you have to read twice. */}
          {accounts.map((account) => (
            <span
              key={account.id}
              className={`streamer-platform is-${account.platform}${
                liveByStreamer[account.id] ? ' is-on-air' : ''
              }`}
            >
              {account.platform}
            </span>
          ))}
          {/* Group colours as dots: at this width the names would not fit, and
              the badges are still spelled out in the detail header. */}
          {mine.map((group) => (
            <span
              key={group.id}
              className="group-chip-dot"
              style={{ background: group.color }}
              title={group.name}
            />
          ))}
        </span>
      </span>
      {shelf && shelf.vods.length > 0 && (
        <span className="streamer-row-count mono">{shelf.vods.length}</span>
      )}
    </button>
  )
}

function StreamerDetail({
  streamer,
  groups,
  shelf,
  live,
  siblings,
  allStreamers,
  onMerge,
  liveByStreamer,
  onSwitch,
  onDiscover,
  loading,
  crawl,
  search,
  opening,
  onSearch,
  onEditGroups,
  onRefresh,
  onOpen,
  onError
}: {
  streamer: SavedStreamer
  groups: StreamerGroup[]
  shelf: StreamerVodShelf | null
  live: LiveNow | null
  /** Every saved account belonging to this person, this one included. */
  siblings: SavedStreamer[]
  /** The whole roster, so look-alikes can be offered for merging. */
  allStreamers: SavedStreamer[]
  onMerge: (ids: string[]) => void
  liveByStreamer: Record<string, LiveNow>
  onSwitch: (id: string) => void
  onDiscover: () => void
  loading: boolean
  crawl: VodCrawlProgress | null
  search: string
  opening: string | null
  onSearch: (value: string) => void
  onEditGroups: () => void
  onRefresh: () => void
  onOpen: (vod: StreamerVod) => Promise<void>
  onError: (err: unknown) => void
}): JSX.Element {
  const mine = (streamer.groupIds ?? [])
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is StreamerGroup => Boolean(g))

  const vods = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return shelf?.vods ?? []
    return (shelf?.vods ?? []).filter((v) => v.title.toLowerCase().includes(needle))
  }, [shelf, search])

  const undated = (shelf?.vods ?? []).filter((v) => v.publishedAt === null).length

  /*
   * Other rows that are plainly this same person.
   *
   * Matched on the displayed name, not the handle — the handle is exactly what
   * disagrees when a channel ends up saved twice, so keying on it is what let
   * the duplicate through in the first place. A name match is not proof, which
   * is why this is an offer with a count rather than something that happens on
   * its own: the editor looking at the row is the one who knows.
   */
  const lookAlikes = useMemo(() => {
    const mine = new Set(siblings.map((a) => a.id))
    const name = personName(siblings).trim().toLowerCase()
    if (name === '') return []
    return allStreamers.filter(
      (other) => !mine.has(other.id) && other.displayName.trim().toLowerCase() === name
    )
  }, [siblings, allStreamers])

  const [comparison, setComparison] = useState<PlatformComparison | null>(null)
  const [comparing, setComparing] = useState(false)
  // A comparison is about one person; showing the last one against the next
  // streamer would be a quiet lie.
  useEffect(() => {
    setComparison(null)
  }, [streamer.id])

  const compare = async (): Promise<void> => {
    setComparing(true)
    try {
      setComparison(await window.api.compareStreamerPlatforms(streamer.handle))
    } catch (err) {
      onError(err)
    } finally {
      setComparing(false)
    }
  }

  return (
    <>
      <header className="streamer-detail-head">
        <StreamerAvatar
          name={personName(siblings)}
          platform={streamer.platform}
          url={personAvatar(siblings)}
          size={44}
        />
        <div className="streamer-detail-title">
          <div className="streamer-detail-name">
            <span className="ellipsis">{personName(siblings)}</span>
            {live && <LiveBadge live={live} />}
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
          <div className="streamer-detail-meta">
            {/* One person, one row, however many platforms they restream to.
                The switch is the point: the same broadcast may be on three
                and only one of them is worth cutting from. */}
            {siblings.length > 1 ? (
              <span className="platform-switch" role="group" aria-label="Platforms">
                {siblings.map((sibling) => (
                  <button
                    key={sibling.id}
                    type="button"
                    className={`platform-switch-btn${sibling.id === streamer.id ? ' on' : ''}`}
                    aria-pressed={sibling.id === streamer.id}
                    onClick={() => onSwitch(sibling.id)}
                  >
                    <span className={`streamer-platform is-${sibling.platform}`}>
                      {sibling.platform}
                    </span>
                    {liveByStreamer[sibling.id] && <span className="live-badge-dot" />}
                  </button>
                ))}
              </span>
            ) : (
              <span className={`streamer-platform is-${streamer.platform}`}>{streamer.platform}</span>
            )}
            <span>@{streamer.handle}</span>
            {shelf && <span>{shelf.vods.length.toLocaleString()} broadcasts</span>}
            {shelf?.listedAt && (
              <span>Listed {new Date(shelf.listedAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <div className="streamer-detail-actions">
          <SearchInput value={search} onChange={onSearch} placeholder="Search broadcasts…" />
          <Button size="compact" variant="ghost" onClick={onEditGroups}>
            Groups
          </Button>
          <Button size="compact" variant="ghost" icon="refresh" onClick={onRefresh}>
            Read next
          </Button>
          <Button
            size="compact"
            variant="ghost"
            icon="search"
            loading={comparing}
            onClick={() => void compare()}
          >
            Compare platforms
          </Button>
          {lookAlikes.length > 0 ? (
            <Button
              size="compact"
              variant="primary"
              icon="link"
              title={lookAlikes
                .map((o) => `${o.platform}/${o.handle}`)
                .join(', ')}
              onClick={() => onMerge(lookAlikes.map((o) => o.id))}
            >
              Merge {lookAlikes.length} duplicate{lookAlikes.length === 1 ? '' : 's'}
            </Button>
          ) : (
            siblings.length <= 1 && (
              <Button size="compact" variant="ghost" icon="link" onClick={onDiscover}>
                Find elsewhere
              </Button>
            )
          )}
        </div>
      </header>

      {shelf?.error && (
        <p className="streamer-detail-error" role="alert">
          <Icon name="alert" size={12} />
          That channel could not be read: {shelf.error}
        </p>
      )}

      {undated > 0 && (
        <p className="streamer-detail-note">
          {undated.toLocaleString()} of these still need a date. They are worked out one at a
          time in the background — the list reorders itself as the answers arrive.
          {crawl?.waiting && ' Paused for now, while an export runs.'}
        </p>
      )}

      {comparison && (
        <PlatformCompare
          comparison={comparison}
          onClose={() => setComparison(null)}
          onOpen={(url) => void onOpen({ url, title: streamer.displayName, durationSeconds: null, publishedAt: null })}
        />
      )}

      <div className="streamer-vods" role="list">
        {live && (
          <button
            type="button"
            className="streamer-vod-row is-live"
            role="listitem"
            onClick={() => void onOpen({ url: streamer.channelUrl, title: live.title ?? 'Live now', durationSeconds: null, publishedAt: null })}
          >
            <span className="vod-row-main">
              <span className="vod-row-title ellipsis">{live.title ?? 'Broadcasting now'}</span>
              <span className="vod-row-sub">
                <LiveBadge live={live} /> Load the broadcast as it happens — the last few minutes
                are held so you can clip what just went past.
              </span>
            </span>
            <span className="streamer-vod-open">
              {opening === streamer.channelUrl ? <Spinner /> : <Icon name="chevron-right" size={12} />}
            </span>
          </button>
        )}
        {loading && !shelf ? (
          <p className="streamer-detail-note">
            <Spinner /> Reading this channel…
          </p>
        ) : vods.length === 0 ? (
          <EmptyState
            icon="broadcast"
            title={
              !shelf
                ? 'This channel has not been read yet.'
                : search.trim() !== ''
                  ? 'No broadcast matches that.'
                  : shelf.error
                    ? 'Nothing could be listed.'
                    : 'No broadcasts listed for this channel.'
            }
            description={
              !shelf
                ? 'It has been moved to the front of the queue and will appear shortly.'
                : undefined
            }
          />
        ) : (
          vods.map((vod) => (
            <VodRow
              key={vod.url}
              vod={vod}
              busy={opening === vod.url}
              onOpen={() => void onOpen(vod)}
            />
          ))
        )}
      </div>
    </>
  )
}

function VodRow({
  vod,
  busy,
  onOpen
}: {
  vod: StreamerVod
  busy: boolean
  onOpen: () => void
}): JSX.Element {
  // Three states, not two: a date, no date the platform would give, and not
  // asked yet. Only the last is a promise that something is still coming.
  const when =
    vod.publishedAt === null
      ? 'date pending'
      : vod.publishedAt === ''
        ? 'no date'
        : new Date(vod.publishedAt).toLocaleDateString()

  return (
    <button type="button" className="streamer-vod-row" role="listitem" onClick={onOpen}>
      <span className="vod-row-main">
        <span className="vod-row-title ellipsis">{vod.title}</span>
        <span className="vod-row-sub">
          <span className={vod.publishedAt === null ? 'is-pending' : undefined}>{when}</span>
          {vod.durationSeconds !== null && ` · ${formatDuration(vod.durationSeconds)}`}
          {vod.viewCount !== undefined && ` · ${vod.viewCount.toLocaleString()} views`}
        </span>
      </span>
      <span className="streamer-vod-open">
        {busy ? <Spinner /> : <Icon name="chevron-right" size={12} />}
      </span>
    </button>
  )
}

/**
 * On air, stated the same way everywhere.
 *
 * A dot alone would be colour-only, which fails anyone who cannot see the
 * difference — so the word carries the meaning and the dot is decoration.
 */
function LiveBadge({ live }: { live: LiveNow }): JSX.Element {
  return (
    <span className="live-badge" title={live.title}>
      <span className="live-badge-dot" aria-hidden="true" />
      LIVE
      {live.viewers !== undefined && (
        <span className="live-badge-count mono">{live.viewers.toLocaleString()}</span>
      )}
    </span>
  )
}

/**
 * The same person on three platforms, side by side.
 *
 * The point is the one line at the top: which copy of this broadcast to cut
 * from. The rows underneath are the evidence for it, because "trust me" is not
 * good enough when the answer decides what a finished clip looks like.
 */
function PlatformCompare({
  comparison,
  onClose,
  onOpen
}: {
  comparison: PlatformComparison
  onClose: () => void
  onOpen: (url: string) => void
}): JSX.Element {
  const best = comparison.options.find((o) => o.platform === comparison.bestPlatform)

  return (
    <section className="platform-compare" aria-label="Platform comparison">
      <header className="platform-compare-head">
        <span className="platform-compare-verdict">
          {best?.video ? (
            <>
              Best quality on <span className={`streamer-platform is-${best.platform}`}>{best.platform}</span>
              <span className="mono">{best.video.label}</span>
            </>
          ) : (
            'No platform offered a readable broadcast to compare.'
          )}
        </span>
        <Button size="compact" variant="ghost" icon="close" onClick={onClose}>
          Close
        </Button>
      </header>

      <div className="platform-compare-rows">
        {comparison.options.map((option) => (
          <div
            key={option.platform}
            className={`platform-compare-row${option.platform === comparison.bestPlatform ? ' is-best' : ''}`}
          >
            <span className={`streamer-platform is-${option.platform}`}>{option.platform}</span>

            {!option.found ? (
              <span className="platform-compare-note">No channel with this name.</span>
            ) : option.error ? (
              <span className="platform-compare-note is-error">{option.error}</span>
            ) : !option.vod ? (
              <span className="platform-compare-note">Channel exists, but lists no broadcasts.</span>
            ) : (
              <>
                <span className="platform-compare-quality mono">
                  {option.video ? describeQuality(option.video) : 'video unreadable'}
                </span>
                <span className="platform-compare-audio mono">
                  {option.audio ? describeAudioQuality(option.audio) : '—'}
                </span>
                <button
                  type="button"
                  className="platform-compare-vod ellipsis"
                  title={option.vod.title}
                  onClick={() => onOpen(option.vod!.url)}
                >
                  {option.vod.title}
                </button>
                <span className="platform-compare-date mono">
                  {option.vod.publishedAt
                    ? new Date(option.vod.publishedAt).toLocaleDateString()
                    : ''}
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      {/* The dates are shown because they are the caveat: this compares each
          platform's newest broadcast, which is only the same session if the
          restream went out at the same time. */}
      <p className="platform-compare-foot">
        Comparing the newest broadcast on each platform — check the dates line up before trusting
        it for one specific session.
      </p>
    </section>
  )
}

function describeQuality(video: NonNullable<PlatformComparison['options'][number]['video']>): string {
  const parts = [video.height ? `${video.height}p${video.fps ? Math.round(video.fps) : ''}` : video.label]
  if (video.codec) parts.push(video.codec)
  if (video.bitrate) parts.push(`${(video.bitrate / 1_000_000).toFixed(1)} Mbps`)
  return parts.join(' · ')
}

function describeAudioQuality(
  audio: NonNullable<PlatformComparison['options'][number]['audio']>
): string {
  const parts: string[] = []
  if (audio.codec) parts.push(audio.codec)
  if (audio.channels) parts.push(audio.channels === 2 ? 'stereo' : `${audio.channels}ch`)
  if (audio.bitrate) parts.push(`${Math.round(audio.bitrate / 1000)} kbps`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}
