import { useMemo, useState } from 'react'
import { estimateExpiry } from '@shared/expiry'
import { povColor } from '@shared/povColors'
import { formatTimecode } from '@shared/time'
import type { PlatformId } from '@shared/types'
import { useStore } from '../store.js'
import { povLabel } from './PovBar.js'
import EventDiscovery from './EventDiscovery.js'
import { message, title } from './QualityPanel.js'
import { Badge, Button, EmptyState, Input, PageHeader, Select } from '../ui/index.js'

/**
 * The footage: what is loaded, and what could be.
 *
 * A POV row leads with the thing that actually decides what to do next —
 * whether it is aligned to the event clock, and how long the platform will
 * keep it. Twitch drops VODs after a fortnight, so "about 3 days left" is
 * more actionable here than any amount of metadata.
 */
export default function VodsPage({
  onLoadVod
}: {
  onLoadVod: (url: string) => Promise<void>
}): JSX.Element {
  const project = useStore((s) => s.project)
  const setActiveSource = useStore((s) => s.setActiveSource)
  const setRoute = useStore((s) => s.setRoute)
  const setPage = useStore((s) => s.setPage)
  const toast = useStore((s) => s.toast)

  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [showDiscovery, setShowDiscovery] = useState(false)

  const sources = project?.sources ?? []
  const shown = useMemo(
    () => (platform === 'all' ? sources : sources.filter((s) => s.platform === platform)),
    [sources, platform]
  )

  const load = async (): Promise<void> => {
    if (url.trim() === '') return
    setLoading(true)
    try {
      await onLoadVod(url.trim())
      setUrl('')
    } catch (err) {
      toast({ kind: 'error', title: title(err, 'Could not load that VOD'), message: message(err) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page vods-page">
      <PageHeader
        title="VODs"
        description="Every angle loaded into this event, and where to find more."
        actions={
          <>
            <Input
              value={url}
              placeholder="Paste a Twitch, Kick or YouTube link"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load()
              }}
            />
            <Button variant="primary" icon="plus" loading={loading} onClick={() => void load()}>
              Load as POV
            </Button>
          </>
        }
      />

      <div className="vods-filters">
        <Select
          size="compact"
          label="Platform"
          value={platform}
          options={[
            { value: 'all', label: 'All platforms' },
            { value: 'twitch', label: 'Twitch' },
            { value: 'kick', label: 'Kick' },
            { value: 'youtube', label: 'YouTube' }
          ]}
          onChange={(v) => setPlatform(v as PlatformId | 'all')}
        />
        <span className="spacer" />
        <Button icon="search" onClick={() => setShowDiscovery(true)}>
          Find POVs by time
        </Button>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon="monitor"
          title={sources.length === 0 ? 'No POVs loaded yet.' : 'Nothing on that platform.'}
          description={
            sources.length === 0
              ? 'Paste a link above, or use "Find POVs by time" to sweep for everyone who was live.'
              : undefined
          }
        />
      ) : (
        <ul className="vod-rows">
          {shown.map((source, index) => {
            const expiry = estimateExpiry(source.platform, source.createdAt)
            const synced = Boolean(source.syncMapping)
            return (
              <li key={source.id}>
                <button
                  type="button"
                  className="vod-row"
                  onClick={() => {
                    setActiveSource(source.id)
                    setRoute('workspace')
                    setPage('video')
                  }}
                >
                  <span
                    className="vod-row-colour"
                    style={{ background: povColor(source.id) }}
                    aria-hidden="true"
                  />
                  <span className="vod-row-main">
                    <span className="vod-row-name ellipsis">
                      {povLabel(source, sources.indexOf(source) < 0 ? index : sources.indexOf(source))}
                    </span>
                    <span className="vod-row-title ellipsis">{source.title}</span>
                  </span>

                  <span className={`streamer-platform is-${source.platform}`}>{source.platform}</span>

                  <span className="vod-row-when mono">
                    {source.createdAt ? new Date(source.createdAt).toLocaleDateString() : '—'}
                  </span>
                  <span className="vod-row-len mono">
                    {formatTimecode(source.durationSeconds, { millis: false })}
                  </span>

                  {/* Alignment is what decides whether this POV can be used at
                      all, so it outranks everything else on the row. */}
                  <span className="vod-row-status">
                    {synced ? (
                      <Badge tone="success">Aligned</Badge>
                    ) : (
                      <Badge tone="danger">Needs aligning</Badge>
                    )}
                    {expiry.urgency !== 'permanent' && expiry.urgency !== 'unknown' && (
                      <Badge tone={expiry.urgency === 'safe' ? 'neutral' : 'warning'}>
                        {expiry.label}
                      </Badge>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {showDiscovery && (
        <EventDiscovery onClose={() => setShowDiscovery(false)} onLoadVod={onLoadVod} />
      )}
    </div>
  )
}
