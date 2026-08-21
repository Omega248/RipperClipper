import { useRef, useState } from 'react'
import { clipStatus } from '@shared/status'
import { formatDuration, formatTimecode } from '@shared/time'
import { tagTone } from '@shared/clipTags'
import { overlappingClipIds } from '@shared/clips'
import { collectionCounts } from '@shared/search'
import type { ClipSegment } from '@shared/types'
import { useActiveClips, useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import {
  Badge,
  Button,
  ConfirmDialog,
  ContextMenu,
  EmptyState,
  Icon,
  IconButton,
  PromptDialog,
  Select,
  StatusDot
} from '../ui/index.js'
import type { MenuItem } from '../ui/index.js'

type SortMode = 'order' | 'duration' | 'povCount' | 'created'

interface Props {
  onExportClip: (clip: ClipSegment) => void
  onShowGuide: () => void
  onFindInPovs: () => void
}

export default function ClipList({ onExportClip, onShowGuide, onFindInPovs }: Props): JSX.Element {
  const clips = useActiveClips()
  const selectedClipId = useStore((s) => s.selectedClipId)
  const selectClip = useStore((s) => s.selectClip)
  const deleteClip = useStore((s) => s.deleteClip)
  const copyClip = useStore((s) => s.copyClip)
  const patchClip = useStore((s) => s.patchClip)
  const patchClips = useStore((s) => s.patchClips)
  const moveClip = useStore((s) => s.moveClip)
  const setSequenceIndex = useStore((s) => s.setSequenceIndex)
  const setInPoint = useStore((s) => s.setInPoint)
  const setOutPoint = useStore((s) => s.setOutPoint)
  const requestCreateClip = useStore((s) => s.requestCreateClip)
  const currentTime = useStore((s) => s.currentTime)
  const hasSource = useStore((s) => s.activeSourceId !== null)
  const setPage = useStore((s) => s.setPage)
  const addClipCollection = useStore((s) => s.addClipCollection)
  const projectEvent = useStore((s) => s.project?.event)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; clip: ClipSegment } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ClipSegment | null>(null)
  const [tagPrompt, setTagPrompt] = useState<ClipSegment | null>(null)
  const [bulkTagPrompt, setBulkTagPrompt] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('order')
  // 'all' shows everything; null shows only the clips in no collection.
  const [collectionFilter, setCollectionFilter] = useState<string | null | 'all'>('all')
  const [newCollection, setNewCollection] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedIndex = useRef<number | null>(null)

  if (clips.length === 0) {
    return (
      <div className="panel-section">
        <EmptyState
          icon="scissors"
          title="No clips yet"
          description="Play to the moment you want, mark where it starts and ends, then add it. Every POV of the same moment comes with it."
          action={{ label: 'Add clip', icon: 'plus', onClick: () => requestCreateClip() }}
        />
        <div className="rows">
          <Button
            fullWidth
            icon="mark-in"
            disabled={!hasSource}
            onClick={() => setInPoint(currentTime)}
            title="Mark the start of a clip at the playhead (I)"
          >
            Mark in at the playhead
          </Button>
          <Button
            fullWidth
            icon="mark-out"
            disabled={!hasSource}
            onClick={() => setOutPoint(currentTime)}
            title="Mark the end of a clip at the playhead (O)"
          >
            Mark out at the playhead
          </Button>
          <Button fullWidth variant="ghost" icon="help" onClick={onShowGuide}>
            How to make a clip
          </Button>
        </div>
      </div>
    )
  }

  /** The same actions as the row buttons, for right-click. */
  const menuItems = (clip: ClipSegment, index: number): MenuItem[] => [
    {
      id: 'open',
      label: 'Jump to this moment',
      icon: 'target',
      onSelect: () => {
        selectClip(clip.id)
        playerBus.seek(clip.startSeconds)
      }
    },
    { id: 'preview', label: 'Preview', icon: 'play', onSelect: () => setSequenceIndex(index) },
    { id: 'find', label: 'Find in all POVs', icon: 'users', onSelect: onFindInPovs },
    {
      id: 'properties',
      label: 'Properties',
      icon: 'settings',
      onSelect: () => {
        selectClip(clip.id)
        setPage('properties')
      },
      separatorBefore: true
    },
    { id: 'duplicate', label: 'Duplicate', icon: 'copy', onSelect: () => copyClip(clip.id) },
    { id: 'export', label: 'Export this clip', icon: 'download', onSelect: () => onExportClip(clip) },
    {
      id: 'tag',
      label: clip.tag ? 'Change tag…' : 'Set tag…',
      icon: 'file',
      separatorBefore: true,
      onSelect: () => setTagPrompt(clip)
    },
    ...(clip.tag
      ? [
          {
            id: 'untag',
            label: 'Clear tag',
            icon: 'close' as const,
            onSelect: () => patchClip(clip.id, { tag: null })
          }
        ]
      : []),
    {
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      danger: true,
      separatorBefore: true,
      onSelect: () => setConfirmDelete(clip)
    }
  ]

  // Filing is a view, never a change to the clips themselves — an unfiled
  // clip is still in the event, just not in a folder.
  const inCollection =
    collectionFilter === 'all' ? clips : clips.filter((c) => (c.collectionId ?? null) === collectionFilter)

  const displayClips =
    sortMode === 'order'
      ? inCollection
      : [...inCollection].sort((a, b) => {
          if (sortMode === 'duration') return b.durationSeconds - a.durationSeconds
          if (sortMode === 'povCount') return (b.povMappings?.length ?? 0) - (a.povMappings?.length ?? 0)
          return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
        })
  const counts = collectionCounts(projectEvent, clips)
  const overlapping = overlappingClipIds(clips)
  const totalDuration = clips.reduce((sum, c) => sum + c.durationSeconds, 0)

  return (
    <div className="clip-list">
      <div className="clip-list-header">
        <span className="hint">
          {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatDuration(totalDuration)}
        </span>
        <Select
          size="compact"
          value={sortMode}
          onChange={(v) => setSortMode(v as SortMode)}
          label="Sort clips"
          options={[
            { value: 'order', label: 'Sort: manual order' },
            { value: 'duration', label: 'Sort: duration' },
            { value: 'povCount', label: 'Sort: POV count' },
            { value: 'created', label: 'Sort: newest first' }
          ]}
        />
        <Select
          size="compact"
          value={collectionFilter === null ? '__unfiled' : collectionFilter}
          onChange={(v) =>
            setCollectionFilter(v === 'all' ? 'all' : v === '__unfiled' ? null : v)
          }
          label="Filter by collection"
          options={[
            { value: 'all', label: 'All collections' },
            ...counts.map((c) => ({
              value: c.id === null ? '__unfiled' : c.id,
              label: `${c.name} (${c.count})`
            }))
          ]}
        />
        <Button
          size="compact"
          icon="plus"
          title="Group clips into a named collection — Bank Entry, Chase, Arrest"
          onClick={() => setNewCollection('')}
        >
          Collection
        </Button>
      </div>

      {newCollection !== null && (
        <PromptDialog
          title="New collection"
          label="Name"
          defaultValue=""
          confirmLabel="Create"
          onCancel={() => setNewCollection(null)}
          onConfirm={(name) => {
            addClipCollection(name)
            setNewCollection(null)
          }}
        />
      )}

      {selectedIds.size > 0 && (
        <div className="clip-bulk-bar">
          <span>{selectedIds.size} selected</span>
          <Button size="compact" icon="file" onClick={() => setBulkTagPrompt(true)}>
            Apply tag
          </Button>
          <Button size="compact" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <div role="list" aria-label="Clips">
      {displayClips.map((clip, index) => (
        <div
          key={clip.id}
          role="listitem"
          className={`clip-item ${overIndex === index ? 'drag-over' : ''} ${selectedIds.has(clip.id) ? 'is-multiselected' : ''}`}
          aria-selected={clip.id === selectedClipId || selectedIds.has(clip.id)}
          tabIndex={0}
          onClick={(e) => {
            if (e.shiftKey && lastClickedIndex.current !== null) {
              const lo = Math.min(lastClickedIndex.current, index)
              const hi = Math.max(lastClickedIndex.current, index)
              setSelectedIds((prev) => {
                const next = new Set(prev)
                for (let i = lo; i <= hi; i++) next.add(displayClips[i].id)
                return next
              })
              return
            }
            if (e.ctrlKey || e.metaKey) {
              setSelectedIds((prev) => {
                const next = new Set(prev)
                if (next.has(clip.id)) next.delete(clip.id)
                else next.add(clip.id)
                return next
              })
              lastClickedIndex.current = index
              return
            }
            setSelectedIds(new Set())
            lastClickedIndex.current = index
            selectClip(clip.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            selectClip(clip.id)
            setMenu({ x: e.clientX, y: e.clientY, clip })
          }}
          onDoubleClick={() => {
            selectClip(clip.id)
            playerBus.seek(clip.startSeconds)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              selectClip(clip.id)
              playerBus.seek(clip.startSeconds)
            }
          }}
          draggable={sortMode === 'order'}
          onDragStart={() => sortMode === 'order' && setDragIndex(index)}
          onDragOver={(e) => {
            if (sortMode !== 'order') return
            e.preventDefault()
            setOverIndex(index)
          }}
          onDragLeave={() => setOverIndex((v) => (v === index ? null : v))}
          onDrop={(e) => {
            if (sortMode !== 'order') return
            e.preventDefault()
            if (dragIndex !== null && dragIndex !== index) moveClip(dragIndex, index)
            setDragIndex(null)
            setOverIndex(null)
          }}
          onDragEnd={() => {
            setDragIndex(null)
            setOverIndex(null)
          }}
        >
          <span className="clip-index" title={sortMode === 'order' ? 'Drag to reorder' : undefined}>
            {String(index + 1).padStart(2, '0')}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="clip-name">
              <StatusDot status={clipStatus(clip.status)} />
              <span className="ellipsis">{clip.name}</span>
              {clip.tag && (
                <Badge tone={tagTone(clip.tag)} glyph="●">
                  {clip.tag}
                </Badge>
              )}
              {overlapping.has(clip.id) && (
                <span title="Overlaps another clip by more than half its length">
                  <Icon name="alert" size={12} />
                </span>
              )}
            </div>
            <div className="clip-times">
              {formatTimecode(clip.startSeconds)} → {formatTimecode(clip.endSeconds)} ·{' '}
              {formatDuration(clip.durationSeconds)}
            </div>
            {clip.lastMessage && <div className="hint">{clip.lastMessage}</div>}
          </div>
          <div className="clip-actions">
            <IconButton
              icon="play"
              size="compact"
              label={`Preview ${clip.name}`}
              onClick={(e) => {
                e.stopPropagation()
                selectClip(clip.id)
                setSequenceIndex(clips.findIndex((c) => c.id === clip.id))
              }}
            />
            <IconButton
              icon="download"
              size="compact"
              label={`Export ${clip.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onExportClip(clip)
              }}
            />
            <IconButton
              icon="more"
              size="compact"
              label={`More actions for ${clip.name}`}
              onClick={(e) => {
                e.stopPropagation()
                const box = (e.target as HTMLElement).getBoundingClientRect()
                setMenu({ x: box.left, y: box.bottom, clip })
              }}
            />
          </div>
        </div>
      ))}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.clip, clips.findIndex((c) => c.id === menu.clip.id))}
          onClose={() => setMenu(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${confirmDelete.name}"?`}
          description="The clip is removed from every POV. Undo (Ctrl+Z) brings it back."
          confirmLabel="Delete clip"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteClip(confirmDelete.id)
            setConfirmDelete(null)
          }}
        />
      )}

      {tagPrompt && (
        <PromptDialog
          title={`Tag "${tagPrompt.name}"`}
          description="A short label for triage — Highlight, Needs review, whatever helps you scan the list. Leave it blank to remove the tag."
          label="Tag"
          defaultValue={tagPrompt.tag ?? ''}
          confirmLabel="Set tag"
          onCancel={() => setTagPrompt(null)}
          onConfirm={(value) => {
            patchClip(tagPrompt.id, { tag: value.trim() === '' ? null : value.trim() })
            setTagPrompt(null)
          }}
        />
      )}

      {bulkTagPrompt && (
        <PromptDialog
          title={`Tag ${selectedIds.size} clip${selectedIds.size === 1 ? '' : 's'}`}
          description="Applies the same triage label to every selected clip. Leave it blank to clear their tags."
          label="Tag"
          confirmLabel="Apply tag"
          onCancel={() => setBulkTagPrompt(false)}
          onConfirm={(value) => {
            patchClips([...selectedIds], { tag: value.trim() === '' ? null : value.trim() })
            setBulkTagPrompt(false)
          }}
        />
      )}
    </div>
  )
}
