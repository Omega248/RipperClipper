import { useState } from 'react'
import { clipStatus } from '@shared/status'
import { formatDuration, formatTimecode } from '@shared/time'
import type { ClipSegment } from '@shared/types'
import { useActiveClips, useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import {
  Button,
  ConfirmDialog,
  ContextMenu,
  EmptyState,
  IconButton,
  StatusDot
} from '../ui/index.js'
import type { MenuItem } from '../ui/index.js'

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
  const moveClip = useStore((s) => s.moveClip)
  const setSequenceIndex = useStore((s) => s.setSequenceIndex)
  const setInPoint = useStore((s) => s.setInPoint)
  const setOutPoint = useStore((s) => s.setOutPoint)
  const createClip = useStore((s) => s.createClip)
  const currentTime = useStore((s) => s.currentTime)
  const hasSource = useStore((s) => s.activeSourceId !== null)
  const setPage = useStore((s) => s.setPage)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; clip: ClipSegment } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ClipSegment | null>(null)

  if (clips.length === 0) {
    return (
      <div className="panel-section">
        <EmptyState
          icon="scissors"
          title="No clips yet"
          description="Play to the moment you want, mark where it starts and ends, then add it. Every POV of the same moment comes with it."
          action={{ label: 'Add clip', icon: 'plus', onClick: () => createClip() }}
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
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      danger: true,
      separatorBefore: true,
      onSelect: () => setConfirmDelete(clip)
    }
  ]

  return (
    <div role="list" aria-label="Clips">
      {clips.map((clip, index) => (
        <div
          key={clip.id}
          role="listitem"
          className={`clip-item ${overIndex === index ? 'drag-over' : ''}`}
          aria-selected={clip.id === selectedClipId}
          tabIndex={0}
          onClick={() => selectClip(clip.id)}
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
          draggable
          onDragStart={() => setDragIndex(index)}
          onDragOver={(e) => {
            e.preventDefault()
            setOverIndex(index)
          }}
          onDragLeave={() => setOverIndex((v) => (v === index ? null : v))}
          onDrop={(e) => {
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
          <span className="clip-index" title="Drag to reorder">
            {String(index + 1).padStart(2, '0')}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="clip-name">
              <StatusDot status={clipStatus(clip.status)} />
              {clip.name}
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
                setSequenceIndex(index)
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
    </div>
  )
}
