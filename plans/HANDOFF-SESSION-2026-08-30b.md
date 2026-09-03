# Handoff — 2026-08-30 (b): the editor rework, and every POV at once

Continues `plans/HANDOFF-SESSION-2026-08-30.md`.

## What was asked

> Rework the entire video editor/clip editor. I want it to be flawless and think
> of everything make it featrure packed etc. Also ensure that all povs can run at
> the same time

## Every POV at once

The wall was capped at six live decoders (`AUTO_LIVE_TILES` in `PovGrid.tsx`);
angles past that showed "Click to watch — a few angles play at a time". The cap
existed for a real reason — a follower was decoding whatever rendition the
bandwidth estimate picked, so a 300px tile happily ran the 1080p60 rung, and a
dozen of those locked the window.

The cost was removed rather than the symptom:

- `FollowerVideo` sets `capLevelToPlayerSize` and `capLevelOnFPSDrop`, so each
  tile decodes roughly what it can actually show, and the whole wall steps down
  a rung together if the machine still can't keep up.
- `maxBufferSize: 8 MB` per follower (and per warm editor POV) bounds memory in
  bytes, not only in seconds.
- An `IntersectionObserver` stops segment loading for a tile scrolled out of
  view and resumes it on the way back.

With that, `livePovBudget(count, cap)` (`shared/multiPov.ts`) returns *every*
angle by default. The grid layout is a shape, not a budget — "4 across" no
longer switches angles off. `Settings → Appearance → Angles at once` is the only
ceiling, default `0` = no limit.

## The editor

`TimelineEditor.tsx` was a track list with an empty `<div>` for a ruler. It now has:

- **A real ruler** — adaptive ticks off a readable ladder (0.1s → 6h), labelled
  timecode, click or drag anywhere to scrub, arrow keys when focused.
- **A marker lane** — `timeline.markers` existed in the model and had no UI at
  all. Double-click to drop, drag to move, double-click to rename, right-click
  to remove, click to jump.
- **One scrolling canvas** — ruler, markers and every track scroll as one piece,
  with the header column and the ruler pinned. Ctrl+wheel zooms about the
  pointer; Shift+wheel pans; the playhead is kept on screen while playing.
- **Zoom that stops fighting you** — auto-fit refits as the sequence changes
  *until you zoom yourself*; `Fit` (or F) puts it back on the leash. Previously
  every trim threw your zoom away.
- **Multi-selection** — shift/ctrl-click and a rubber-band marquee, group drag
  keeping internal spacing, group delete/duplicate/copy/paste.
- **Linked picture and sound actually linked** — `withLinked()` is applied to
  every edit, so dragging a video item no longer desynchronises the audio item
  underneath it. `shared/timeline.ts` still acts on exactly the id it is given;
  the linking is spelled once, in one place.
- **Keyboard** — S split, Delete, Ctrl+D/C/V/X, Ctrl+A, ←/→ nudge (frame;
  Shift = second), `[` `]` trim to playhead, M marker, F fit, Home/End, Escape.
  Registered on the *capture* phase so it beats the app-wide clip shortcuts,
  which mean different things on the Video page.
- **Right-click menu** on items: play from here, split, duplicate, copy, toggle
  picture-in-picture, unlink, close the gap before this, remove.
- **Snap on/off** (it was permanently on), snapping to edges, markers *and* the
  playhead.
- **Tracks** — two-row headers (six controls and a name never fitted on one),
  inline rename, reorder up/down, item counts, locked tracks hatched and inert.
- **A status bar** — playhead timecode, sequence length, selection count and
  duration, and the key map.

New pure modules, all tested without a DOM:

- `shared/timelineView.ts` — `tickSpacing`, `rulerTicks`, `fitPxPerSecond`,
  `snapCandidates`, `nearestSnap`, `snapSpanStart`.
- `shared/timeline.ts` additions — `withLinked`, `moveItems`, `nudgeItems`,
  `deleteItems`, `splitItemsAt`, `itemsInSpan`, `closeGapAt`, `reorderTrack`.

Store: `selectedTimelineItemIds` (a set; `selectedTimelineItemId` stays as its
last member, which is what the Inspector edits), `timelineSnap`,
`timelineClipboard`, and the actions above.

## Channel

