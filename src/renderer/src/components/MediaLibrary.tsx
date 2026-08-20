import { useMemo, useState } from 'react'
import { clipRangeInPov } from '@shared/povMapping'
import { povLabel } from '@shared/pov'
import { formatDuration } from '@shared/time'
import type { ClipSegment, VodSource } from '@shared/types'
import { useStore } from '../store.js'
import { EmptyState, Icon, SearchInput } from '../ui/index.js'

/** What a drag from the library carries: one clip, seen from one POV. */
export const DRAG_MIME = 'application/x-clip-pov'
export interface ClipPovDragPayload {
  clipId: string
  povId: string
}

type Filter = 'all' | 'used' | 'unused'

/**
 * Every clip in the project, broken out by the POVs that cover it — the drag
 * source for the timeline.
 *
 * A "clip" and a "clip as seen from POV B" are different things to drag: the
 * same moment can go on the timeline once per angle, and each one needs its
 * own card so the editor can tell them apart and drop the right one. See
 * shared/povMapping.ts for how a clip's range projects into another POV.
 */
export default function MediaLibrary(): JSX.Element {
  const project = useStore((s) => s.project)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const usedSourceIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of project?.timeline?.items ?? []) ids.add(`${item.sourceClipId}:${item.sourceId}`)
    return ids
  }, [project?.timeline?.items])

  const cards = useMemo(() => {
    if (!project) return []
    const out: Array<{ clip: ClipSegment; source: VodSource; localStart: number; localEnd: number; used: boolean }> = []
    for (const clip of project.clips) {
      for (const source of project.sources) {
        const range = clipRangeInPov(clip, source)
        if (range.coverage === 'none') continue
        out.push({
          clip,
          source,
          localStart: range.localStart,
          localEnd: range.localEnd,
          used: usedSourceIds.has(`${clip.id}:${source.id}`)
        })
      }
    }
    return out
  }, [project, usedSourceIds])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return cards.filter((c) => {
      if (filter === 'used' && !c.used) return false
      if (filter === 'unused' && c.used) return false
      if (needle === '') return true
      return (
        c.clip.name.toLowerCase().includes(needle) ||
        povLabel(c.source).toLowerCase().includes(needle) ||
        c.source.title.toLowerCase().includes(needle) ||
        c.source.platform.toLowerCase().includes(needle)
      )
    })
  }, [cards, query, filter])

  const counts = {
    all: cards.length,
    used: cards.filter((c) => c.used).length,
    unused: cards.filter((c) => !c.used).length
  }

  return (
    <div className="media-library">
      <div className="media-library-head">
        <SearchInput value={query} onChange={setQuery} placeholder="Search clips and POVs" label="Search media" />
        <div className="filter-group">
          {(['all', 'used', 'unused'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`chip${filter === f ? ' on' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'used' ? 'Used' : 'Unused'}
              <span className="chip-count">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="media-library-list">
        {shown.length === 0 ? (
          <EmptyState
            icon="scissors"
            title={cards.length === 0 ? 'No clips yet' : 'Nothing matches'}
            description={
              cards.length === 0
                ? 'Clips you make on the Video page show up here, once per POV that covers them.'
                : 'Try a different search or filter.'
            }
          />
        ) : (
          shown.map((c) => (
            <div
              key={`${c.clip.id}:${c.source.id}`}
              className={`media-card${c.used ? ' used' : ''}`}
              draggable
              onDragStart={(e) => {
                const payload: ClipPovDragPayload = { clipId: c.clip.id, povId: c.source.id }
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              title={`Drag onto a video or audio track — ${c.clip.name} from ${povLabel(c.source)}`}
            >
              <Icon name="grip" />
              <div className="media-card-body">
                <div className="media-card-name ellipsis">{c.clip.name}</div>
                <div className="media-card-meta">
                  <span className="pill">{povLabel(c.source)}</span>
                  <span className="dim">{formatDuration(c.localEnd - c.localStart)}</span>
                  {c.used && <span className="dim">on timeline</span>}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
