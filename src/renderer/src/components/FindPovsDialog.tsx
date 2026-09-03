import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformId } from '@shared/types'
import type { EventOverlapReply } from '@shared/ipc'
import { byMatch, matchVerdict, momentInVod } from '@shared/povMatch'
import {
  byPlatformPriority,
  oneAnglePerStreamer,
  personAliases,
  personKey,
  samePerson
} from '@shared/povPriority'
import type { Coverage } from '@shared/povMatch'
import { formatTimecode } from '@shared/time'
import { Button, Checkbox, Dialog, Icon } from '../ui/index.js'
import StreamerAvatar from './StreamerAvatar.js'
import { useStore } from '../store.js'

/**
 * Who else filmed this moment.
 *
 * Made a clip, and now the app goes and looks — instead of the editor opening
 * Twitch, Kick and YouTube in three tabs and doing the arithmetic by hand for
 * every clip they cut.
 *
 * Two sweeps, in the order they can answer. The saved library is a handful of
 * channel listings and comes back in about a second, so those cards are on
 * screen while the cross-platform sweep — which runs real searches and is the
 * slow one — is still going. Waiting for both before showing anything would
 * make the fast answer as slow as the slow one.
 *
 * Nothing here loads a VOD. A card is built from what the listing already gave
 * us: the channel's picture, the broadcast's own poster, and the matcher's
 * verdict. A POV is only resolved when the editor actually picks it.
 */

interface Candidate {
  key: string
  url: string
  streamerName: string
  /** The saved streamer this came from, when the sweep knew one. */
  streamerId?: string
  platform: PlatformId
  title: string
  thumbnailUrl?: string
  coverage: Coverage
  /** Where in that broadcast the clip begins — carried into the loaded POV. */
  atSeconds: number
}

type Phase = 'library' | 'sweep' | 'done' | 'failed'

const PHASE_LABEL: Record<Phase, string> = {
  library: 'Checking your saved streamers…',
  sweep: 'Searching the platforms…',
  done: '',
  failed: 'The search could not be completed'
}

function fromOverlap(reply: EventOverlapReply): Candidate[] {
  return reply.streams
    .filter((s) => s.availability !== 'loaded')
    .map((s) => ({
      key: s.vod.url,
      url: s.vod.url,
      streamerName: s.streamerName,
      streamerId: s.streamerId,
      platform: s.platform,
      title: s.vod.title,
      thumbnailUrl: s.vod.thumbnailUrl,
      coverage: s.coverage,
      atSeconds: momentInVod(s.coverage)
    }))
}