The Editor now ships on `experimental` as well as `dev`
(`electron.vite.config.ts`). `stable` still drops the whole module graph —
verified: no `EditorPage` chunk in a stable build, one in an experimental build.

## Verified

- 725 unit tests, 84 integration (`hwEncoding.test.ts` still needs libsvtav1,
  unchanged and unrelated).
- `tsc` clean on both projects; `electron-vite build` clean on stable and
  experimental.
- The editor was rendered headless against the real stylesheets, which is what
  caught the squashed track headers.

## Still open

- Windows `npm test` / `npm run build` — still never run there.
- `TimelineLivePlayer` keeps one warm decoder per POV referenced anywhere on the
  timeline, unbounded. Bounded in bytes now, not in count.
- Audit backlog from the previous handoff is otherwise untouched.
- `_to_delete/` in the repo root holds four scratch CSS/HTML files used for the
  headless render; delete it.

---

# Part 2 — the Watch screen

## Two bugs from the log first

**`media:filmstrip` never produced a frame on some VODs.** The mjpeg encoder
refuses limited-range YUV outright (`Non full-range YUV is non-standard`), and
whether the decoder hands it full or limited range depends on how the platform
tagged the source — Kick's tagging lands on the refusing side. Adding
`format=yuvj420p` to the filter chain in `main/media/thumbnails.ts` makes the
encoder's answer the same whatever comes in. Reproduced the exact error on
ffmpeg 6.1 and confirmed the fix defeats it even with `-color_range tv` forced.

**`vod-unavailable` for an expired Kick VOD** is the error system working —
the recording really is gone. No change.

## What was wrong with Watch

- The timeline was a **flat grey bar**. On a six-hour broadcast it showed a
  ruler and nothing else: no sense of what is in the VOD, and no answer to the
  question this app exists for — *who else was rolling at this moment*.
