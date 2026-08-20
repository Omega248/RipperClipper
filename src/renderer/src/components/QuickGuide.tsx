import { Button, Dialog } from '../ui/index.js'

interface Props {
  onClose: () => void
}

interface Step {
  title: string
  body: JSX.Element
}

/**
 * The workflow, in the order it actually happens. The guide exists so the
 * interface does not have to explain itself in place — the pages stay clean
 * and the explanation is one keystroke away.
 */
const STEPS: Step[] = [
  {
    title: 'Find the VOD',
    body: (
      <p>
        Paste a Twitch, Kick or YouTube address into the bar at the top, or pick a saved streamer
        and choose one of their recent broadcasts. It is streamed for preview — nothing is written
        to your computer yet.
      </p>
    )
  },
  {
    title: 'Load the other POVs',
    body: (
      <p>
        Add every angle of the same event with <strong>Add POV</strong>. They line up on one shared
        clock, so a clip you make in one appears in all of them.
      </p>
    )
  },
  {
    title: 'Mark the moment',
    body: (
      <p>
        Play to it, then press <strong>Mark in</strong> and <strong>Mark out</strong> — or hold{' '}
        <span className="kbd">Shift</span> and drag across the timeline. Keyboard:{' '}
        <span className="kbd">I</span> and <span className="kbd">O</span>.
      </p>
    )
  },
  {
    title: 'Add the clip',
    body: (
      <p>
        Press <strong>Add clip</strong> or <span className="kbd">Enter</span>. Rename it, reorder
        it, or set its boundaries to the millisecond on the Properties page.
      </p>
    )
  },
  {
    title: 'Review every angle',
    body: (
      <p>
        The clip timeline shows one lane per POV, so you can see who covered the whole moment and
        who joined late. Click a lane to cut to that angle at the same instant.
      </p>
    )
  },
  {
    title: 'Review the sound',
    body: (
      <p>
        The Audio page finds strong language in each angle separately and proposes what to do about
        it. Nothing is changed until you approve it, and you can hear before and after first.
      </p>
    )
  },
  {
    title: 'Export',
    body: (
      <p>
        The Export page shows exactly what will be written and where, then queues it. Only the
        parts of each VOD your clips cover are ever downloaded.
      </p>
    )
  }
]

const KEYS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['I / O', 'Mark in / mark out'],
  ['Enter', 'Add the marked range as a clip'],
  ['M', 'Drop a marker at the playhead'],
  ['F', 'Find this moment in every POV'],
  ['J / L', 'Previous / next clip'],
  ['P', 'Loop the selected clip'],
  ['= / -', 'Zoom the timeline'],
  ['Ctrl + Z', 'Undo'],
  ['Ctrl + Shift + Z', 'Redo'],
  ['Ctrl + S', 'Save the project']
]

export default function QuickGuide({ onClose }: Props): JSX.Element {
  return (
    <Dialog
      title="How Ripper Clipper works"
      description="Find a VOD, load the other angles, mark the moment, review it, export it."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <div className="guide-steps">
        {STEPS.map((step, index) => (
          <div className="guide-step" key={step.title}>
            <span className="step" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <h4>{step.title}</h4>
              {step.body}
            </div>
          </div>
        ))}
      </div>

      <hr className="rule" />

      <h3>Keyboard</h3>
      <table className="grid">
        <tbody>
          {KEYS.map(([keys, what]) => (
            <tr key={keys}>
              <td style={{ width: 150 }}>
                <span className="kbd">{keys}</span>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  )
}
