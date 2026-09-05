# Session handoff — 2026-08-30

Follows `plans/HANDOFF-SESSION-2026-08-29b.md`. Everything below was written,
typechecked, tested and built **on Linux only**. `npm test` and `npm run build`
have still never been run on Windows, and this session touched a lot of hot
paths — see §6.

Verification at the end of the session: **663 unit tests, 84 integration tests,
clean `npm run build`**, against ffmpeg 4.4.2 and 7.0.2.

---

## 1. Features added

### Live status for saved streamers
`streamerProfile.ts` gained `fetchLive` — Twitch GQL (`stream` is null when
offline), Kick's channel API (`livestream`, already being fetched for avatars),
and YouTube's `/streams` flat playlist (`live_status: 'is_live'`). No new
mechanism: each platform already answered this on a route being called anyway.

`StreamerService.liveNow()` fans out through the existing profile limiter,
caches for 45s in memory, and writes `<stateDir>/streamer-live.json` so a cold
start draws badges immediately (`liveCached()`; snapshots older than 5 minutes
are ignored). YouTube is re-checked only every 5 minutes because its check
costs a yt-dlp process — the others are plain HTTP.

### One row per person, across platforms
`personId`/`linkPerson` already existed. Added `discoverSiblings(id)`: looks up
the same handle on the other two platforms, saves what it finds, links it.
Runs automatically on add and on "remember a POV", once per streamer
(`siblingsCheckedAt`), and **only when `streamers.autoDiscoverSiblings` is set**
— see §5.

`src/shared/people.ts` holds `personName` (a published profile name beats a
slug; capitals beat none) and `personAvatar` (a real picture on any platform
beats a placeholder — matched on `user-default-pictures`,
`default-profile-pictures`, dicebear, gravatar).

The roster groups by `personId`, shows every platform on one row with a dot on
whichever are on air, and the detail header has a platform switcher.

### Platform quality comparison
`services/crossPlatform.ts` — profile check, newest broadcast, full resolve,
then `selectStreams` + `rankVideo`, which is the same ranking the exporter uses
so the verdict and the exported file agree. `bestOf` is unit-tested.
**Caveat, stated in the UI:** compares each platform's *newest* broadcast, not a
matched session.

### Clipping a live broadcast from go-live
All three platforms publish a recording *while* the broadcast runs.
`LiveBuffer` already had a `findArchive` socket that only fired after the
stream ended; it now also polls while live (`recordingPollMs`: 10s, easing to
2min). On a hit, `LiveState.recordingVodId` is set **without changing `state`**,
the main process resolves that recording as an ordinary VOD, and the store
swaps it in as the POV's media — duration, playback URL, formats — keeping the
id, title and **sync mapping**, which every already-marked clip is anchored to.

The payoff is that nothing downstream learns about live: it is a growing HLS
playlist, so player, timeline, segment selection, smart cut and export all work
unchanged. Re-read once a minute to follow the end.

**Unverified.** Needs a live broadcast on each platform. If a platform does not
publish until the stream ends, that POV silently keeps the rolling buffer.

### Dating a channel in one request
`twitchVideoDates(login)` asks the same GQL endpoint for 100 videos and their
publish times in one call. `bulkVodDates` maps them onto VOD urls; the crawler
tries bulk before its paced one-at-a-time path. A 300-VOD Twitch channel goes
from ~17 minutes of yt-dlp processes to one tick. Kick's listing already
carried dates; YouTube keeps the slow path.

---

## 2. Bugs fixed

- **Multi-POV live showed "Not recording at this moment" on every angle but
  the one being listened to.** `followerTargets` bounded followers by
  `durationSeconds`, which for a live source is a floor that moves. Three
  distinct failure modes (no sync mapping, negative time because clocks start
  when watching began, time past the floor). A live angle now always gets a
  target — the mapped time when usable, its own live edge otherwise.
- **`FollowerVideo` could not follow a live angle.** It seeks an absolute time
  in a playlist that only holds a sliding DVR window, so the seek was ignored,
  the drift never closed, and it re-seeked every tick. Now clamps to
  `video.seekable` and opens live angles at their edge.
- **Watch page came up squashed until the window was resized.** Two causes:
  `.main.all-povs` still honoured a saved `--timeline-height` while
  `.timeline-stack` was capped at 20vh, leaving dead background and squeezing
  the tiles; and `usePanelSize` clamped on drag and resize but never on the
  value coming out of settings.
- **Streamers VOD rows squeezed into a 62px sliver.** The markup carried
  `className="vod-row streamer-vod-row"`, and `.vod-row` is the VODs page's
  eight-column template defined ~1200 lines further down the file.
- `columnsFor` was fixed at 4 columns past nine angles; now roughly square, so
  20 POVs are 5×4 rather than 4×5 on a stage wider than it is tall.

---

## 3. Performance audit (three parallel agent audits, findings verified by hand)

Applied:

**Main process**
- `channelVodEntries` called `channelVods`, which dates every broadcast, then
  discarded the dates — once a minute per live POV. Now uses the cheap listing.
  *(A regression introduced by the recording work earlier the same session.)*
- Export progress pushed the whole job list over IPC once per segment written
  (~1,400 per four-hour window, times concurrency). Throttled to 4 Hz; stage
  changes and terminal states still go through immediately.