- **Mark in / mark out / add clip existed in three places** (the transport, the
  clip panel's empty state, and the coaching strip), while the range they build
  was only visible as two small numbers inside two button labels.
- **Two POV switchers**: the strip above the stage and a second full list in the
  transport.
- The marked region was drawn but its **edges could not be grabbed**.

## What it is now

**Angle rows on the timeline.** One thin row per POV showing where that
recording sits on the focused angle's ruler, colour-coded, the watched angle
outlined, a live broadcast's trailing edge faded rather than walled off, and an
unaligned angle drawn as a hatched row that says so by name. Clicking a row
seeks there *and* switches to that angle. `povCoverage()` in
`shared/multiPov.ts` does the arithmetic; `timelineBands()` in
`shared/timelineView.ts` does the layout, shared by the painter and the
hit-tester so they cannot disagree about where a row is.

**A selection bar under the timeline** — the marked range stated once, directly
under the shaded region it describes: In and Out as editable timecodes,
duration, jump-to-edge, loop, Add clip, clear. When nothing is marked it is
where the flow is taught instead of a coaching strip.

**Draggable in/out handles** with solid grips, each held to the other so a drag
cannot invert the range.

**Duplicates removed.** The transport now names the angle being watched rather
than repeating the whole switcher; the clip panel's empty state is three steps
instead of a second pair of mark buttons.

**An empty clips lane teaches** rather than sitting grey: "Shift-drag here to
mark a range — or press I where it starts and O where it ends."

## Verified

736 unit tests (11 new for `povCoverage` and `timelineBands`), 84 integration,
typecheck clean, stable and experimental builds clean, and the new timeline
rendered headless against the real stylesheets at nine angles.


---

# Part 3 — full control over every POV in a clip

`ClipTimeline.tsx` is now the single control surface for a clip's angles, and
`PovMatrix.tsx` is deleted. Everything a clip's POVs carried in the data model
is finally reachable:

- **Per-clip alignment** (`povOffsets`). It has been in the model and the store
  the whole time and the only way to set it was the waveform dialog, so a POV
  half a second out could not simply be nudged. Now `‹ 0.00 ›` per row, 0.1s a
  step, 1s with Shift, click the value to clear. `nudgedPovOffset()` rounds to
  the millisecond (so ten backward nudges land on exactly 0, not 1e-16) and
  caps at ±120s — past that you are re-marking, not aligning.
- **Picture and sound source** per POV as toggles rather than radio columns,
  disabled where the POV cannot supply that stream.
- **Used** marker per POV (`usedPovIds`).
- **`Use best`** — `bestPovFor()` picks the best-covered, best-aligned angle for
  each role: full coverage beats partial whatever the confidence, then
  confidence, then the angle the clip was marked in.
- **`Reset alignment`** clears every correction on the clip.
- A plain-language line states what the export will actually be, and warns when
  the chosen picture or sound POV only partly covers the moment.

Each row still shows the coverage bar positioned by real-world timing on the
clip's own clock, and now also that POV's position in its own VOD, a colour
swatch matching the Watch timeline's angle rows, and a click target that jumps
to that angle at the same instant.

**One real bug found by rendering it:** the clip ruler was inset by the panel
padding alone while the lanes are inset by a 148px name column, so "01:00" sat
about a hundred pixels from where one minute actually fell on the bars beneath
it. The column widths are now CSS custom properties on `.clip-timeline`, shared
by the headings, the lanes, the playhead and the ruler.

10 new tests in `tests/unit/clipPovControl.test.ts`. Whole suite: 831 tests,
830 pass, 1 skipped (`hwEncoding`, needs libsvtav1).


---

# Part 4 — two things the screenshots showed

## The selection bar was falling off the bottom of the timeline

`.timeline-stack` scrolled as a whole (`overflow-y: auto`), which was fine
while the canvas was a fixed 104px. The canvas now grows a row per angle, so at
nine angles it is 242px in a strip capped at 20vh (`.main.all-povs`) — and the
first thing pushed below the fold was the **selection bar**, the one place that
states the range you are marking. The markers lane went with it.

Fixed in two parts:

- The strip no longer scrolls its chrome. `.timeline-stack` is
  `overflow: hidden`; the head and the selection bar are `flex: none`; only
  `.timeline-canvas-wrap` scrolls.
- The canvas never asks for more height than the strip has. `Timeline`
  measures the wrap (safe, not circular: the wrap is `flex: 1 1 0`, so its
  height comes from the strip and never from the canvas) and clamps.

## Angle rows now collapse instead of becoming hairlines

Clamping alone put nine rows in a 124px canvas — under 2px each, no labels,
two adjacent colours indistinguishable, and the clips lane starved. So
`timelineBands` takes a `minReadableLaneHeight` (7px): below it the band is
dropped entirely and the clips lane gets the height back. The timeline head
then says *"9 angles — drag the timeline taller to see who covered what"*,
because nine rows silently vanishing reads as a fault rather than a decision.
At 42vh — the normal, non-wall strip — the rows are back at their full 15px.

## Backlog was an empty page next to a library full of work

Every band on Backlog is scoped to the **open project**, which the file's own
TODO already admitted. With one project open and nothing cut in it, the page
was a title and one expiring row while the library held forty-five streamers,
several of them broadcasting.

Added a **Live now** band above Expiring — the only deadline on this page you
can still beat by acting, since a broadcast in progress is footage you can
clip before it becomes an expiring VOD. One row per *person* (the roster's
`personId` rule, so a restreamer on Kick and Twitch is one row), sorted by
viewers, showing the stream title and viewer count, click to load that channel
as an angle. A person already loaded into the event is shown greyed rather
than hidden — that is context, not a target. It reads the same cached snapshot
the roster does, so it draws instantly and refreshes every minute.

## Verified

834 tests, 833 pass, 1 skipped. Typecheck clean, both channel builds clean,
and the collapsed strip rendered headless to confirm the selection bar
survives at 20vh with nine angles.


---

# Part 5 — a name for new projects, and a regression I caused

## New projects are named

`New project` now opens a prompt prefilled with a suggestion instead of
creating "Untitled project" outright, and the discard-confirmation hands off to
the same prompt rather than skipping it.

The other path mattered more: **most projects are created implicitly** by
pasting a VOD link into an empty app (`ensureProject`), and that path also
said "Untitled project" — which is how a recent-projects list ends up with
three identical entries. It now names the project after the VOD going into it:
`projectNameFromSource()` gives `basedLore — 14 Aug 2026`, falling back through
creator, then title, then the date.

`shared/projectNames.ts` is deliberately not `toLocaleDateString`: this string
ends up in a project name and then in an export *folder* name, and one that
renders `31/08/2026` on one machine and `8/31/2026` on another is a name you
cannot search for. 7 tests.

## The Settings pages were broken, and it was mine

Removing the dead `table.matrix` rules in Part 3 cut the block that
`table.grid` was grouped with, leaving `table.grid,` dangling above the next
selector. The keyboard and setup tables inherited `.model-facts`'s
`display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`
and blew apart across the window — action names on the far left, key boxes on
the far right.

Recovered the original rule from `release/win-unpacked/resources/app.asar`
(no git in this repo, so the packaged build is the only history) and restored
it. Then linted the whole stylesheet for the same shape — dangling selector
lists, empty rule bodies, brace balance — and found nothing else.

**Lesson for the next session: a bulk deletion from `app.css` must be followed
by that lint.** It is three regexes and it would have caught this immediately:

```python
# a selector list whose continuation is separated by a blank line or comment
re.finditer(r'^([^\s@{}][^{}\n]*),\s*$\n(\s*\n|\s*/\*)', css, flags=re.M)
# and any rule with an empty body
re.finditer(r'([^{}]+)\{([^{}]*)\}', re.sub(r'/\*.*?\*/', '', css, flags=re.S))
```

Separately, `.settings-pane` now has a `max-width: 860px`. These controls were
built for the dialog, where something else decides the width; on the Settings
*page* the same markup was getting the whole 1500px window, which is what made
the full-width buttons into 1700px bars.

## Angle rows were losing their names

The label test was `h >= 10` on the *drawn* height, which is one pixel shorter
than the lane — so a 10px lane, exactly what nine angles works out at in a
normal strip, drew coloured bars with no names on them. Now `LABEL_MIN_H = 9`.

## Verified

841 tests, 840 pass, 1 skipped. Typecheck clean, both channel builds clean,
and the Settings keyboard table re-rendered headless to confirm it is a table
again.


---

# Part 6 — startup loads what the first screen needs

The app opens on the Backlog, and the Backlog was fetching the streamer
library's live snapshot itself on mount — so the Live now band appeared a beat
after arriving. The roster did the same, plus re-fetched the streamer list and
the groups that startup had *already* loaded, so its badges and group chips
rearranged themselves a second after you looked at them. Two pages, two private
copies of the same object, two pollers.

Startup's `Promise.all` now also reads `streamersLiveCached()` (a file read, not
a live check) and `listStreamerGroups()`, and both land in the store:
`liveNow` and `streamerGroups`. Backlog and the roster read from there and
write their refreshes back, so whichever is open keeps the shared value
current and both draw complete on their first paint. Each call keeps its own
`.catch` — a missing streamer library must not stop settings from loading.

