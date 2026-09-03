import { useMemo, useState } from 'react'
import { clipsInCollection, collectionCounts } from '@shared/search'
import { sortedCollections, unusedPovIds, workflowOf } from '@shared/collections'
import { CLIP_WORKFLOW_LABEL, CLIP_WORKFLOW_ORDER } from '@shared/types'
import type { ClipSegment, ClipWorkflowState } from '@shared/types'
import { povColor, povTint } from '@shared/povColors'
import { formatDuration, formatTimecode } from '@shared/time'
import { LOOSE, useStore } from '../store.js'
import ClipTimeline from './ClipTimeline.js'
import ClipThumbnails from './ClipThumbnails.js'
import {
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  PromptDialog,
  Select
} from '../ui/index.js'

/**
 * Every clip in the event, filed.
 *
 * Collections are the reason this earns a page. They have been in the data
 * model with only a dropdown to show for it, and a dropdown is the wrong
 * shape: filing is something you do *while* looking at the clips, so the
 * folders belong beside them, permanently, with their counts visible.
 *
 * The rail's footer states the contract deliberately — filing is presentation,
 * never truth. Deleting a collection keeps its clips; moving one changes
 * nothing about when the moment happened or what gets exported.
 */
export default function ClipsPage(): JSX.Element {
  const project = useStore((s) => s.project)
  const filter = useStore((s) => s.collectionFilter)
  const setFilter = useStore((s) => s.setCollectionFilter)
  const selectedClipId = useStore((s) => s.selectedClipId)
  const selectClip = useStore((s) => s.selectClip)
  const addClipCollection = useStore((s) => s.addClipCollection)
  const removeClipCollection = useStore((s) => s.removeClipCollection)
  const setClipCollectionId = useStore((s) => s.setClipCollectionId)
  const setClipWorkflowState = useStore((s) => s.setClipWorkflowState)
  const patchClip = useStore((s) => s.patchClip)
  const deleteClip = useStore((s) => s.deleteClip)

  const [newCollection, setNewCollection] = useState(false)
  const [renaming, setRenaming] = useState<ClipSegment | null>(null)
  const [sort, setSort] = useState<'event' | 'name' | 'duration'>('event')

  const clips = project?.clips ?? []
  const sources = project?.sources ?? []
  const collections = sortedCollections(project?.event)
  const counts = collectionCounts(project?.event, clips)

  const shown = useMemo(() => {
    const base =
      filter === null
        ? clips
        : filter === LOOSE
          ? clipsInCollection(clips, null)
          : clipsInCollection(clips, filter)
    return [...base].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'duration') return b.durationSeconds - a.durationSeconds
      // Event time is the natural order: it is the order things happened.
      return (a.eventStartTime ?? a.startSeconds) - (b.eventStartTime ?? b.startSeconds)
    })
  }, [clips, filter, sort])

  const selected = clips.find((c) => c.id === selectedClipId) ?? null

  if (!project) {
    return <EmptyState icon="scissors" title="Open a project to see its clips." />
  }

  return (
    <div className="clips-page">
      {/* ---- collection rail ---- */}
      <aside className="collection-rail">
        <h3 className="collection-rail-head">Collections</h3>

        <CollectionRow
          label="All clips"
          count={clips.length}
          on={filter === null}
          onClick={() => setFilter(null)}
        />

        {collections.map((collection) => (
          <CollectionRow
            key={collection.id}
            label={collection.name}
            count={counts.find((c) => c.id === collection.id)?.count ?? 0}
            colour={povColor(collection.id)}
            on={filter === collection.id}
            onClick={() => setFilter(collection.id)}
            onRemove={() => {
              // Clips survive; only the folder goes.
              removeClipCollection(collection.id)
              if (filter === collection.id) setFilter(null)
            }}
          />
        ))}

        <CollectionRow
          label="Loose in event"
          count={counts.find((c) => c.id === null)?.count ?? 0}
          on={filter === LOOSE}
          onClick={() => setFilter(LOOSE)}
        />

        <Button size="compact" variant="ghost" icon="plus" onClick={() => setNewCollection(true)}>
          New collection
        </Button>

        <p className="collection-rail-note">
          Filing a clip is presentation, not truth — it changes nothing about when the moment
          happened or what gets exported.
        </p>
      </aside>

      {/* ---- clip grid ---- */}
      <div className="clips-main">
        <PageHeader
          title="Clips"
          description={`${project.name} · ${clips.length} moment${clips.length === 1 ? '' : 's'} across ${sources.length} POV${sources.length === 1 ? '' : 's'}.`}
          actions={
            <Select
              size="compact"
              label="Sort clips"
              value={sort}
              options={[
                { value: 'event', label: 'Sort: event time' },
                { value: 'name', label: 'Sort: name' },
                { value: 'duration', label: 'Sort: duration' }
              ]}
              onChange={(v) => setSort(v as typeof sort)}
            />
          }
        />

        {shown.length === 0 ? (
          <EmptyState
            icon="scissors"
            title={clips.length === 0 ? 'No clips yet.' : 'Nothing filed here.'}
            description={
              clips.length === 0
                ? 'Mark a moment on the Video page and it appears here.'
                : 'Drag a clip onto a collection, or pick another one.'
            }
          />
        ) : (
          // Past a couple of hundred cards, keep the off-screen ones out of
          // layout and paint. Same trade the VODs list makes, and for the same
          // reason: at this scale the chrome is what costs, not the data.
          <div className={`clip-grid${shown.length > 200 ? ' is-long' : ''}`}>
            {shown.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                sources={sources}
                collectionName={
                  collections.find((c) => c.id === clip.collectionId)?.name ?? 'Loose in event'
                }
                selected={clip.id === selectedClipId}
                onSelect={() => selectClip(clip.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---- clip detail ---- */}
      {selected && (
        <ClipDetail
          clip={selected}
          collections={collections.map((c) => ({ id: c.id, name: c.name }))}
          onRename={() => setRenaming(selected)}
          onDelete={() => deleteClip(selected.id)}
          onFile={(collectionId) => setClipCollectionId(selected.id, collectionId)}
          onWorkflow={(state) => setClipWorkflowState(selected.id, state)}
        />
      )}

      {newCollection && (
        <PromptDialog
          title="New collection"
          label="Name"
          confirmLabel="Create"
          onCancel={() => setNewCollection(false)}
          onConfirm={(name) => {
            addClipCollection(name)
            setNewCollection(false)
          }}
        />
      )}

      {renaming && (
        <PromptDialog
          title="Rename clip"
          label="Name"
          defaultValue={renaming.name}
          confirmLabel="Rename"
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            patchClip(renaming.id, { name })
            setRenaming(null)
          }}
        />
      )}
    </div>
  )
}

function CollectionRow({
  label,
  count,
  on,
  colour,
  onClick,
  onRemove
}: {
  label: string
  count: number
  on: boolean
  colour?: string
  onClick: () => void
  onRemove?: () => void
}): JSX.Element {
  return (
    <div className={`collection-row${on ? ' on' : ''}`}>
      <button type="button" className="collection-row-pick" aria-pressed={on} onClick={onClick}>
        {colour ? (
          <span className="collection-dot" style={{ background: colour }} aria-hidden="true" />
        ) : (
          <span className="collection-dot is-none" aria-hidden="true" />
        )}
        <span className="ellipsis">{label}</span>
        <span className="collection-count mono">{count}</span>
      </button>
      {onRemove && (
        <IconButton
          icon="trash"
          size="compact"
          label={`Remove the ${label} collection — its clips stay in the event`}
          onClick={onRemove}
        />
      )}
    </div>
  )
}

function ClipCard({
  clip,
  sources,
  collectionName,
  selected,
  onSelect
}: {
  clip: ClipSegment
  sources: Array<{ id: string }>
  collectionName: string
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const state = workflowOf(clip)
  // The card's wash is the POV it was authored from, so a glance down the grid
  // groups by angle without anything being labelled.
  const tint = povTint(clip.sourceId, 22)
  const covering = (clip.povMappings ?? []).filter(
    (m) => m.status === 'available' || m.status === 'partial'
  )

  return (
    <button
      type="button"
      className={`clip-card${selected ? ' on' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span
        className="clip-card-thumb"
        style={{ background: `linear-gradient(150deg, ${tint}, var(--stage))` }}
      >
        <span className={`clip-workflow is-${state}`}>{CLIP_WORKFLOW_LABEL[state]}</span>
        <span className="clip-duration mono">{formatDuration(clip.durationSeconds)}</span>
      </span>

      <span className="clip-card-body">
        <span className="clip-kicker ellipsis">{collectionName}</span>
        <span className="clip-card-name ellipsis">{clip.name}</span>
        <span className="clip-card-range mono ellipsis">
          {formatTimecode(clip.startSeconds, { millis: false })} →{' '}
          {formatTimecode(clip.endSeconds, { millis: false })}
        </span>

        <span className="clip-pips">
          {sources.map((source) => {
            const covered = covering.some((m) => m.sourceId === source.id)
            return (
              <span
                key={source.id}
                className={`clip-pip${covered ? '' : ' is-empty'}`}
                style={covered ? { background: povColor(source.id) } : undefined}
              />
            )
          })}
          <span className="clip-pip-label">
            {covering.length} POV{covering.length === 1 ? '' : 's'}
          </span>
        </span>
      </span>
    </button>
  )
}

function ClipDetail({
  clip,
  collections,
  onRename,
  onDelete,
  onFile,
  onWorkflow
}: {
  clip: ClipSegment
  collections: Array<{ id: string; name: string }>
  onRename: () => void
  onDelete: () => void
  onFile: (collectionId: string | null) => void
  onWorkflow: (state: ClipWorkflowState) => void
}): JSX.Element {
  const [tab, setTab] = useState<'overview' | 'states'>('overview')
  const unused = unusedPovIds(clip)

  return (
    <aside className="clip-detail">
      <header className="clip-detail-head">
        <span className="clip-kicker">Clip</span>
        <div className="clip-detail-title">
          <h2 className="ellipsis">{clip.name}</h2>
          <IconButton icon="edit" size="compact" label="Rename this clip" onClick={onRename} />
          <IconButton icon="trash" size="compact" label="Delete this clip" onClick={onDelete} />
        </div>
        <span className="mono clip-detail-range">
          {formatTimecode(clip.startSeconds, { millis: false })} →{' '}
          {formatTimecode(clip.endSeconds, { millis: false })} ·{' '}
          {formatDuration(clip.durationSeconds)}
        </span>
      </header>

      <div className="tabs clip-detail-tabs" role="tablist">
        {(
          [
            ['overview', 'Overview'],
            ['states', 'States']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            className="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="clip-detail-body">
        {tab === 'overview' && (
          <>
            <ClipThumbnails clip={clip} />
            <ClipTimeline clip={clip} compact />
            {unused.length > 0 && (
              <p className="hint">
                {unused.length} POV{unused.length === 1 ? '' : 's'} cover this moment but
                {unused.length === 1 ? ' has' : ' have'} not been used.
              </p>
            )}
          </>
        )}


        {tab === 'states' && (
          <div className="clip-states">
            <label className="field-inline">
              <span>Stage</span>
              <Select
                size="compact"
                label="Workflow state"
                value={workflowOf(clip)}
                options={CLIP_WORKFLOW_ORDER.map((state) => ({
                  value: state,
                  label: CLIP_WORKFLOW_LABEL[state]
                }))}
                onChange={(v) => onWorkflow(v as ClipWorkflowState)}
              />
            </label>
            <label className="field-inline">
              <span>Collection</span>
              <Select
                size="compact"
                label="Collection"
                value={clip.collectionId ?? ''}
                options={[
                  { value: '', label: 'Loose in event' },
                  ...collections.map((c) => ({ value: c.id, label: c.name }))
                ]}
                onChange={(v) => onFile(v === '' ? null : v)}
              />
            </label>
          </div>
        )}
      </div>
    </aside>
  )
}