export default function FindPovsDialog({
  clipName,
  eventStartSeconds,
  eventEndSeconds,
  loadedUrls,
  onAdd,
  onClose
}: {
  clipName: string
  eventStartSeconds: number
  eventEndSeconds: number
  loadedUrls: string[]
  /** Given the chosen broadcasts, newest decision first. */
  onAdd: (picked: Array<{ url: string; atSeconds: number }>) => void
  onClose: () => void
}): JSX.Element {
  const streamers = useStore((s) => s.streamers)
  // Two accounts the library has linked are one person, whatever they are
  // called on each site. Read through a ref so `absorb` stays stable.
  const personOf = useRef(new Map<string, string>())
  personOf.current = new Map(
    streamers.filter((s) => s.personId).map((s) => [s.id, s.personId as string])
  )

  /*
   * People already on the wall, not just URLs already on the wall.
   *
   * Loading somebody's Kick stream and then being offered their Twitch one is
   * the same duplicate the collapse above exists to prevent — it just arrives
   * from the other direction. A POV is a person, so once one of their angles
   * is loaded, none of their others is a candidate.
   */
  const sources = useStore((s) => s.project?.sources)
  const loadedPeople = useRef(new Set<string>())
  loadedPeople.current = new Set(
    (sources ?? [])
      .filter((source) => loadedUrls.includes(source.url))
      .flatMap((source) =>
        personAliases({
          streamerId: streamers.find(
            (saved) =>
              saved.platform === source.platform &&
              saved.handle.toLowerCase() === (source.channelHandle ?? '').toLowerCase()
          )?.id,
          streamerName: source.creator || source.title
        }, (id) => personOf.current.get(id))
      )
  )
  const [phase, setPhase] = useState<Phase>('library')
  const [found, setFound] = useState<Candidate[]>([])
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const [notes, setNotes] = useState<string[]>([])
  const seen = useRef(new Set<string>(loadedUrls))
  /*
   * The search runs once per opening, and this is what makes that true.
   *
   * `loadedUrls` is built with `.map()` by the parent, so it is a new array on
   * every render of the app — and the app re-renders on every playhead tick.
   * As an effect dependency that restarted the whole two-phase sweep several
   * times a second: every platform the search touches, hammered, for as long
   * as the dialog stayed open.
   */
  const startedWith = useRef(loadedUrls)

  /**
   * One card per person, however many sites they broadcast to.
   *
   * A restreamer is on Twitch, Kick and YouTube with the same three hours, so
   * the sweep finds all three and offers the editor a choice that is not one —
   * loading two of them puts the same angle on the wall twice. Collapsed here
   * rather than in the services because both sweeps feed this list and the
   * duplicate only becomes visible once they are merged.
   *
   * Which one survives: the better match first, and Twitch when they tie.
   */
  const absorb = useCallback(
    (next: Candidate[]) => {
      const fresh = next.filter(
        (c) =>
          !seen.current.has(c.url) &&
          !samePerson(personAliases(c, (id) => personOf.current.get(id)), loadedPeople.current)
      )
      for (const c of fresh) seen.current.add(c.url)
      if (fresh.length === 0) return
      setFound((current) =>
        oneAnglePerStreamer(
          [...current, ...fresh].sort(
            (a, b) =>
              byMatch(a.coverage, b.coverage) || byPlatformPriority(a.platform, b.platform)
          ),
          {
            key: (c) => personKey(c, (id) => personOf.current.get(id)),
            platform: (c) => c.platform,
            better: (a, b) => byMatch(a.coverage, b.coverage)
          }
        )
      )
    },
    []
  )

  useEffect(() => {
    let stopped = false
    const run = async (): Promise<void> => {
      try {
        const library = await window.api.streamersCoveringEvent({
          eventStartSeconds,
          eventEndSeconds,
          loadedUrls: startedWith.current
        })
        if (stopped) return
        absorb(fromOverlap(library))
        if (library.unreachable.length > 0) {
          setNotes((n) => [...n, `Could not reach: ${library.unreachable.join(', ')}`])
        }

        setPhase('sweep')
        const sweep = await window.api.discoverEvent({
          startSeconds: eventStartSeconds,
          endSeconds: eventEndSeconds,
          loadedUrls: startedWith.current,
          includeSearch: true
        })
        if (stopped) return
        absorb(
          sweep.streams
            /*
             * The sweep searches by keyword, so it can turn up someone who was
             * simply live at the time — which is not a POV of this moment. The
             * discovery service already scores that; anything it is not at
             * least half sure of stays out rather than padding the list with
             * strangers for the editor to reject one by one.
             */
            .filter((s) => s.confidence >= 0.5)
            .map((s) => ({
              key: s.vod.url,
              url: s.vod.url,
              streamerName: s.streamerName,
              ...(s.streamerId ? { streamerId: s.streamerId } : {}),
              platform: s.platform,
              title: s.vod.title,
              thumbnailUrl: s.thumbnailUrl,
              coverage: s.coverage,
              atSeconds: momentInVod(s.coverage)
            }))
        )
        setNotes((n) => [...n, ...sweep.notes])
        setPhase('done')
      } catch (err) {
        if (stopped) return
        setPhase('failed')
        setNotes((n) => [...n, err instanceof Error ? err.message : String(err)])
      }
    }
    void run()
    return () => {
      stopped = true
    }
  }, [eventStartSeconds, eventEndSeconds, absorb])

  const toggle = (url: string): void =>
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })

  const searching = phase === 'library' || phase === 'sweep'
  const picked = found.filter((c) => chosen.has(c.url))

  return (
    <Dialog
      title={`Other POVs of “${clipName}”`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{picked.length > 0 ? 'Cancel' : 'Done'}</Button>
          <Button
            variant="primary"
            disabled={picked.length === 0}
            onClick={() => onAdd(picked.map((c) => ({ url: c.url, atSeconds: c.atSeconds })))}
          >
            Add {picked.length > 0 ? `${picked.length} POV${picked.length === 1 ? '' : 's'}` : 'POVs'}
          </Button>
        </>
      }
    >
      <div className="findpovs">
        <div className="findpovs-head">
          {searching && (
            <span className="findpovs-progress" role="status">
              <Icon name="refresh" size={14} /> {PHASE_LABEL[phase]}
            </span>
          )}
          {found.length > 0 && (
            <Button
              size="compact"
              onClick={() =>
                setChosen((current) =>
                  current.size === found.length ? new Set() : new Set(found.map((c) => c.url))
                )
              }
            >
              {chosen.size === found.length ? 'Select none' : 'Add all'}
            </Button>
          )}
        </div>

        {found.length === 0 && !searching && (
          <p className="findpovs-empty">
            No matching POVs found. Only broadcasts that actually cover this moment are offered —
            being live at roughly the same time is not the same thing.
          </p>
        )}

        <ul className="findpovs-list">
          {found.map((c) => {
            const verdict = matchVerdict(c.coverage)
            const saved = streamers.find(
              (s) => s.platform === c.platform && s.displayName === c.streamerName
            )
            return (
              <li key={c.key} className={`findpovs-card${chosen.has(c.url) ? ' is-chosen' : ''}`}>
                <StreamerAvatar
                  name={c.streamerName}
                  platform={c.platform}
                  url={saved?.avatarUrl}
                  size={34}
                />
                {c.thumbnailUrl ? (
                  <img className="findpovs-thumb" src={c.thumbnailUrl} alt="" loading="lazy" />
                ) : (
                  <div className="findpovs-thumb is-blank" />
                )}
                <div className="findpovs-meta">
                  <span className="findpovs-name">{c.streamerName}</span>
                  <span className="dim">
                    {c.platform} · {formatTimecode(c.atSeconds, { millis: false })} in
                  </span>
                  <span className="ellipsis dim">{c.title}</span>
                </div>
                <span className={`findpovs-match is-${verdict.strength}`}>{verdict.label}</span>
                <Checkbox
                  checked={chosen.has(c.url)}
                  label={chosen.has(c.url) ? 'Added' : 'Add POV'}
                  onChange={() => toggle(c.url)}
                />
              </li>
            )
          })}
        </ul>

        {notes.length > 0 && (
          <ul className="findpovs-notes">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