Still fetched on demand, deliberately: a streamer's VOD shelf (per streamer,
and the crawler fills it in the background anyway) and the cache stats on the
Settings page.

`Invalid cache (current) size` in the log is Chromium's own HTTP disk cache
complaining about its index at startup; it rebuilds it and carries on. Not ours
and not actionable.


---

# Part 7 — what the log said

`cookieclipper.log`, 17–31 Aug, 6210 entries. Today's 186 errors were all one
thing, and it was not what I expected.

## A bot check was permanently undating whole back catalogues

186 `yt-dlp resolve failed` today, 131 distinct YouTube video ids, every one:

> Sign in to confirm you're not a bot.

That message matches resolver.ts's `/sign in/i` test, so it threw
`authRequired`. The crawler then did this:

```ts
const date = await this.streamers.vodDate(next.url, …).catch(() => null)
this.library.putDate(streamer.id, next.url, date)
```

`putDate(…, null)` records `''`, which means **asked, nothing to tell, never
ask again**. Right for a deleted recording. Catastrophic for a bot check:
one bad ten minutes marked 131 broadcasts permanently undateable, and nothing
would ever have gone back for them. That is why YouTube VODs sit on
"date pending" forever in the roster.

Three changes:

- `isPlatformRefusal()` in `shared/errors.ts` — is this about *us* or about
  *this recording*? Matches the code (`auth-required`) and the platform's own
  words (bot check, 429, rate limit, "try again later"), reading `detail` as
  well as `message` since that is where yt-dlp's text lands. 7 tests, built
  from the verbatim log line including its curly apostrophe.
