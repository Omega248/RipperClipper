import { useCallback, useRef, useState } from 'react'
import { pipCompositionAt } from '@shared/timeline'
import { useStore } from '../store.js'
import { usePlayerViewport } from '../player/usePlayerViewport.js'
import TimelineLivePlayer from '../player/TimelineLivePlayer.js'
import type { TimelineLivePlayerHandle } from '../player/TimelineLivePlayer.js'
import Transport from './Transport.js'
import MediaLibrary from './MediaLibrary.js'
import TimelineEditor from './TimelineEditor.js'
import Inspector from './Inspector.js'
import PrepareForEditor from './PrepareForEditor.js'
import WatermarkOverlay from './WatermarkOverlay.js'
import { Icon } from '../ui/index.js'

type SidebarTab = 'library' | 'inspector'

/**
 * The Editor: a dedicated page with its own video viewport, separate from
 * the Video page's. Media Library on the right supplies POV clips; the
 * multi-track timeline along the bottom is where they're arranged into one
 * sequence. Dragging a card onto a track, then watching the playhead move
 * through it here, should never require leaving this page.
 */
export default function EditorPage({
  onExport,
  onShowGuide
}: {
  onExport: () => void
  onShowGuide: () => void
}): JSX.Element {
  const { element: fallbackPlayer, buildPreview } = usePlayerViewport({ onShowGuide })
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.timelinePlayheadSeconds)
  const selectedItemId = useStore((s) => s.selectedTimelineItemId)
  const [tab, setTab] = useState<SidebarTab>('library')
  const [userPickedTab, setUserPickedTab] = useState(false)
  const [showPrepare, setShowPrepare] = useState(false)
  // Whether the live warm-pool player could take the current cut itself —
  // false only for a POV the built-in player can't stream directly, in
  // which case the older build-a-local-proxy player takes over for it.
  const [liveActive, setLiveActive] = useState(false)
  const livePlayerRef = useRef<TimelineLivePlayerHandle>(null)

  const setActiveLive = useCallback((sourceId: string, localSeconds: number): boolean => {
    const ok = livePlayerRef.current?.setActive(sourceId, localSeconds) ?? false
    setLiveActive(ok)
    return ok
  }, [])

  // Selecting a clip is a strong signal the user wants its properties —
  // switch there automatically, but only until they deliberately pick a tab
  // themselves, so the Library doesn't keep getting yanked out from under them.
  if (selectedItemId && tab !== 'inspector' && !userPickedTab) setTab('inspector')

  const pick = (next: SidebarTab): void => {
    setUserPickedTab(true)
    setTab(next)
  }

  const activeItem = project?.timeline ? (pipCompositionAt(project.timeline, playhead)?.background ?? null) : null
  const t = activeItem?.transform
  const playerTransform =
    t && (t.x !== 0 || t.y !== 0 || t.scale !== 1 || t.rotation !== 0)
      ? `translate(${t.x * 50}%, ${t.y * 50}%) scale(${t.scale}) rotate(${t.rotation}deg)`
      : undefined
  const playerOpacity = activeItem?.opacity !== undefined && activeItem.opacity < 1 ? activeItem.opacity : undefined

  return (
    <div className="page editor-page">
      <div className="editor-top">
        <div className="editor-viewport">
          <div className="player-wrap">
            <div
              className="editor-player-transform"
              style={{ transform: playerTransform, opacity: playerOpacity, display: liveActive ? 'block' : 'none' }}
            >
              <TimelineLivePlayer ref={livePlayerRef} timeline={project?.timeline} playheadSeconds={playhead} />
            </div>
            <div style={{ display: liveActive ? 'none' : 'block', width: '100%', height: '100%' }}>
              {fallbackPlayer}
            </div>
            <WatermarkOverlay />
          </div>
          <Transport />
        </div>
        <aside className="editor-library">
          <div className="tabs editor-sidebar-tabs" role="tablist">
            <button
              role="tab"
              className="tab"
              aria-selected={tab === 'library'}
              onClick={() => pick('library')}
            >
              <Icon name="grid" size={14} /> Library
            </button>
            <button
              role="tab"
              className="tab"
              aria-selected={tab === 'inspector'}
              onClick={() => pick('inspector')}
            >
              <Icon name="settings" size={14} /> Inspector
            </button>
          </div>
          <div className="editor-sidebar-body">
            {tab === 'library' ? (
              <MediaLibrary />
            ) : (
              <Inspector onGoToVideo={() => useStore.getState().setPage('video')} />
            )}
          </div>
        </aside>
      </div>
      {showPrepare && <PrepareForEditor onClose={() => setShowPrepare(false)} />}
      <div className="editor-timeline-area">
        <TimelineEditor
          onExport={onExport}
          onWatchSource={buildPreview}
          onSetActiveLive={setActiveLive}
          onPrepare={() => setShowPrepare(true)}
        />
      </div>
    </div>
  )
}
