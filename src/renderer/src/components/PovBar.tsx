import { useState } from 'react'
import { formatDuration } from '@shared/time'
import type { VodSource } from '@shared/types'
import { useStore } from '../store.js'
import { Badge, Button, ConfirmDialog, IconButton, Tooltip } from '../ui/index.js'

interface Props {
  onAddPov: () => void
  onFindInPovs: () => void
  onManualSync: () => void
}

/**
 * The POVs in this event, as one card list.
 *
 * Each card answers the four questions the editor actually asks of an angle —
 * who is it, what platform, how long, and can its timing be trusted — and the
 * selected one is marked by a surface and a rail rather than by a border that
 * makes every card look like a separate widget.
 */
export default function PovBar({ onAddPov, onFindInPovs, onManualSync }: Props): JSX.Element | null {
  const sources = useStore((s) => s.project?.sources)
  const activeSourceId = useStore((s) => s.activeSourceId)
  const switchPov = useStore((s) => s.setActiveSource)
  const removeSource = useStore((s) => s.removeSource)
  const clips = useStore((s) => s.project?.clips)
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string; clips: number } | null>(
    null
  )

  if (!sources || sources.length === 0) return null

  return (
    <div className="povbar" role="tablist" aria-label="Points of view">
      <span className="povbar-label">POVs</span>
      {/* The cards scroll; the actions beside them never do. */}
      <div className="povbar-scroll">
        {sources.map((source, index) => {
          const own = clips?.filter((c) => c.sourceId === source.id).length ?? 0
          const name = povLabel(source, index)
          return (
            <div key={source.id} className="pov-slot">
              <button
                role="tab"
                className="pov"
                aria-selected={source.id === activeSourceId}
                onClick={() => switchPov(source.id)}
                title={source.title}
              >
                <span className="pov-name">{name}</span>
                <span className="pov-meta">
                  <span className="tag">{source.platform}</span>
                  <span>{formatDuration(source.durationSeconds)}</span>
                  {own > 0 && (
                    <span>
                      {own} clip{own === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
                <SyncBadge source={source} />
              </button>
              <IconButton
                icon="close"
                size="compact"
                className="pov-remove"
                label={`Remove ${name}`}
                onClick={() => {
                  if (own > 0) setConfirmRemove({ id: source.id, name, clips: own })
                  else removeSource(source.id)
                }}
              />
            </div>
          )
        })}
      </div>

      <div className="povbar-actions">
        <Button icon="plus" onClick={onAddPov} title="Load another angle of this event">
          Add POV
        </Button>
        <Button
          icon="target"
          onClick={onFindInPovs}
          disabled={sources.length < 2}
          title="Show this exact real-world moment in every POV (F)"
        >
          Find in all POVs
        </Button>
        <Button
          icon="waveform"
          onClick={onManualSync}
          disabled={sources.length < 2}
          title="Line two POVs up by their sound and correct the timing by hand"
        >
          Align POVs
        </Button>
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${confirmRemove.name}?`}
          description={`Its ${confirmRemove.clips} clip${
            confirmRemove.clips === 1 ? '' : 's'
          } are removed with it. Undo (Ctrl+Z) brings them back.`}
          confirmLabel="Remove POV"
          destructive
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            removeSource(confirmRemove.id)
            setConfirmRemove(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * How far the POV's placement on the event clock can be trusted, in the
 * application's shared status words rather than a percentage nobody can act
 * on. The exact figure and method stay in the tooltip for when it matters.
 */
function SyncBadge({ source }: { source: VodSource }): JSX.Element {
  const mapping = source.syncMapping
  if (!mapping || mapping.method === 'unsynced' || mapping.vodStartRealTime === null) {
    return (
      <Tooltip content="This POV has no known real-world start time yet, so it cannot be lined up with the others. Use Align POVs.">
        <span>
          <Badge tone="warning" glyph="▲">
            Not aligned
          </Badge>
        </span>
      </Tooltip>
    )
  }
  const pct = Math.round(mapping.confidence * 100)
  const tone = pct >= 90 ? 'success' : pct >= 70 ? 'info' : 'warning'
  const label = pct >= 90 ? 'Aligned' : pct >= 70 ? 'Aligned' : 'Check alignment'
  return (
    <Tooltip content={`Timing confidence ${pct}% — ${mapping.method.replace(/_/g, ' ')}`}>
      <span>
        <Badge tone={tone} glyph={pct >= 70 ? '✓' : '▲'}>
          {label}
        </Badge>
      </span>
    </Tooltip>
  )
}

/** Character name wins, then the streamer, then the VOD title. */
export function povLabel(source: VodSource, index: number): string {
  return (
    source.character?.trim() ||
    source.povName?.trim() ||
    source.creator?.trim() ||
    source.title?.trim() ||
    `POV ${index + 1}`
  )
}