- Live buffers ran a per-source 1s prune timer that evicted nothing, because
  `ingest` already prunes. Removed; `setWindow` now prunes for itself.
- Live segments were sharing the app-wide limiter, which *widens* with export
  concurrency — exports could take every slot until a live buffer fell off the
  edge. Live has its own pool of 12.
- "Maximum cache size" governed only the segment cache; four others added
  ~2.4 GB it never counted. All five now take a share.

**Media**
- **Cache eviction sorts by mtime and reads never touched it**, so a segment
  shared by five overlapping clips looked *older* than one written once and
  never wanted again — the cache evicted exactly what it exists to keep. Hits
  now touch the file.
- The HLS media playlist (~200 KB, 1,400 entries) was re-fetched and re-parsed
  per window, by six different callers. Finished playlists (`endList`) are now
  held; live ones still read fresh.
- **Player and exporter share the segment cache.** Whole-segment GETs read from
  and write through it via `setMediaSegmentStore`; ranged requests and
  manifests pass through untouched. Previously every second watched across 9–20
  angles was downloaded again to export it.
- Abandoned `.partial.mp4` previews were excluded from the size sum and deleted
  by nothing. Swept when stale, counted while in flight.
- `combine()` forked one ffprobe per part simultaneously. Bounded to 4.

**Renderer**
- `App`, `AppHeader` and `usePlayerViewport` called `useStore()` with no
  selector, subscribing to every write including `currentTime` at 4 Hz — and
  **there is no `React.memo` anywhere in the renderer**, so that re-rendered
  the rail, every POV tile, the transport, the clip list and the timeline on
  every tick. Now shallow-compared over named fields.
- `Timeline` rebuilt its ResizeObserver 4×/sec (and `observe()` fires
  immediately, forcing a second repaint each time).
- `ClipList` subscribed to `currentTime` for a value read only inside two click
  handlers; `FollowerVideo` called `play()` on every playing tile every tick;
  `PovGrid` ran a filter per tile per tick.
- Filmstrip/waveform/thumbnail caches were unbounded Maps of base64 data URLs
  whose keys embed a clip's trimmed range, so every drag stranded an entry.
  Bounded via `renderer/src/boundedCache.ts`.
- `.streamer-vods` rows get `content-visibility` like the other long lists.

### Not applied — the ranked backlog
1. Two overlapping keyframe probes per export; a redundant full probe per HTTP
   window.
2. A failed HLS window leaves its other in-flight segment downloads running.
3. Event-coverage lookups refetch every channel uncached.
4. The cache prune stats the whole directory every 256 MB.
5. `TimelineLivePlayer` creates unbounded hls.js instances — `PovGrid` caps
   this with `AUTO_LIVE_TILES`, that path caps nothing.
6. Canvas timeline fully repaints on every mouse move (`setHoverTime`).
7. `WatermarkOverlay` does one IPC round-trip per tile.
8. No `React.memo` anywhere; the six-live-decoder budget picks by list order
   rather than by what is on screen.

---

## 4. Deliberately NOT cached

`SourceService.formatCache` is memory-only with a 4-minute TTL, and that is
correct: format entries hold **signed** CDN URLs that expire. Persisting them
would mean confidently loading a VOD from disk and getting 403s — the failure
`player/diagnose.ts` exists to explain.

The right version of that idea, still unbuilt: split the resolve and persist
only the stable half — title, duration, published date, resolution, fps, codec
— keyed by VOD url, while signed URLs stay ephemeral. That also folds in
`probeQuality`, which today is a full yt-dlp resolve for an answer that never
changes.

---

## 5. Gotchas worth knowing before editing

- **Background work inside `StreamerService` broke four tests**: unawaited
  writes landed after the temp directory was torn down. Sibling discovery is
  therefore opt-in via `autoDiscoverSiblings`, set by the app at startup and
  left off in tests. Any future fire-and-forget write in a service needs the
  same treatment.
- `personName`/`personAvatar` live in `src/shared/people.ts`, not in the page
  component: `tsconfig.node.json` includes `tests/`, and a test importing a
  `.tsx` fails the build with "--jsx is not set".
- **Rendering the page against the real stylesheets caught two layout bugs that
  reading could not.** Copy `app.css`, `tokens.css`, `ui.css`, `index.css` into
  a scratch dir, write a page with the real markup, screenshot it with
  headless Chromium. Far cheaper than a Windows rebuild.
- `mediaProxy` tests do not pass a `segments` store, so they only cover the
  uncached path. The shared-cache path has no coverage.

---

## 6. What to do next, in order

1. **Windows.** `npm test` and `npm run build`, then exercise the app. Two
   sessions of work have never run there, and this one changed the media proxy,
   the export queue's IPC, cache eviction, the live buffer's limiter and the
   renderer's subscription model.
2. **Watch playback specifically** — the proxy sharing the segment cache is the
   riskiest change and the least covered.
3. **Test live on Kick first** (most of the library): both the multi-POV fix
   and the go-live recording need a real broadcast. The log says
   `Found the recording of a broadcast in progress` with the vod id, and
   `Clipping the whole broadcast from its recording` with the seconds covered.
4. Then §3's backlog, top down.

`claude/build-status.md` in the project is still badly stale — "CookieClipper",
228 tests, features listed as unimplemented that now exist.
