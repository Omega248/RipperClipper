import { useState } from 'react'
import { firstScreenful } from '@shared/multiPov'
import { povLabel } from '@shared/pov'
import { useStore } from '../store.js'
import { Button, Checkbox, Dialog } from '../ui/index.js'

/**
 * Which angles the wall is watching.
 *
 * A wall is limited by the screen long before it is limited by the machine:
 * fourteen angles on one monitor is fourteen thumbnails nobody can read. So
 * the answer to "I have more POVs than fit" is not a bigger grid or a faster
 * decoder, it is choosing — and choosing is a thing the person does, not
 * something the app should infer from the order they happened to add sources.
 *
 * Ticking is deliberately not the same control as the ceiling in Settings.
 * This says *which* angles; the ceiling says *how many* the machine will
 * decode. An angle unticked here gets no tile at all, because a tile reading
 * "you turned this one off" spends the screen the ticking was meant to free.
 */
export default function AnglePicker({ onClose }: { onClose: () => void }): JSX.Element {
  const sources = useStore((s) => s.project?.sources) ?? []
  const focusId = useStore((s) => s.activeSourceId)
  const ceiling = useStore((s) => s.settings?.ui.maxLivePovs) ?? 8
  const setWallAngles = useStore((s) => s.setWallAngles)

  // Edited locally and applied on close, so ticking six angles is one undo
  // step and one re-render of the wall rather than six of each.
  const [hidden, setHidden] = useState(
    () => new Set(sources.filter((s) => s.hiddenInWall === true).map((s) => s.id))
  )

  const shownCount = sources.length - hidden.size
  const overCeiling = Math.max(0, shownCount - ceiling)

  const commit = (): void => {
    setWallAngles([...hidden])
    onClose()
  }

  return (
    <Dialog
      title="Angles on screen"
      description={`${shownCount} of ${sources.length} showing. The focused angle always stays — it carries the clock and the sound.`}
      size="small"
      onClose={commit}
      footer={
        <>
          <Button
            size="compact"
            onClick={() => setHidden(new Set())}
            disabled={hidden.size === 0}
          >
            Show all
          </Button>
          <Button
            size="compact"
            onClick={() => setHidden(new Set(firstScreenful(sources, focusId ?? undefined, ceiling)))}
            disabled={sources.length <= ceiling}
          >
            First {ceiling}
          </Button>
          <Button variant="primary" size="compact" onClick={commit}>
            Done
          </Button>
        </>
      }
    >
      <ul className="angle-picker">
        {sources.map((source) => {
          const isFocus = source.id === focusId
          const checked = isFocus || !hidden.has(source.id)
          return (
            <li key={source.id}>
              <Checkbox
                checked={checked}
                disabled={isFocus}
                label={povLabel(source)}
                onChange={(on) => {
                  const next = new Set(hidden)
                  if (on) next.delete(source.id)
                  else next.add(source.id)
                  setHidden(next)
                }}
              />
              {isFocus && <span className="hint inline">focused</span>}
            </li>
          )
        })}
      </ul>
      {overCeiling > 0 && (
        <p className="hint">
          {overCeiling} more than your machine ceiling of {ceiling}, so {overCeiling} tile
          {overCeiling === 1 ? '' : 's'} will show a still rather than decode. Untick some, or
          raise the ceiling in Settings → Playback.
        </p>
      )}
    </Dialog>
  )
}
