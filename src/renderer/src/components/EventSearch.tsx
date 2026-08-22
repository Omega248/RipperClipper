import { useMemo, useState } from 'react'
import { searchEvent } from '@shared/search'
import type { SearchResult } from '@shared/search'
import { eventToLocal, isSynced } from '@shared/sync'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import { Badge, Button, Dialog, EmptyState, SearchInput } from '../ui/index.js'

/**
 * Find anything in this project.
 *
 * Clips, POVs, collections and moments all answer the same box, because
 * "find the bank thing" should not require first deciding what kind of thing
 * the bank thing is. Results carry their real-world time where they have one,
 * so acting on a result puts the right POV at the right instant.
 */

const KIND_LABEL: Record<SearchResult['kind'], string> = {
  clip: 'Clip',
  pov: 'POV',
  collection: 'Collection',
  moment: 'Moment'
}

export default function EventSearch({ onClose }: { onClose: () => void }): JSX.Element {
  const project = useStore((s) => s.project)
  const selectClip = useStore((s) => s.selectClip)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setCurrentTime = useStore((s) => s.setCurrentTime)
  const setPage = useStore((s) => s.setPage)

  const [query, setQuery] = useState('')
  const sources = project?.sources ?? []

  const results = useMemo(() => {
    if (!project) return []
    return searchEvent(
      { project, povName: (source) => povLabel(source, sources.indexOf(source)) },
      query
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, query])

  /** Put the editor on whatever this result actually is. */
  const open = (result: SearchResult): void => {
    if (result.kind === 'clip') {
      selectClip(result.id)
      setPage('video')
      onClose()
      return
    }
    if (result.kind === 'pov') {
      setActiveSource(result.id)
      setPage('video')
      onClose()
      return
    }
    if (result.kind === 'moment' && result.eventTimeSeconds !== undefined) {
      // A moment belongs to the event rather than a POV, so it opens in
      // whichever angle can actually show that instant.
      const source = sources.find((s) => s.syncMapping && isSynced(s.syncMapping))
      if (source?.syncMapping) {
        const local = eventToLocal(source.syncMapping, result.eventTimeSeconds)
        setActiveSource(source.id)
        if (local !== null) setCurrentTime(local)
        setPage('video')
        onClose()
      }
      return
    }
    onClose()
  }

  return (
    <Dialog
      title="Search"
      description="Clips, POVs, collections and moments."
      size="large"
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <SearchInput value={query} onChange={setQuery} autoFocus placeholder="Search clips and POVs…" />

      {query.trim() === '' ? (
        <EmptyState icon="search" title="Start typing." />
      ) : results.length === 0 ? (
        <EmptyState icon="search" title={`Nothing matches "${query}".`} />
      ) : (
        <ul className="search-results">
          {results.map((result) => (
            <li key={`${result.kind}:${result.id}`}>
              <button className="search-result" onClick={() => open(result)}>
                <Badge>{KIND_LABEL[result.kind]}</Badge>
                <span className="search-result-title ellipsis">{result.title}</span>
                {result.subtitle && <span className="search-result-sub ellipsis">{result.subtitle}</span>}
                {result.eventTimeSeconds !== undefined && (
                  <span className="mono search-result-time">
                    {new Date(result.eventTimeSeconds * 1000).toLocaleTimeString()}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
