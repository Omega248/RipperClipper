import { useCallback, useEffect, useMemo, useState } from 'react'
import { useActiveSource, useStore } from '../store.js'
import HlsPlayer from './HlsPlayer.js'
import { message, title } from '../components/QualityPanel.js'
import { Button, ErrorState, Icon } from '../ui/index.js'

/**
 * How far a built preview reaches past the range it was asked for — shared
 * with the Editor's prefetch (`media/prefetch.ts`) so a clip warmed at
 * creation time and the exact range the Editor later plays hash to the same
 * cached asset instead of narrowly missing each other by a few seconds.
 */
export const PREVIEW_PAD_SECONDS = 5

/**
 * The video viewport: whichever POV is active, played through the app's own
 * player. Extracted so the Video page and the Editor page can each mount
 * their own instance — the underlying `playerBus` only ever drives one
 * attached `<video>` at a time, so exactly one of these may be on screen at
 * once, which the two pages already guarantee by being mutually exclusive.
 *
 * Some sources hand the player media it cannot decode — YouTube's better
 * formats in particular. Rather than hiding that, `buildPreview` turns the
 * range being worked on into something playable and points the player at it.
 * The Editor also uses this as its own media source, the way a normal
 * editor works from ingested/optimized proxies rather than live streams —
 * see the call in TimelineEditor's `watch()`.
 */
export function usePlayerViewport(opts: { onShowGuide: () => void }): {
  element: JSX.Element
  buildPreview: (
    target?: { startSeconds: number; endSeconds: number } | null,
    buildOpts?: { silent?: boolean }
  ) => Promise<void>
  makingPreview: string | null
  playerError: string | null
} {
  const source = useActiveSource()
  const store = useStore()
  const [madePreview, setMadePreview] = useState<{
    sourceId: string
    url: string
    startSeconds: number
    endSeconds: number
    reason: string
  } | null>(null)
  const [makingPreview, setMakingPreview] = useState<string | null>(null)
  const [playerError, setPlayerError] = useState<string | null>(null)

  // A stale error from a previous POV must never bleed into a freshly loaded
  // one — each source gets a clean slate.
  useEffect(() => {
    setPlayerError(null)
  }, [source?.id])

  const buildPreview = useCallback(
    async (
      target?: { startSeconds: number; endSeconds: number } | null,
      buildOpts?: { silent?: boolean }
    ): Promise<void> => {
      const state = useStore.getState()
      const src = state.project?.sources.find((s) => s.id === state.activeSourceId)
      if (!src) return
      const clip =
        target ?? state.project?.clips.find((c) => c.id === state.selectedClipId) ?? null
      // Around the clip if there is one, otherwise around the playhead: never
      // the whole VOD.
      const from = clip ? Math.max(0, clip.startSeconds - PREVIEW_PAD_SECONDS) : Math.max(0, state.currentTime - 30)
      const to = clip
        ? Math.min(src.durationSeconds, clip.endSeconds + PREVIEW_PAD_SECONDS)
        : Math.min(src.durationSeconds, Math.max(60, state.currentTime + 90))
      if (!buildOpts?.silent) setMakingPreview('Preparing a playable preview of this range…')
      try {
        const result = await window.api.previewMedia({ source: src, startSeconds: from, endSeconds: to })
        setMadePreview({
          sourceId: src.id,
          url: result.url,
          startSeconds: result.startSeconds,
          endSeconds: result.endSeconds,
          reason: result.reason
        })
        setPlayerError(null)
      } catch (err) {
        // A background (Editor) preload failing is not worth interrupting
        // anyone over — playback just falls back to the live stream, same as
        // before this existed.
        if (!buildOpts?.silent) {
          state.toast({ kind: 'error', title: title(err, 'Preview failed'), message: message(err) })
        }
      } finally {
        if (!buildOpts?.silent) setMakingPreview(null)
      }
    },
    []
  )

  const element = useMemo(() => {
    if (!source) {
      return (
        <div className="player-empty">
          <Icon name="scissors" size={26} />
          <h2>Let's make some clips</h2>
          <p>
            Paste a Twitch, Kick or YouTube VOD link above and press <span className="kbd">Load</span>.
          </p>
          <p>
            The VOD is streamed for preview — nothing is written to disk until you export a clip, and
            only the parts covering your selections are ever downloaded.
          </p>
          <Button icon="help" onClick={opts.onShowGuide}>
            Show me how it works
          </Button>
        </div>
      )
    }
    if (madePreview && madePreview.sourceId === source.id) {
      return <HlsPlayer src={madePreview.url} progressive onFatalError={setPlayerError} />
    }
    if (playerError) {
      return (
        <ErrorState
          title="Preview unavailable"
          description="This recording is not in a form the built-in player can show. Ripper Clipper can make the range you are working on playable instead — exporting is unaffected either way, because it always works from the original streams."
          details={playerError}
          actions={
            <>
              <Button variant="primary" loading={makingPreview !== null} onClick={() => void buildPreview()}>
                Make this range playable
              </Button>
              <Button onClick={() => setPlayerError(null)}>Try again</Button>
              <Button variant="ghost" icon="external" onClick={() => void window.api.openPath(source.url)}>
                Open in browser
              </Button>
            </>
          }
        />
      )
    }
    if (source.playbackUrl && (source.playbackKind === 'hls' || source.playbackKind === 'progressive')) {
      // Preview traffic goes through the app's own local proxy so it is always
      // same-origin; platform CDNs do not reliably send CORS headers.
      const base = store.env?.mediaProxyBase
      const kind = source.playbackKind === 'hls' ? 'manifest' : 'segment'
      const src = base
        ? `${base}/media/${kind}?u=${encodeURIComponent(source.playbackUrl)}`
        : source.playbackUrl
      return (
        <HlsPlayer
          // Deliberately not keyed by src: keeping the same <video> across a POV
          // switch avoids tearing the element out of the DOM and rebuilding it,
          // which is both faster and removes the mount/unmount race entirely.
          src={src}
          progressive={source.playbackKind === 'progressive'}
          onFatalError={setPlayerError}
        />
      )
    }
    return (
      <ErrorState
        title="No preview available"
        description="This platform only offers this recording as separate video and audio streams, which the built-in player cannot combine. Exporting is unaffected — it uses the best video and audio the source offers."
        actions={
          <Button variant="primary" loading={makingPreview !== null} onClick={() => void buildPreview()}>
            Make this range playable
          </Button>
        }
      />
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, playerError, madePreview, makingPreview, store.env?.mediaProxyBase, buildPreview])

  return { element, buildPreview, makingPreview, playerError }
}