- The crawler no longer records an answer it did not get. A refusal parks the
  **whole platform** for 30 minutes (`REFUSED_MS`) rather than walking down
  the list collecting another 130 refusals — which is also the behaviour that
  provokes the block.
- `VodLibrary.forgetUnanswered()`, wired to the explicit per-channel refresh:
  the way back for the 131 already on disk. Refreshing a channel now reopens
  everything the platform previously refused to date.

## The settings race was the same bug I fixed for projects

16 × `ENOENT ... rename 'settings.json.tmp' -> 'settings.json'`. `settings.ts`
still staged every save through one shared temp name — two saves in quick
succession, both write it, first rename wins, second finds nothing. Every one
of those is a setting that silently did not save. `deps.ts` had it too.

Both now use `atomicWriteJson`, which already fixes exactly this and carries
the comment explaining why. Worth noting for next time: when I fixed this in
`projects.ts` I fixed *that* call site rather than grepping for the pattern.
`grep -rn '\.tmp' src/main` would have found all three in one go.

## Also read, and deliberately not changed

- **24 × "Export failed"** — all `The job was cancelled before it finished`.
  User cancellations, not faults.
- **19 × "preview remux failed"** — `reference count 1 overflow`, then
  19 × "Copy failed; re-encoding the preview instead". The fallback works;
  the pair is the system behaving as designed, just noisy.
- **32 × "yt-dlp channel listing failed"** — mostly *"This channel does not
  have a streams tab"*, which is an answer, not a failure: a YouTube channel
  that has never gone live. It was marking those channels broken and having
  the crawl return every ten minutes. Now returns an empty listing.

## Verified

848 tests, 847 pass, 1 skipped. Typecheck clean, both channel builds clean.


---

# Part 8 — the suite is green, and what "run the tests" could and could not cover

## 848 passing, 75 suites, nothing skipped

First fully green run. `hwEncoding.test.ts` had never run *once* — not in this
session and, from the state it was in, not before it either. It hard-coded
`libsvtav1` to build its AV1 fixture, and the static ffmpeg builds used for
testing ship libaom but not SVT, so every run died in `beforeAll` with
"Unknown encoder" and the hardware-encoding assertions underneath were never
reached. It now picks whichever AV1 encoder the ffmpeg actually has
(SVT → libaom → rav1e) with per-encoder speed flags, since libaom at its
defaults would turn a 4-second fixture into a minute.

I called that an "expected failure" four times before fixing it. A suite that
has never once run is not a known-good exception; it is untested code with a
green-looking excuse in front of it.

## The playback spike: what I could run, and what I could not

Both sandboxes reach kick.com, twitch.tv and youtube.com, so the *correctness*
half ran for real — see `plans/NATIVE-PLAYER.md`. Neither sandbox has a GPU
(`vdpau` only, no `/dev/dri`, no `nvidia-smi`), so the *performance* half
cannot be run from here at all, by me, on any machine I can reach.

Left for the real machine, and they are the two that decide the architecture:

- **Settings → Diagnostics → Playback benchmark** with the POVs playing.
- `node scripts/native-player/server.mjs --project "<...>.cookieclip"` — the
  header line names the pipeline that actually verified.


---

# Part 9 — Twitch resolved without yt-dlp

Built and verified **against live Twitch on the target machine**, not against a
fixture: a real VOD from this roster (Skorbnut, 2h25m) resolved title, channel,
duration, publish date, thumbnail and six renditions including the 1080p60
source, with the top variant's playlist URL confirmed fetchable.

- `media/twitchDirect.ts` — the network half. GQL for metadata and
  `PlaybackAccessToken`, then usher for the master playlist. Same public web
  client id `streamerProfile.ts` already uses for profiles and video dates.
- `TwitchAdapter.fromApi` — the pure mapping, mirroring `KickAdapter.fromApi`
  so it is testable without importing Electron. 11 tests.
- `sources.ts` now takes the platform's own API first for **both** Kick and
  Twitch, with yt-dlp as the fallback. An `auth-required` result is not retried
  through yt-dlp: it will refuse a subscriber-only VOD too, and retrying turns
  an honest "this needs an account" into "something went wrong".

## Two things found on the way

