import { useState } from 'react'
import { formatTimecode } from '@shared/time'
import type { MarkerCategory } from '@shared/types'
import { useActiveMarkers, useStore } from '../store.js'
import { playerBus } from '../player/controller.js'
import { Button, EmptyState, Field, IconButton, Input, Select } from '../ui/index.js'

const CATEGORIES: Array<{ value: MarkerCategory; label: string }> = [
  { value: 'funny', label: 'Funny' },
  { value: 'reaction', label: 'Reaction' },
  { value: 'important', label: 'Important' },
  { value: 'idea', label: 'Idea' },
  { value: 'other', label: 'Other' }
]

export default function MarkerPanel(): JSX.Element {
  const markers = useActiveMarkers()
  const addMarker = useStore((s) => s.addMarker)
  const deleteMarker = useStore((s) => s.deleteMarker)
  const markerToClip = useStore((s) => s.markerToClip)
  const activeSourceId = useStore((s) => s.activeSourceId)
  const [label, setLabel] = useState('')
  const [category, setCategory] = useState<MarkerCategory>('other')

  const add = (): void => {
    addMarker(label || undefined, category)
    setLabel('')
  }

  return (
    <div>
      <div className="panel-section">
        <h3>Add marker</h3>
        <div className="rows">
          <Field label="Label" htmlFor="marker-label">
            <Input
              id="marker-label"
              value={label}
              placeholder="Funny death"
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && activeSourceId) add()
              }}
            />
          </Field>
          <Field label="Category" htmlFor="marker-cat">
            <Select
              id="marker-cat"
              block
              value={category}
              options={CATEGORIES}
              onChange={setCategory}
            />
          </Field>
          <Button
            icon="flag"
            fullWidth
            disabled={!activeSourceId}
            onClick={add}
            title="Add a marker at the playhead (M)"
          >
            Marker at playhead
          </Button>
        </div>
      </div>

      <div className="panel-section">
        <h3>Markers ({markers.length})</h3>
        {markers.length === 0 && (
          <EmptyState
            icon="flag"
            title="No markers yet"
            description="Markers flag a moment now so you can turn it into a clip later. Press M while watching."
          />
        )}
        {markers.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>Time</th>
                <th>Label</th>
                <th>Category</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {markers.map((marker) => (
                <tr key={marker.id}>
                  <td>
                    <Button
                      variant="ghost"
                      size="compact"
                      className="mono"
                      onClick={() => playerBus.seek(marker.timeSeconds)}
                      title="Jump here"
                    >
                      {formatTimecode(marker.timeSeconds, { millis: false })}
                    </Button>
                  </td>
                  <td>{marker.label}</td>
                  <td className="dim">{marker.category}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Button
                      variant="ghost"
                      size="compact"
                      icon="scissors"
                      onClick={() => markerToClip(marker.id)}
                      title="Convert to a 30-second clip centred here"
                    >
                      Clip
                    </Button>
                    <IconButton
                      icon="trash"
                      size="compact"
                      label={`Delete marker ${marker.label}`}
                      onClick={() => deleteMarker(marker.id)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