**The quality picker said `chunked`.** Twitch puts no NAME on
`EXT-X-STREAM-INF` — only `VIDEO="chunked"` — so `parseMaster`'s
`NAME ?? VIDEO` fallback labelled the source rendition with its group id. The
readable name was on the matching `EXT-X-MEDIA` line the whole time.
`variantLabel()` joins them by group id. Live proof: `chunked` became
`1080p60`. This was visible in the app's quality panel before today.

**`firstCodec` had been copied into two adapters** and I was about to make it
three. It parses an HLS attribute, not a platform's, so it now lives once in
`hls.ts`.

## New sandbox capability

`scripts/electron-shim.mjs`, wired into `scripts/sandbox-loader.mjs`: main
process code that fetches via `net.fetch` (for Chromium's proxy and TLS
handling) could not be run outside Electron at all, which put every direct
resolver out of reach of a sandbox run. `net.fetch` is now plain `fetch` there
— the network calls stay real, only the transport differs. This is what made it
possible to develop the Twitch resolver against the live API instead of
guessing at fixtures.

## Verified

859 tests, all passing, 76 suites. Typecheck clean, both channel builds clean.

---

## Addendum — native player milestone 2 closed (31 Aug)

`scripts/native-player/` now plays multiple angles against one audio clock, and
`scripts/native-player/sync-check.mjs` is the harness that proves it. Full
numbers and the reasoning are in `plans/NATIVE-PLAYER.md`; the short version:

| case | spread | drift | catch-ups |
|---|---|---|---|
| 3 tiles 480×270, decode keeping up | 7–20ms | ≤30ms | 0 |
| 8 tiles 960×540, 2 cores, no GPU | ~700ms | ~1s bounded | 15–16 (cooldown rate) |

Three real bugs fixed: `-re` pacing for non-live sources; the shared instant was
anchored on a tile's video origin instead of the clock's own; and Chromium's
six-connections-per-origin limit silently starved the audio request at eight
angles, so the clock never started and nothing drew.

Group catch-up was tried and reverted — it makes both slip and spread worse
(14.2s slip in 20s, 2063ms spread). The comment in `index.html` says why so it
is not retried.

Repo unchanged by this work: **859 tests, 76 suites, typecheck clean.**

### Two measurements only Reece can run

1. `node scripts/native-player/sync-check.mjs` against the RTX machine with real
   POVs — the container has no GPU, so every pipeline above software decode
   failed `verifyPipeline()` here.
2. Settings → Diagnostics → Playback benchmark with POVs playing.

Milestone 3 (seeking / live edge) is next and is untouched.

---

## Addendum — native player milestone 3 closed (31 Aug)

Seeking is done and measured; the live edge deliberately is not. Full reasoning
in `plans/NATIVE-PLAYER.md`; the short version:

`?t=` on both pipes, seeking with **`-ss` before `-i`**. **No segment index was
needed** — the milestone was written expecting to reuse `rangeFetcher`'s window
logic, and the HLS demuxer already does that job. First frame after a seek:
**99ms at t=5s, 101ms at t=575s**. Flat, so it is a real demuxer seek and not a
re-download; `rangeFetcher` stays untouched.

Picture *and* sound are both checked by content, not by trusting the request —
the fixture is twenty blocks each with its own colour and its own tone, so both
halves are exact comparisons. The audio matters as much as the video here: it
is the clock every tile is drawn against.

One finding worth keeping. On an **exact** frame boundary the HLS path lands one
frame early, and it is not a bug: ffmpeg targets `t + the container's declared
start_time`, MPEG-TS declares 1.400s, and the first frame is actually at 1.421s.
That 21ms is under a frame, so the demuxer returns the frame that was on screen
at that instant. A plain MP4 has no such offset and lands exactly. The harness
asserts the property that actually matters — within one frame, never *past* the
instant asked for.

Client: `pts` is absolute media time anchored on the server's reported offset
rather than on what was requested; `seekTo()` tears the whole wall down and
reopens it under one abort controller, with a token so a newer seek supersedes
one still opening; scrub bar plus ←→/Home/End. Switching angle now reopens the
sound at the position already reached rather than at zero.

New: `scripts/native-player/seek-check.mjs` (24 checks, no browser) and
`make-fixture.mjs` which generates the tape it runs against.

`_to_delete/` is gone, as the previous handoff asked.

### The client half is measured too

I first wrote that this needed the Windows machine because the sandbox could
not install playwright. That was wrong — it is already installed in the cloud
container at `/home/claude/.npm-global/lib/node_modules/playwright/index.js`,
and `COWORK-HANDOFF.md` §5 says so. Worth remembering: this container has more
in it than npm makes it look, and the registry being blocked is not the same as
a tool being absent.

`seek-sync-check.mjs`, three tiles, software decode: seek to 300s, **first
frame back in 130ms**, spread 17ms settling to 7–8ms against a 5–9ms baseline,
drift under a frame, zero underruns, and the clock restarted rather than
carrying on. It caught one real defect — aborting the audio fetch on every seek
left an unhandled rejection per seek. `startAudio()` now expects it.

### Still open

- Windows `npm test` / `npm run build` — still never run there, across every
  session so far.
- DVR seeking on a live source is not implemented, deliberately — no live
  source here to measure it against.
- Milestone 4 (native downloading) is next, and its own note says to measure
  before rewriting: it is network-bound, so it is the least likely part to
  benefit.

---

## Addendum — milestone 5, and the first Windows run (31 Aug)

### The native player is in the app

`Settings → Playback → Decoder`, defaulting to **browser**. Turning it on makes
the **POV wall** decode natively; the focused player stays `HlsPlayer`, which
is a decision rather than an unfinished edge — the reasoning is in
`plans/NATIVE-PLAYER.md` under milestone 5. New:
`main/media/framePipeline.ts`, `main/media/frameServer.ts`,
`shared/frameTiming.ts`, `player/native/{nv12Tile,audioClock,framePump,tilePorts}.ts`,
`player/NativeFollower.tsx`.

### Windows finally ran, and it earned its keep

`npm test` and `npm run build` had never been run on Windows across seven
sessions. Now green: **869 passed, 5 skipped, 77 files, typecheck and build
clean**, native player included in both bundles. Three faults it found:

**1. My liveExport fixture assumed eight segments.** ffmpeg emitted seven on
Windows — the encoders round the final block differently. It now reads whatever
was actually produced. The fixture also spawned ten ffmpeg processes and took
**186 seconds** under a parallel run, blowing the 180s hook timeout; rebuilt
with the `concat` filter in a single process it takes **1.9s**. Process
creation is cheap on Linux and is not cheap everywhere.

**2. The AV1 test was wrong, not the code.** It expected
`av1_nvenc|libx265|libx264` and got `hevc_nvenc`. With no AV1 encoder on the
card the policy fell back to HEVC and picked the *hardware* one — the best
available outcome, fully within the rule. The test was written on a machine
with no NVENC and quietly assumed the HEVC fallback would always be software.

**3. A real bug in `atomicWriteJson`.** `EPERM` renaming the staging file over
the target. Renaming over an existing file is atomic on POSIX and is not on
Windows, where anything holding the target for an instant — the indexer, a
scanner, or two of the app's own concurrent writes — fails it. **Everything
durable goes through that function**: projects, settings, the streamer library,
the VOD library. A save that silently did not happen is invisible until someone
notices their work is gone. It now retries on the transient codes (10/20/40/80ms,
giving up inside 150ms), fails loudly rather than pretending, and cleans up its
staging file either way. The rules are in `shared/atomicWrite.ts` and unit
tested, because making a real filesystem fail on demand is not portable but the
decision is what can be wrong.

### `_verify.bat`

Double-click it; it runs typecheck, tests and build and writes `_verify.log`,
which a session can read over the folder bridge. Worth knowing: the first
version captured `%errorlevel%` inside a parenthesised block, where it expands
at *parse* time — it reported `TEST_EXIT=0` directly above a failure. Each code
is now captured immediately after its command, outside any block.

### Still open

- **The wall running natively on real POVs is unmeasured.** It builds, it is
  wired, and the frame server is tested against a fixture — but nobody has
  turned the setting on with a real event loaded. That is the next thing to do,
  and it needs a packaged build (`npm run package:win`) or `npm run dev`.
- Milestone 4 (native downloading) untouched; its own note says measure first.
- DVR seeking on a live source, still deliberately not done.
