# Session 2026-09-01 — the paused wall, and the startup ratchet

Reece: "Ensure everything is loading fast and able to play instantly without
having to pause un pause etc", with two screenshots of a black tile reading
`0/30fps +0ms` and the clock stopped at `00:00:01.809` — i.e. paused.

Two bugs, both about a tile that is not currently streaming.

## 1. A paused tile never drew anything

`NativeFollower.ensureOpen()` returned immediately when `!playing`, so a tile
mounted while the wall was paused **never opened a pipe and never drew a single
frame**. The comment claimed the canvas "holds its last frame" — true only if it
ever had one. Opening a project and looking at it before pressing play showed
black, which is exactly the pause/unpause dance.

Fix: a paused tile asks the frame server for **one frame** at the playhead.

- `frameServer.ts`: `?one=1` → `-frames:v 1`, and no `-re` (one frame needs no
  pacing; waiting a frame interval to hand it over is a frame interval of black).
- `NativeFollower.tsx`: `ensurePoster()` beside `ensureOpen()`, with a 0.25s
  position tolerance and a 250ms cooldown so dragging the scrubber is one
  decoder, not a hundred.
- `FramePump.drawPending()`: draws whatever is held regardless of when it
  belongs. `presentAtMedia` alone is not enough — it is only called when the
  angle has a target, and an angle outside the recording has none.
  Test: `tests/unit/framePump.dom.test.ts`.

## 2. Startup ratcheted the whole wall down to the bottom rung

`adjustWallQuality` steps the wall's cap down the moment **any** tile misses its
frame rate, and `capHeight` is in `NativeFollower`'s effect deps — so a step-down
reopens every decoder on the wall. A decoder that opened half a second ago has by
definition not delivered a second of frames. So: everyone opens → everyone's
first sample is short → step down → everyone reopens → repeat. 1080 → 270 with
four full restarts before anything settled.

Fix: a tile reports `null` health (no vote) while paused, and for `SETTLE_MS`
(2.5s) after any open. `adjustWallQuality` already holds when no tile reports.

This one also had to land with the poster, or a paused wall — one frame per tile,
0fps — would have ratcheted itself to 270p while sitting still.

## Verification

- 991 tests / 88 files green; both tsconfigs clean; `electron-vite build` green.
- `scripts/diagnose.mts` gained a poster check: requests `one=1` at 60s and
  reports time-to-first-frame and that exactly one frame arrives.

## Still only Reece can run

`_verify.bat`, `_diagnose.bat`, and the app itself. **None of this session's
runtime changes have executed once.** The poster path in particular wants a real
run: watch that a freshly opened project shows pictures before you press play,
and that `_diagnose.log` says `(correct: one frame and stop)`.

Carried over: the Twitch angle (curvyelephant) needs re-adding — its master
cannot be derived from the stored URL. Deferred with reasons in
`PRODUCTION-AUDIT-2026-08-31.md` §3b: `sandbox: true`, the `disable-features`
switch, code-splitting the 2.2 MB renderer chunk.

---

# Later the same day — "not fully loading vods, and not letting me skip"

Two more, both mine, both from the last two sessions' changes.

## 3. Every VOD reported "Preview unavailable"

`usePlayerViewport.tsx` built its own media-proxy URL:

```ts
`${base}/media/${kind}?u=${encodeURIComponent(source.playbackUrl)}`
```

The proxy now requires a per-run secret and answers **403 before fetching
anything**, so every manifest request from the main viewport was refused, hls.js
reported a fatal network error, and the player said the recording was not in a
form it could show. Loading, metadata and alignment were all fine — only
playback was dead, which is why it looked like the VOD had half-loaded.

This is the *fourth* hand-written copy of that URL and the second time one has
broken playback. `shared/mediaProxyUrl.ts` exists because of the first; making
the token a required argument was supposed to make the compiler find the rest,
and it found three. It cannot find a template string.

- Fix: the viewport calls `playbackSrc()` like every other caller.
- Guard: `tests/unit/mediaProxyCallers.test.ts` scans `src/` and fails if any
  file outside `shared/mediaProxyUrl.ts` spells `/media/manifest` or
  `/media/segment`. Verified it fails on the exact bug.

## 4. Half the timeline strip was dead, and the rest drawn at 60%

`draw()` sized the bitmap from the **wrap** (`wrap.clientHeight`) while the
canvas element was `canvasHeight` tall — and `canvasHeight` was deliberately
capped at what the rows needed (140px for two angles) inside a 228–275px strip.

So the timeline drew a 228px-tall picture into a 140px element — the whole
strip at ~60% scale, which is the squashed ruler in Reece's screenshot — and
`size.current.height` (228) is what every pointer handler hit-tests against,
while a pointer `y` can only reach 140. `hitTest` looked for the clips lane at a
y no click could produce, so **shift-drag to mark a range did nothing at all**,
and the bottom third of the visible strip was not the canvas, so clicking it
reached no element.

- Fix: the canvas fills the strip (`canvasHeight = availableHeight`), and
  `draw()` measures the canvas rather than the wrap, so the box drawn in, the
  box hit-tested in and the box on screen are one box. `timelineBands` already
  shares out whatever height it is given.
- Verified in headless Chromium against the real `app.css` at 100% and 250%
  display scaling: before, drawn 228 / element 140 and a click 90% down the
  strip landed on `.timeline-canvas-wrap`; after, 228/228/228 and the click
  lands on the canvas.
- Guard: `tests/unit/stylesheet.test.ts` now fails if `draw()` measures the
  wrap. Verified it fails on the exact bug.

993 tests / 89 files green, both tsconfigs clean, build green.

---

# 5. The green tile: two ends disagreeing about the frame shape

"Still isn't working with more than 1 POV" — a wall of two angles showed one
picture and one **green rectangle**, drawn into the bottom-left of its tile and
about three quarters of its size, while the tile's own overlay read
`64/60fps +0ms −25`. Frames were arriving. None of them were reaching the
canvas. A wall of *nine* angles was fine, which is what made it look like a
"more than one POV" problem when it is the opposite.

Two defects in `Nv12Tile`, both from it assuming it owns a canvas at a size
that never changes.

## The green

The renderer sizes a tile from how big it is drawn: `tileSizeFor(h, n)` — with
the frame rate left at its default 30, because the renderer cannot know the
source's rate. The frame server then settles the size *again*, this time
knowing the real rate, and a 60fps tile costs twice a 30fps one on the wire, so
it comes back a rung lower than was asked for. It says so in `x-frame-width` /
`x-frame-height`.

`FramePump` read only `x-frame-bytes`. So it sliced the stream correctly and
handed every frame to a tile whose textures were still the size of the
*request*: `texSubImage2D` rejected each one, the planes kept the zeroes
`texStorage2D` created them with, and — measured in a real WebGL context —
NV12 zeroes render as `rgb(0, 77, 0)`. Pure green.

Nine angles worked because at nine the budget lands on the same rung whether
you assume 30fps or 60, so the two numbers happened to agree.

## The bottom-left corner

WebGL sets the viewport once, when the context is created. Assigning
`canvas.width` afterwards resizes the drawing buffer and **leaves the viewport
where it was**, and `Nv12Tile`'s constructor did exactly that on a canvas that
already had a context — so a tile rebuilt at a larger size drew into the old,
smaller rectangle anchored at the bottom-left and left the rest black.
Reproduced headlessly: viewport stuck at `0,0,64,36` in a 128×72 buffer, the
picture in the bottom-left quarter, the rest untouched. That is the shape and
position of the green box in Reece's screenshot.

## The fix

- `Nv12Tile.resize(w, h)` reallocates both planes, the drawing buffer **and the
  viewport**; the constructor goes through it, so the viewport is never
  implicit.
- `Nv12Tile.draw` returns `false` for a frame that is not its size instead of
  attempting the upload — a refused frame is now black and counted, never a
  green rectangle.
- `FramePump.read` adopts `x-frame-width`/`x-frame-height` and resizes the tile.
  The server's answer is now the only opinion about the frame shape.
- The tile overlay shows `✕n` for refused frames, and the "not keeping up" log
  line carries `servedAt` beside `decodedAt`. This was invisible before: the
  only symptom was a colour.

## Verified

- `tests/unit/framePump.dom.test.ts`: the pump resizes the tile to the served
  size and the frame reaches the canvas; a refused frame is counted, not drawn.
- Headless Chromium against the real compiled `Nv12Tile`: after `resize` the
  viewport is `0,0,128,72` and all four corners of the canvas are painted; a
  wrong-sized frame returns `false`; no GL error.
- Headless Chromium against the real `app.css`: the wall's own layout is
  correct — two tiles 759×596, the canvas fills its tile, `object-fit: contain`
  centred. The lopsided black band was the viewport, not the stylesheet.

993+ tests green, both tsconfigs clean, build green.

## Not addressed

Nine angles at once runs at 21–29 of 30fps with up to −393ms drift. That is the
wall at its capacity ceiling, not a defect, and it is a separate piece of work
from this bug.

---

# 6. Nine angles: the wall was restarting its own decoders

Reece's Task Manager settled this in one picture: **32% CPU, 10% GPU, 5%
network, and every `ffmpeg.exe` at 0% CPU with a 5–10 MB working set** — while
the wall's tiles read `11/30fps −730ms`, `13/30fps −663ms`, `2/30fps`. The
machine was not the limit. The decoders were not working. They were starting.

## The mechanism

The rung a tile decodes at is the *smallest* of three things: how big the tile
is drawn, the wall's quality ceiling, and what the shared bandwidth budget
affords. On a wide wall the **budget** binds — nine angles share 120 MB/s, so
360p is the ceiling whatever else says.

`NativeFollower` took `capHeight` as a dependency of the decoder effect. So
when the wall lowered its ceiling — which it does the moment any tile misses
its frame rate — every tile tore down its pipe and respawned its ffmpeg. From
1080 the ladder walks 720 → 540 → 360 before reaching the one rung that
actually changes anything, and **not one of those steps changed a decoded
pixel**. Three restarts of nine decoders to achieve nothing, each costing a
second or two of no frames, repeating for as long as the wall was unhealthy —
which it always was, because it kept restarting.

Session 5's `SETTLE_MS` made it worse: it stretched each futile cycle to ~3.5s.

It was invisible because the tile's `↻` counter only counts the reopens a tile
*chooses* (drift correction). The reopens the wall imposed went through the
effect's cleanup and touched no counter at all. Every tile honestly reported
`↻0` while being killed every few seconds.

## The fix

- The drawn height is measured outside the effect (`useLayoutEffect` +
  `ResizeObserver`), the rung is computed in render, and **the effect depends
  on the rung, not on the ceiling**. A ceiling change that does not change the
  rung is now free. Test: `tests/unit/tileRendition.test.ts` asserts that at
  nine angles, ceilings of 1080/720/540/360 all produce the identical size.
- Nothing opens until the tile has been measured, so there is no open-then-
  reopen on mount.
- `SAMPLES_BEFORE_STEPPING_UP` 10 → 30. Stepping up is the one direction that
  still costs a restart when it changes the rung; ten seconds of evidence made
  a wall sitting just under its ceiling oscillate permanently.
- The tile now shows `⟲n` for restarts the wall caused, beside `↻n` for the
  ones it chose, and both go into the log. This is the number that would have
  named the bug from the first screenshot.

## And the ninth angle was refused by a setting

`DEFAULT_ANGLE_CEILING` was 8 — "about what fits on one screen" — so a ninth
angle got a tile reading *"Over your angle ceiling"* rather than a picture.
That is a judgement about looking, enforced as a machine limit. The machine's
real limit is already handled twice over by things that *degrade*: the shared
budget picks a smaller rung as angles are added, and the wall lowers its own
quality when tiles cannot keep up. A ceiling that only refuses is a bad place
to be cautious. Now 16.

501 + 496 tests green, both tsconfigs clean, build green.

---

# 7. The log answered it: the wall was standing in its own way

"It works fine with the browser as the video player" plus the app's own log
settled what four screenshots could not. From `cookie-clipper.log`, one wall of
nine angles:

```
20 × "Decoding an angle"
20 × "Decode pipeline verified"
18 × "A decode produced no frames"
```

## Twenty verifications for one wall

`ensurePipeline` decides *how* this machine can decode a stream by actually
decoding a piece of it with each candidate pipeline until one works. The
**answer** was cached; the **work** was not. A wall opens every angle in the
same instant, so all nine found `this.pipeline` still null and all nine started
their own verification — nine times three or four candidate decodes, spawned in
front of the nine decoders that were supposed to be producing the picture.

That is why the browser player was fine on the same nine angles: it does none
of this. It is also why Task Manager showed a machine at 32% CPU with every
ffmpeg at 0% — they were not decoding, they were queued behind each other
opening the same streams, and being killed before they emitted a frame.

Fix: share the *promise*, not just the result. A failure still clears, so a
later angle on a different stream can try again.
Test: `tests/unit/framePipelineOnce.test.ts` — nine concurrent callers, one
verification. Confirmed to read capabilities 18 times before the fix, 2 after.

## Two decoders per tile, every time

The log shows every angle choosing a rendition twice within milliseconds — once
at 360p, once at 270p. The wall decides its column count from a measurement of
the stage, so a tile is one size on the first paint and another a frame later,
and those can be different rungs. The first decoder was replaced before it
produced anything. Eighteen decoders for nine tiles.

Fix: a 200ms settle on the tile's own measurement. The tile shows its paused
frame meanwhile.

## The reader was copying every byte three times

`FramePump.read` grew a buffer by concatenation — allocate `held + chunk`, copy
the held bytes, copy the chunk, then `slice` the frame out of it. Three copies
and two allocations per chunk, on the renderer's main thread, for every angle
at once: eight 360p tiles is 83 MB/s of frames, so roughly a quarter of a
gigabyte a second of memcpy and ~1300 quarter-megabyte allocations a second,
competing with React and the canvas uploads for one thread.

It matters because the pipe has back-pressure by design — ffmpeg blocks on a
full stdout rather than running ahead — so a slow reader is indistinguishable
from a slow decoder from the outside.

Fix: chunks are copied straight into the frame being filled (one copy per
byte), and finished frames — drawn, dropped or cleared — hand their buffers
back to be filled again, so steady-state allocation is about zero. Five tests
cover the boundary cases: a chunk holding several frames, a frame split across
chunks, a trailing part-frame, per-frame timestamps, and recycling.

## And the warning now says why

"A decode produced no frames" named a problem and withheld every fact needed to
diagnose it — ffmpeg's own output goes to debug, which nobody runs. It now
carries how long the decoder lived, how it ended, and ffmpeg's last line.
"It could not decode that" and "it was killed while still opening the stream"
want opposite fixes, and this app spent a day on the wrong one.

1004 tests green, both tsconfigs clean, build green.

---

# 8. The wall was killing its own decoders every 1.5 seconds

The warning from §7 paid for itself the moment Reece ran the next build:

```
"A decode produced no frames"  liveMs: 478  exit: "SIGKILL"  error: "ffmpeg said nothing"
```

Not a decoder that failed. A decoder that was **killed half a second after it
spawned**, for every angle, over and over. Across one wall in the log the
`liveMs` values cluster at **1600–1800ms** — with the short ones being children
killed while still opening, by the next open arriving on top of them.

## The rule that did it

```ts
const ensureOpen = (): void => {
  if (!playingRef.current) return
  const target = live ? 0 : (targetRef.current ?? 0)
  if (openAt !== null && Math.abs(openAt - target) < RESEEK_TOLERANCE) return
  openAt = target
  void open(target)
}
```

`openAt` is the media time the pipe was *started* at. `target` is the playhead,
which advances in real time. **A playing pipe is supposed to leave its start
position behind** — so after `RESEEK_TOLERANCE` (1.5s) of ordinary playback that
comparison is always true, and every tile tore down its decoder and spawned
another. Every 1.5 seconds. For as long as the wall played.

Resolving a rendition and opening an HLS stream takes about a second of that, so
each ffmpeg was killed roughly half a second after it started, before it had
produced a frame. Nine tiles doing that is nine decoders in permanent startup,
which is precisely what Task Manager showed: 32% CPU, 10% GPU, every `ffmpeg.exe`
idle at 0%. And it is why the browser player, which has no such rule, played the
same nine angles perfectly all day.

It was invisible because this reopen incremented neither counter: `↻` counts
drift reseeks and `⟲` counts wall-caused restarts. Every tile reported a healthy
zero while destroying itself twice a second.

## The fix

`ensureOpen` opens when there is no pipe, and otherwise leaves it alone.
Divergence is still handled — by the drift check in the frame loop, which
compares where the tile *is* against where it should be, rather than where it
began. That is the only correct way to ask the question, and it was already
there.

Two supporting changes:
- A pipe that ends on its own clears `openAt`, so the next frame opens a new
  one. The old divergence check was accidentally providing that recovery.
- Every reopen is now counted, whatever caused it.

## What this session actually was

Eight bugs, and the last five all wore the same disguise: **the machine looked
busy doing nothing**. A green tile, a wall at a third of its frame rate, idle
decoders, an idle GPU. Every one of them was the app getting in its own way —
verifying its pipeline nine times over, restarting decoders for a size that had
not changed, copying every byte three times, and finally killing every decoder
it started.

The log had the answer in thirty seconds once it was asked, and once the one
warning that mattered was made to say `liveMs` and `exit` instead of just
announcing that something was wrong.

---

# 9. Nine angles play. Two things left, both fixed.

The wall now holds 29–32 of 30fps on all nine. What the screenshot still showed:

## Every follower sat 0.5–1.2 seconds behind the leader

`-re` holds ffmpeg to exactly 1× real time. That reads as the safe choice and is
quietly fatal for a follower: opening an HLS stream and seeking into it takes
about a second, so the pipe **begins** a second behind the playhead and, moving
at exactly the speed the playhead moves, can never close the gap. It is a
permanent offset by construction, and on a tool for cutting one moment from nine
cameras it is the whole problem rather than a blemish.

Fix: pace from the reader instead. `FramePump.waitUntilWanted` stops reading
once the newest frame held is half a second past the playhead; the socket stops
draining and ffmpeg blocks on a full stdout. Behind the playhead it runs flat
out and catches up; ahead of it, it does nothing. `-re` could only ever do the
second half — and this is also strictly less work, because nothing is decoded
that the picture will not use. A live source keeps `-re`: its edge is being made
in real time and there is nothing to read ahead of.

Three tests: it stops when far enough ahead, it reads on again as the playhead
moves, and a live angle with no target never stalls waiting for one.

## Every picture was pillarboxed inside its cell — ATTEMPTED AND REVERTED

Nine 16:9 pictures in a stage that is not `columns×16 : rows×9` leaves a
remainder, and it was going *inside every cell* as a black margin — nine
separately letterboxed tiles whose gaps did not line up. The grid now carries
the tiles' own aspect ratio, so the remainder collects once at the edge of the
wall, where it reads as framing.

`aspect-ratio` only shapes a box that is free on one axis, and a stretched flex
child is free on neither — which is why setting it alone did nothing. The
component already measures the stage, so it says which axis binds
(`height: 100%` on a stage wider than the wall, `width: 100%` otherwise).

Verified in headless Chromium against the real `app.css` at 2, 4, 6, 9 and 16
angles on two stage shapes: cells exactly 16:9 to three decimals, every cell
identical, the grid inside the stage, centred, nothing clipped.

## And a wall-scale benchmark

`scripts/diagnose.mts` now opens 2, 4, 8 and 16 angles *at once* through the real
frame server, at whatever rung and rate the budget picks for that many — so a
60fps source is measured at 60 where it fits — and reports how many held their
rate, the slowest and fastest, and the total MB/s. Every measurement before this
was one tile at a time, which is the number this app is never asked for.

1007 tests green, both tsconfigs clean, build green.

## A mistake worth recording

A bad edit script truncated `src/main/media/frameServer.ts` to zero bytes
mid-turn. It was restored from the verified working copy at `~/verify` and
checked feature by feature. There is no git here — that working copy is the only
safety net, which is an argument for `git init`.

---

# 10. I broke the wall, and why

The even-tiles change in §9 was a regression. Reece: *"Flickering a lot and not
working"* — nine cells far larger than the window, the page scrolling, eight of
nine tiles black.

## The loop

The wall's tiles are canvases whose **bitmap is chosen from how big the tile was
measured to be**. So the moment the grid takes its size from its contents, that
is a feedback loop: measure → decode bigger → cell grows → measure again. Every
turn of it restarts a decoder, which is the flickering, and the size runs away,
which is the overflowing window.

Giving the grid an `aspect-ratio` meant dropping `flex: 1` for `flex: 0 1 auto`
so the ratio had a free axis to work with. `flex: 1` with both minimums at zero
was the only thing holding that loop shut.

## Why the check did not catch it

I verified in headless Chromium against the real stylesheet — and modelled the
stage as `width: 1523px; height: 671px`. A **definite** height. The real
ancestor is a flex child whose height is not definite, so `height: 100%` fell
back to `auto` and the grid sized to its content. The harness could not fail.

The harness now models the ancestor as `flex: 1; min-height: 0` inside a column,
which reproduces it: the reverted rule passes all five layouts, the aspect-ratio
version fails three.

Same mistake as the phantom in the earlier audit, in a different coat: I checked
the thing I had changed rather than the thing it lives inside.

## Now

Reverted to the known-good rule, with a comment saying what was tried and what
it cost. `tests/unit/stylesheet.test.ts` asserts `.pov-grid-equal` keeps
`flex: 1` and both minimums at zero. Verified in Chromium against the real
stylesheet, with an indefinite-height ancestor, at 2/4/6/9/16 angles on two
stage shapes: the grid fills the stage exactly, cells equal, nothing clipped,
and it does not grow with its content.

Pictures are pillarboxed inside wider cells again. That is cosmetic and it is
where it was. If it is worth another attempt, **the grid's size must come from
the stage's measured pixels in JS — never from the grid's own box** — and the
stylesheet test above should still pass.

The read-ahead pacing from §9 is unchanged and stands: 1008 tests green, both
tsconfigs clean, build green.

---

# 11. The app's own player is gone

Reece: *"remove the apps own player we are going to use the browser one it runs
better"*. Done — 40 files, **6,429 lines deleted, 30 added**.

## What went

- `NativeFollower`, and `player/native/` (`nv12Tile`, `framePump`, `registry`,
  `tilePorts`, `audioClock`)
- `main/media/frameServer.ts` and `framePipeline.ts`
- `shared/frameTiming.ts`, `wallQuality.ts`, `tilePorts.ts`, `tileRendition.ts`
- `PlaybackBenchmark`, the Decoder setting, `playbackEngine`, `nativePlayback`,
  the `native:start` / `native:sources` IPC channels and their preload bridges
- `scripts/native-player/` (the prototype) and seven test files
- The frame-server sections of `scripts/diagnose.mts`

The wall is one path now: `PovGrid` renders `FollowerVideo` for every follower,
with no engine choice and no per-tile fallback. `capabilitiesFrom` was the one
thing worth keeping from the deleted pipeline — it is two string checks, now
inline in the diagnostic, because ffmpeg still does the exporting even though it
no longer does the playing.

## Verified

934 tests green (was 1008 — the difference is the native suites, which went with
the code they tested), both tsconfigs clean, `electron-vite build` green, and
`scripts/diagnose.mts` runs end to end. The renderer bundle dropped ~36 KB.

## Two mechanical notes

**No deletes on this mount.** The removed files were *moved* to
`_to_delete/native-player/` rather than unlinked — this session cannot delete on
Reece's machine without an approval that did not come through. That folder is
safe to delete by hand, and is also the only copy of the native player left.

**`git init` does not work on this mount either** — git cannot unlink its own
`index.lock`. The deletion was therefore done in the verified working copy at
`~/verify` (which does have git, with a commit before and after), and the result
copied back file by file. A checksum comparison of the two trees afterwards
reports **zero content differences**. If this repo is ever moved onto a normal
filesystem, `git init` should be the first thing done to it.

## Still worth knowing

Reece's settings file may still hold `playbackEngine: 'native'` — harmless, it is
simply no longer read. It also still holds `maxLivePovs: 8`, which is what refuses
a ninth angle; the default is 16 now but a stored value wins. Settings → Angles
at once.

---

# 12. Clip drag lag, and live-as-VOD

## Dragging a clip edge did the whole project's work, per mouse move

`patchClip` runs on every pointer event of a drag, and it was doing two things
that only need doing once:

- **`refreshClipMappings`** rebuilt the POV mappings for *every clip in the
  project*. Fifty clips across nine POVs is four hundred and fifty projections,
  a hundred times a second. Moving one clip cannot change another clip's
  mapping — a mapping is a function of that clip's own times and of the
  sources, and neither changes for its neighbours. New `refreshClipMapping`
  (singular) touches only the clip that moved and returns the *same objects*
  for the rest, so React skips them too.
- **`pushHistory`** pushed a full copy of every clip and marker on every move.
  A single resize left a hundred entries and undo stepped back one pixel at a
  time. The timeline now pushes once when the drag starts and passes
  `history: false` for the rest, so undo lands where the drag began — which is
  what it looked like it did anyway.

Test: `tests/unit/clipDragCost.test.ts` — the single-clip refresh produces
exactly what a full refresh produces for the moved clip, leaves every other clip
as the identical object, and does nothing at all for an unknown id.

## Live channels now open the recording the platform is already making

Reece: *"we can't watch live streams… we need live vods that are loaded from the
vod so we can clip and download from live."*

The app had this backwards. A live source was fed by a **rolling in-memory
buffer** of the last few minutes (`liveBuffer.ts`, `services/live.ts`,
`shared/live.ts`), and the platform's VOD was only picked up *after* the
broadcast ended. So you could not scrub back to something near the start of a
stream, let alone cut it.

Verified live against Kick rather than assumed:

```
GET /api/v2/channels/<slug>/videos   → newest entry while live:
  is_live: true
  video.uuid: 78c50f86-…
  source: https://stream.kick.com/…/media/hls/master.m3u8
```

That master is public, carries 1080p60 and 720p60, and its media playlists are
`#EXT-X-PLAYLIST-TYPE:EVENT` starting at `MEDIA-SEQUENCE:0` with **1,615
segments** — the whole broadcast so far, seekable from the start.

So a live channel is now just a VOD. `resolveKickDirect` gained one branch: a
`kind: 'channel'` match resolves the in-progress (or newest) recording's uuid
and everything downstream is unchanged — including the duration-from-playlist
fallback, which a live VOD needs anyway because Kick reports `duration: 0` until
the stream ends. Clipping, exporting and the POV wall all work on it with no
special case.

`SourceService` no longer refuses a channel link just because `is_live` is
false: what decides is whether a recording was found (formats), not whether the
person is on air this second.

Test: `tests/unit/kickLiveVod.test.ts` covers the selection — prefers the live
broadcast, falls back to the newest, skips entries with no recording, and
returns null rather than guessing.

941 tests green, both tsconfigs clean, build green.

## Next for live

- **Twitch**: the same idea needs its archive lookup (GQL `videos` with
  `type: ARCHIVE`, newest while live). Not done.
- The rolling buffer (`liveBuffer.ts`, `services/live.ts`, `shared/live.ts`) is
  now unused by the Kick path and is a deletion candidate once Twitch follows —
  worth checking nothing else leans on it first.

---

# 13. Three from the console

## `watermark:add-png` had no handler

The channel was declared in `ipc.ts`, bridged in `preload`, called by
`ensureNameBadge`, and `WatermarkLibrary.addPng` was fully implemented — the
`handle()` registration in main was simply never written. So every automatic
name badge threw "No handler registered for 'watermark:add-png'". One line.

## "That range is empty, so there is nothing to preview"

`buildPreview` clamped its range with `Math.min(src.durationSeconds, …)`. A
duration of **zero means "not known yet"**, not "nothing here" — and clamping to
it collapsed every range to nothing. A live broadcast opened as its in-progress
recording is exactly that case: the platform reports `duration: 0` until the
stream ends. An unknown duration is now `Infinity` for clamping, and a range
that still comes out empty returns instead of asking the main process for it.

## `twitch.tv/<login>/videos?filter=archives` was "not a VOD address"

That is the page a person is actually looking at when they go to find someone's
recordings, and the matcher only accepted a bare `twitch.tv/<login>`. The
listing tab is not part of the identity — `/videos`, `/clips`, `/about`,
`/schedule` and `/home` all mean the same channel now. Twitch's own pages
(`/directory/...`, `/settings/...`) and deeper paths are still refused.

## And Twitch live-as-VOD, which that URL needs to be useful

The same idea as §12's Kick work, and the existing `gql()` helper made it small.
Verified against a channel that was live at the time:

```
{ user(login: "thedlinquent") { stream { id }
    videos(first: 1, type: ARCHIVE, sort: TIME) { edges { node { id lengthSeconds } } } } }

→ stream.id 317622471778   (live)
→ video 2863286849, lengthSeconds 1853 and counting
```

Twitch creates the archive when the broadcast starts and grows it as the stream
runs, so `channelArchiveId` takes the newest ARCHIVE and everything downstream
treats it as an ordinary VOD. Offline channels open their newest recording,
which beats an error.

Both platforms now open a live channel as the recording it is already making.
The rolling buffer (`liveBuffer.ts`, `services/live.ts`, `shared/live.ts`) is
now unused by either resolve path and is a deletion candidate — worth checking
what still imports it first.

Tests: `tests/unit/channelLinks.test.ts` (7 cases, including the two kinds of
link that must still be refused). 948 tests green, both tsconfigs clean, build
green.

---

# 14. Every tile is now exactly 16:9

Reece: *"All the views aren't seen correctly, some are cut off… we want them to
auto resize so all can be seen perfectly."*

Nothing was cropped. Measured against the real stylesheet in Chromium: a 16:9
picture in an 837×335 cell paints **596×335, centred** — `object-fit: contain`
working exactly as written. What that costs is a fifth of the wall spent on a
black border around every single picture, none of them lining up. That is what
reads as "not seen correctly".

## The fix, and why it is safe now

The grid carries the tiles' own aspect (`columns × 16 : rows × 9`), so every
cell is exactly 16:9 and each picture fills its cell completely. The remainder
collects once, at the edge of the wall.

This was attempted in §9 and reverted in §10 because it required dropping
`flex: 1`, which let the grid be sized by its contents — and its contents were
canvases whose bitmap came from their own measured size. Measure → decode
bigger → cell grows → measure again: the wall oscillated and overflowed the
window.

Two things make it safe now:

1. **The native player is gone.** Tiles are `<video>`; nothing sizes a decoder
   from a measurement any more, so that loop has no path to close.
2. **The measured element is no longer the sized element.** A new `.pov-wall`
   wrapper is what `gridRef` observes — stretched by the stage, `flex: 1` with
   both minimums at zero, and unmovable by anything inside it. The grid is
   sized *from* that measurement, so measuring the grid itself would have
   closed the loop a second way.

`tests/unit/stylesheet.test.ts` now pins both halves: `.pov-wall` keeps
`flex: 1` and both minimums, **and** `gridRef` is on `.pov-wall` rather than on
the grid.

## Verified

Headless Chromium against the shipped `app.css`, at 1, 2, 4, 6, 9, 12 and 16
angles across three stage shapes. Every case: cells exactly 16:9 to three
decimals, all cells identical, the grid inside the wall, nothing clipped, and
the video's painted box equal to its cell — no letterboxing left anywhere.

948 tests green, both tsconfigs clean, build green.

# 15. What is still missing for sixteen *live* POVs

The layout half of that request is done, and the pieces below it are in place:
the angle ceiling defaults to 16, live channels on both platforms open as the
recording the platform is already making, and `Export every POV` already fans a
clip out across angles.

**The gap is that a live VOD's duration is read once, at load.** These sources
are ordinary VODs now, so nothing polls them — the timeline stops where the
broadcast was when you added the angle, and clipping something that happened
five minutes later means reloading the POV.

The shape of the fix: mark a source that resolved from a live channel as still
recording, add a small IPC that re-reads the length from its media playlist
(`durationFromPlaylist` already exists and is what live VODs rely on, because
both platforms report `duration: 0` while running), and have the renderer poll
it every minute or so for those sources only. Roughly 60–80 lines across types,
both resolvers, one IPC channel and one timer. Not started — it deserves its own
pass rather than being rushed onto the end of this one.

---

# 16. Only the focused angle showed a live picture — my regression

Opening a live channel as the VOD the platform is already writing (§12/§13) made
those sources ordinary recordings: the media seeks and exports like any other,
so `is_live` is **false**. But `followerTargets` gated its live fallback on
exactly that flag:

```ts
if (source.isLive) {
  // any failure to place this angle → its live edge
}
// otherwise: a target past durationSeconds is null
```

So every follower fell through to the finished-recording branch, where a target
past its length is `null` — and a `null` target is a tile reading "Not recording
at this moment". The leader is returned at the top of the loop without any of
those checks. Hence: a live picture for exactly one angle, whichever was in
focus.

Three ways this fires, all of them normal for a live wall: the follower has no
sync mapping yet, the projection is negative because the two angles were added
minutes apart, or the target is past a `durationSeconds` that was read once when
the source resolved and has been a floor rather than a limit ever since.

## The fix

A source now carries `stillRecording` — distinct from `isLive` on purpose:

- `isLive` — the media *is* the live edge.
- `stillRecording` — an ordinary, seekable, exportable recording that happens to
  be **growing**.

Both resolvers set it when the channel turned out to be on air (`liveVideoUuid`
on Kick, `channelArchiveId` on Twitch, each via a small `onLive` callback), it
rides through `RawInfo.still_recording` into the source, and `stillOnAir()` is
the one place that asks the question. It is used by `followerTargets` and by all
three `povCoverage` spans, so a growing angle is also drawn open-ended on the
timeline instead of stopping at a stale length.

Test: `tests/unit/liveWall.dom.test.ts` — a follower past its known length gets
its edge rather than nothing, a genuinely finished VOD still correctly says "not
recording", and coverage spans read as open-ended. Confirmed to fail on the
exact bug before the fix.

952 tests green, both tsconfigs clean, build green.

**Still open** (unchanged from §15): `durationSeconds` is read once at load, so
the timeline stops where the broadcast was when the angle was added. The wall now
shows every angle live regardless, because the fallback hands back the edge — but
clipping something newer than the load still needs the duration refresh.
`stillRecording` is the flag that work will key off.

---

# 17. Still one live angle — the flag was in the build, not on the sources

§16 shipped and the wall still showed a picture for the focused angle only. The
built app *did* contain the fix (`still_recording` ×4 in the main bundle,
`stillOnAir` ×5 in the renderer), so the flag was simply never on those four
sources.

Two reasons, and the second is the one that mattered:

## `still_recording` was set only for channel links

It was raised by a callback from `liveVideoUuid` / `channelArchiveId` — code
that only runs when someone pastes `kick.com/<channel>`. Every other way an
angle arrives addresses the **video** directly: a VOD link, "Who was live",
"Find POVs by time". Reece's event was built that way, so four live angles
resolved as ordinary finished recordings.

The platforms answer this on the per-video document the app already fetches —
verified live:

```
Kick   /api/v1/video/<uuid>  →  livestream.is_live: true
Twitch GQL video(id) { status } →  "RECORDING"     (RECORDED once it ends)
```

So both resolvers now ask the recording itself instead of inferring from how it
was addressed, and the `onLive` callback plumbing is deleted. Fewer moving parts
and it covers every entry point.

## A saved project holds neither fact

`durationSeconds` and "still on air" are both true only for a moment. A project
saved an hour earlier has stale values and nothing re-asked, so even with the
resolvers fixed, reopening that project would still have been broken — and
re-adding four angles by hand is not a fix.

New `SourceService.liveStatus(source)` re-asks the platform (one resolve per
angle) and returns the length now plus whether it is still recording, behind
`source:live-status`. `App` asks **every** source once when the project opens —
that is what heals a project saved before any of this existed — and after that
only the ones that came back still recording, once a minute. A project of
finished VODs settles into asking nothing.

`setSourceLiveStatus` returns the same project object when nothing moved, so the
timer cannot re-render the wall, and it deliberately does not mark the project
dirty: the world changed, not the person's work.

This also closes the gap flagged in §15 — the timeline now grows as the
broadcast does, so a moment from five minutes ago is clippable without
reloading the POV.

952 tests green, both tsconfigs clean, build green, and the built bundles carry
all four new symbols.

## Note on the timeline in that screenshot

The POV rows were missing because `timelineBands` drops the whole band when the
rows would be under 7px — the strip was about 60px tall there. That is the
existing "drag the timeline taller to see who covered what" behaviour, not a
new fault. Worth revisiting if it keeps reading as broken.

---

# 18. Playback stopping at the end of what was loaded, and starting blurry

## 1. The playlist said it was finished when it was not

A player stops re-reading a media playlist the moment it sees
`#EXT-X-ENDLIST` — the list is final, so there is nothing left to fetch. Kick's
**in-progress** recordings carry it anyway. Verified against a live channel:

```
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MEDIA-SEQUENCE:0
… 1615 segments …
#EXT-X-ENDLIST            ← while the broadcast was plainly still running
```

So hls.js loaded the playlist once, played to whatever the recording held at
that moment, and stopped: buffer exhausted, nothing ever asked for more. The
pause, the lag and the apparent jump were all downstream of that one line.

**Fix — the protocol's own mechanism, not a workaround.** A source that is
`stillRecording` is fetched through the proxy with `&growing=1`, and
`rewritePlaylist` drops `#EXT-X-ENDLIST` from *media* playlists (never a
master) while that flag is set. hls.js then treats it as a live playlist and
does exactly what it is built to do: re-read on its own schedule, append the
segments that have appeared, and keep playing. No seek, no reload, no
re-creating the element, position untouched. The flag is carried down from the
master to each variant playlist so a rendition switch keeps following.

When the broadcast ends, `liveStatus` clears `stillRecording`, the marker comes
through, and playback ends properly.

Also fixed, and the likely source of "jumps back to the beginning": `timeupdate`
and `seeked` fire on a fresh element **before it has loaded anything**, writing
`0` into the store — which is then where the next initialisation starts from.
Nothing is believed now until `readyState >= 1`.

## 2. It started at the bottom rung and climbed

Two causes, both fixed:

- hls.js's default first bandwidth guess is 500 kbps, which on any real ladder
  picks the smallest rendition for the opening segments. `abrEwmaDefaultEstimate`
  is now 5 Mbps — a *first guess* only; measured throughput replaces it within a
  segment or two, so a genuinely slow connection still lands where it belongs,
  just from above instead of below. Plus `startFragPrefetch` (fetch the next
  fragment while the current one plays) and `capLevelOnFPSDrop`.
- **A newly added POV was not focused.** It arrived as a follower — a small
  muted tile whose player caps quality to the tile's own size — so it spent its
  first seconds choosing a rendition for a postage stamp, and focusing it later
  meant tearing that down and climbing again. `addSource` is now followed by
  `setActiveSource`, so the full-size player is the one that establishes quality,
  once. Followers keep `capLevelToPlayerSize` and their tight buffers, which is
  what keeps sixteen of them affordable.

## Logging

Quality changes, playlist re-reads (with segment count and end time), waiting
and stalls now go to the app log under `player`, so the next occurrence is
diagnosable without a screenshot.

## Verified

`tests/unit/growingPlaylist.test.ts` — the marker survives for a finished
recording, is dropped for a growing one, everything else in the playlist is left
alone, and the flag propagates from master to variants. 957 tests green, both
tsconfigs clean, build green, and the built bundles carry `growing=1`,
`abrEwmaDefaultEstimate`, `startFragPrefetch` and the new log lines.

## Worth knowing

Twitch's in-progress archives do *not* carry `ENDLIST`, so they already
refreshed correctly; this changes nothing for them beyond the shared flag.

---

# 19. Clip → find other POVs → review → add

Reece's spec was eight sections. **Most of §1 and §3 already existed** and it
was worth saying so before building anything on top of them:

- `streamers.add(input, platformHint)` takes a name, handle or URL.
- `discoverSiblings(id)` finds the same person on the other platforms;
  `linkPerson` / `unlinkPerson` group them under one `personId`.
- `SavedStreamer` already stores platform + handle + channelUrl + avatarUrl +
  followers — identifiers, not display names.
- `StreamersPage` (1,031 lines) edits, removes, favourites, groups and
  re-profiles them.
- `streamers.coveringEvent()` and `DiscoveryService` already answer "who else
  was broadcasting over this window", across the library plus a YouTube/Kick
  sweep, and report the platforms they *cannot* sweep rather than returning a
  confident nothing.

What did not exist is §2/4/5/6/7: none of it was wired into **clip creation**,
and there were no preview cards. That is what this adds.

## The flow

Creating a clip now opens `FindPovsDialog` with the clip's real-world window.
It runs the two sweeps in the order they can answer:

1. **The saved library** — a handful of channel listings, back in about a
   second. Those cards are on screen while the second sweep is still running.
2. **The cross-platform sweep** — real searches, the slow one. Results are
   appended as they arrive.

Waiting for both before showing anything would make the fast answer as slow as
the slow one. Each phase says what it is doing (`Checking your saved
streamers…`, `Searching the platforms…`) and the sweep's own notes about what
it could not reach are shown rather than swallowed.

## Cards, and not loading anything to build them

A card is assembled from what the listing already returned: the channel's
picture (from the saved library), the broadcast's own poster, the title, where
in that broadcast the clip begins, and a verdict. **No VOD is resolved or
loaded to draw the list** — a POV is only resolved when the editor picks it,
and picks are added one at a time because each is a platform request.

`shared/povMatch.ts` turns the matcher's existing coverage into something
scannable, and is deliberately conservative at the top: `High timestamp match`
requires `certain` — the two recordings pinned to a shared real-world clock —
not merely overlapping timestamps. Below that: `Covers the whole clip`,
`Covers 62%`, `Only clips the edge`. Best matches sort to the top.
Test: `tests/unit/povMatch.test.ts`.

The keyword sweep can turn up someone who was simply live at the time, which is
not a POV of the same moment. `DiscoveryService` already scores that, and
anything below 0.5 confidence is dropped rather than padded into the list for
the editor to reject one by one — §3's "avoid unrelated streams".

`Add all` / per-card toggles, and an honest empty state that says *why* nothing
matched rather than showing a blank panel.

962 tests green, both tsconfigs clean, build green.

## Not done yet, and worth being plain about

- **Per-card play (§5).** The cards show the broadcast's poster, not a frame at
  the matched timestamp, and there is no in-card playback. Doing it properly
  means resolving that one VOD on demand and building a short preview around
  the offset — `previewMedia` already does exactly that, so it is a contained
  next step, but it is a platform request per play and deserves its own pass.
- **§7's per-POV provenance on the clip.** Selected POVs are added as ordinary
  sources, which is what makes them usable immediately; the clip does not yet
  record which of them arrived through discovery, or the matched offset that
  found them. `momentInVod()` already computes that offset and it is carried
  through the dialog — storing it on the clip is the remaining half.
- §1 was surveyed, not audited line by line against the spec.


## §20 — Adding a streamer by hand

`streamers.add()` had existed since the library was built, was handled in
`main/index.ts`, was exposed on the preload bridge as `addStreamer` — and was
called from nowhere in the renderer. The roster could only grow as a side
effect of `remember()` when a POV was loaded, so a channel you had not clipped
yet could not be put in the library at all, and the Streamers page's one
primary button managed *groups*.

- `StreamersPage` now has an **Add streamer** primary action opening the design
  system's `PromptDialog` (channel address or bare handle — `add()` already
  accepts both via `parseChannelUrl` / `handleOnly`). On success the roster's
  filter and search are cleared before selecting the new row, because a filter
  that hides what you just added reads as a failed add. An already-known
  channel says so rather than looking like nothing happened.
- **Manage groups** drops to a secondary button; the group row's `New group`
  already covered that job.
- The page no longer opens on an empty right pane: with no selection, the top
  of the roster — whoever is on air, else most recently used — is selected and
  its shelf fetched. With *no* streamers at all, the empty state carries the
  add action instead.
- Page meta gains `N streamers · N on air`, reusing the roster's live dot.
- `tests/unit/addStreamerWired.test.ts` guards the wiring, since the failure
  mode here was a reachable backend with no control in front of it.


### A name is enough

The first cut only accepted an address: `handleOnly()` needs a `platformHint`
that nothing passes, so a bare name fell through to `Errors.unsupportedUrl` —
which told the user to paste a *VOD* URL, in a dialog about adding a streamer.

`StreamerService.findHandle()` is the third fallback in `add()`: a name already
in the library resolves offline (re-adding must not depend on three sites being
reachable), otherwise `fetchProfile` is asked for twitch, kick then youtube and
the first channel that exists is saved. Sibling discovery, already on, picks up
the other platforms a moment later. `Errors.unknownChannel` is the new failure —
"nothing answers to that name", not "that is not a VOD link"; a string with a
slash in it still gets the address error, because that is what it is.

`tests/unit/addByHandle.test.ts` stubs `fetchProfile`, so nothing in the suite
reaches a platform: first-hit wins, `@` is stripped, a known name never probes,
and both error codes are asserted.

### Spacing

Verified against the real stylesheet in headless Chromium at 1494×950
(`metaClipped`, `filtersOverflow`, `bodyOverflow` all 0, chip left edge == title
left edge):

- `.group-filters` had **no horizontal padding** — the chip row sat 20px left of
  the title above it and its trailing note ran off the right of the window. Now
  `var(--space-3) var(--space-5)`, matching the header.
- `.streamer-detail-meta` wraps instead of truncating (`68 broadcasts`, `Listed …`
  were being eaten by the ellipsis on a three-platform person). No separator
  dots: one orphans itself at the start of the wrapped line.
- `.streamer-detail-actions` wraps and its search box is fixed at 190px, which
  is what was eating the middle column.
- Roster rows 7px/9px with a 2px gap, rail padded `--space-3`.


## §21 — Why finding other POVs did not work

`StreamerService.vods()` went to the platform every time. Every caller that
wants a channel's broadcasts routes through it — the overlap search behind
"Who was live", the discovery sweep behind "Find POVs by time", the dialog
after a clip is made — so a single question cost **one live channel listing per
saved streamer, plus one request per undated VOD**. With 45 streamers that is
45 listings and ~1,000 date lookups; the log for one afternoon holds 1,088
"Listed channel VODs" and 1,094 yt-dlp failures, nearly all of them YouTube
answering "Sign in to confirm you're not a bot".

The dates never arrived, and `coverageOf()` returns null for a VOD with no
date — so the search did the most work in exactly the case where it returned
nothing. That is the "broken".

- `vods()` now reads the crawled shelf first (`shelfFor`, wired in `index.ts`
  to `vodLibrary.shelf`). That library already holds 1,079 merged, dated
  broadcasts, and VodCrawler — which is throttled, stands aside during exports,
  and dates Twitch channels in one request — remains the only thing that spends
  requests filling it. A channel with no shelf yet is still listed live, so a
  freshly added streamer is usable immediately.
- The whole shelf is offered, not the newest 40, so an event from three weeks
  ago is findable.
- `FindPovsDialog` ran its two-phase sweep on **every app render**: the parent
  builds `loadedUrls` with `.map()`, so the array's identity changed on every
  playhead tick and the effect's dependency list restarted the search several
  times a second. It now captures the URLs at open and depends only on the
  event window.
- `coveringEvent` logs what it searched and what matched — it was the one step
  in this path with no log line, which is why the storm was invisible.
- `tests/unit/shelfFirst.test.ts` asserts the resolver is never called when a
  shelf exists, that a shelf-less channel still lists, and that an event match
  comes out of the shelf with the right offset.


## §22 — The timeline, the chrome, the type, and why exports took an hour

### Timeline

The strip was 104px of canvas: a ruler, a 14px clip bar, and nothing to aim
at. `BASE_CANVAS_H` is 200 and `MIN_CLIP_LANE_H` 84, and the panel floor moved
from 140 to 260 (default 340) so a saved-small strip is pulled back up on load.

`timelineBands` gained a **filmstrip band** under the ruler, fitted first and
dropped whole when the strip is short — half a filmstrip is not worth a clip
edge you cannot grab. `hooks/useTimelineFilmstrip.ts` fetches it **one frame at
a time, two seconds wide**, because the existing `filmstrip` IPC fetches only
the segments its window touches: asking for a filmstrip *across* a four-hour
view would download four hours. Sample times sit on a grid derived from the
slot width, so panning re-asks for times the main process already has on disk.
`filmstripGrid.dom.test.ts` pins that property — it is the whole reason this is
affordable.

### Chrome

`h264_nvenc ready · software fallback armed` is gone: a fact about the machine,
phrased for whoever was debugging the exporter. So are "No downloads" and
"Queue empty" (a status bar earns its row by saying what is happening now) and
the duplicate Diagnostics link, which is a rail item.

### The collapsed rail — twice

First pass: `.app-rail-live` and `.app-rail-flag` were flow children of a
centred row, so a row carrying one had its icon 7.5px left of every row
without. Real, fixed — corner badges now.

That was not what the user was looking at. Collapsed, every row is wrapped in a
`Tooltip`, and `.ui-tooltip-anchor` is `inline-flex`: it shrank to the icon and
the row's `width: 100%` resolved against 16px, so the whole column sat against
the left edge. Measured in Chromium: **x=16 before, x=28.5 after**, in a 58px
rail. My first harness had no tooltip wrapper, which is exactly why the first
fix missed — `stylesheet.test.ts` now guards the rule.

### Type

The scale started at 9.5px and topped out at 13px for body, with weights capped
at 500 by an explicit design decision. Every size up ~1.5px, weights to
450/600/650, controls +2px to keep the air. Eight token values; every rule in
the app reads its size from them.

### Exports

Five clips were running at 2.0–3.9x realtime, all five saying *Cutting (frame
accurate)*. The cause: `ensureNameBadge` put a watermark on **every** loaded
POV, and a watermark sets `redrawing`, which rules out both stream copy and the
smart splice. Every export was a full re-encode, and nobody had asked for it.

The badge is wanted — an angle should arrive in an editor already labelled — so
the fix is the pipeline, not the feature:

- **`overlay_cuda`.** When the watermark is the only redraw and the machine
  passes the startup smoke test, the chain is NVDEC → `overlay_cuda` → NVENC
  with the frames never leaving VRAM. The badge is scaled, tinted and rotated
  once on the CPU (it is a still) and uploaded once. The CPU path was identical
  except that every frame was copied out of the GPU and back.
- **`FfmpegInfo.cudaOverlay`** is a smoke test, not a filter listing: a
  synthetic frame is uploaded, overlaid and NVENC-encoded at startup, so a
  build without nvcc or a driver too old fails there rather than twenty minutes
  into an export.
- **Three fallback rungs, not two.** GPU composite → CPU composite with GPU
  encode → software. Dropping straight to software over one unlucky filter
  would be ten times slower.
- **Presets, not quality.** NVENC p5 → p4 with `-tune hq`, QSV `faster` with
  look-ahead off, x264/x265 `medium` → `veryfast`, SVT-AV1 8 → 10. Every CRF
  and CQ is untouched: the preset decides how hard the encoder searches, not
  how the picture looks.
- The export notes now **name the redraw** that cost the copy, so this can
  never hide again.

`gpuWatermark.test.ts` asserts the GPU graph uploads once, carries alpha, never
downloads, and puts the badge at the same coordinates as the CPU graph — a
silently-moved logo would be the worst way to find out this path was on.

986 tests green, both tsconfigs clean, build green.

### Not done

The spec's **pre-watermarked POV cache** (key: source + range + watermark id +
config) and the **"Preparing POVs… / All POVs ready"** progress UI are not
built. Watermarking is fast now, but it still happens inside the export rather
than as a cached preprocessing pass, so exporting the same range twice does the
work twice.


## §23 — The editing-project export

The app now hands a finished clip to an editing application with the timeline
built, the angles synchronised and the watermark placed — and does it without
reading a frame of video.

The architecture is the one the spec asks for and the one the codebase already
half had. `shared/watermark.ts` has always stored a watermark as a normalised
transform rather than pixels, and `WatermarkEditor.tsx` has always dragged it
as a DOM overlay, so Phases 1 and 2 were done before the spec arrived. What was
missing was everything downstream of them.

- `shared/editingProject.ts` — the universal model plus the timebase maths.
- `shared/buildEditingProject.ts` — pure; clip + POVs + exported files in, model
  out. A POV that started rolling after the moment began is placed *late*, by
  the gap between its requested and actual start. Laying every file at zero is
  the bug that arithmetic prevents.
- `main/export/` — the package layout, the HTML guide, and three adapters:
  generic (manifest + guide), Resolve (Python against the verified scripting
  API), Final Cut (FCPXML 1.9).
- `EditorExportWizard.tsx` behind "Send to an editor" on the clip panel.

Two things carry the most risk and are therefore pure and tested: the
coordinate conversions (Resolve is centre-pixels with Tilt **up**; Final Cut is
centre-percent, also Y-up; both scale by a multiplier on the item's own size,
so a 12%-of-frame logo is not `scale 0.12`), and the timebase (NTSC is
rational; 29.97 as 30 costs a second an hour).

The acceptance test builds 20 angles × 4 hours and asserts the export writes
only `.py`/`.json`/`.html` and finishes in under five seconds. `ProjectExportService`
logs `msPerHourOfMedia` for the same reason.

**Movavi, CapCut**: no published project format and no standard interchange
import, verified. They get the portable folder and a guide that states every
sync offset and the exact watermark numbers — and the UI says plainly which
steps are manual. Fabricating a `.mepx` would produce a file that either fails
to open or silently loses angles.

**Premiere, Avid, VEGAS**: `verified: false` in the matrix, no adapter. The
next person should check their current mechanisms before writing one.

### The build trap this uncovered

electron-vite finds the last ESM import in the built main bundle with a textual
regex and splices its CommonJS shim in after it. A string ending in the word
`import` — `"Media import"` — matches that regex, so the shim landed inside a
template literal and the whole main bundle failed to parse, pointing at an
innocent line. `tests/unit/bundleTraps.test.ts` guards it.


## §24 — One angle per person, Twitch first

A restreamer is on Twitch, Kick and YouTube at once with the same three hours.
To the matcher those are three broadcasts that all cover the moment, so a
nine-person scene swept up twenty-seven candidates — and loading two of one
person's simulcast is worse than useless: the wall shows the same angle twice
and the export offers a choice that is not one.

`shared/povPriority.ts` is the whole rule, in one place:

- `PLATFORM_PRIORITY = ['twitch', 'kick', 'youtube']`. Not arbitrary — Twitch
  VODs are the ones this app can put on the clock most reliably (published
  start time, stable duration), which is what the entire sync model runs on.
  Kick is second because its API returns a date; YouTube is last because dating
  it costs a request per video and usually a bot check.
- `personKey()` uses the library's own person link when there is one, and falls
  back to the normalised display name. The fallback is a guess, and a
  reasonable one: sibling discovery matches on the same assumption.
- `oneAnglePerStreamer()` keeps the **better match** first and lets the
  platform break ties only. A Twitch VOD that clips the edge must not displace
  a Kick VOD that covers the whole moment.

Applied in the four places a POV can arrive or be counted: `FindPovsDialog`
(both sweeps, merged then collapsed), `EventDiscovery` (after the editor's own
platform filter — someone who filtered to Kick asked for the Kick one, and a
notice says how many simulcasts were hidden), `EventStreams` (so "Import all"
cannot load the same person three times), and the "Who was live (n)" badge,
which was counting broadcasts and now counts people.

`FindPovsDialog` also excludes anyone already on the wall by *person* rather
than by URL — loading someone's Kick stream and then being offered their Twitch
one is the same duplicate arriving from the other side.


## §25 — Movavi

Investigated properly rather than assumed. Movavi publishes no project format
and no SDK for one; `.mepx` is proprietary and undocumented; their knowledge
base documents no import of XML, FCPXML, AAF or EDL. No `.mepx` was reachable
on this machine to inspect, and inspecting one would not make the format
supported anyway — a file written from a guess either refuses to open or opens
having silently dropped angles, which §75 of the spec rules out and which is
genuinely worse than no file.

So the adapter generates no project, and instead removes the work a project
file would have saved. The important realisation is in `mapEventRangeToPov`:
**every POV's cut is mapped from the same real-world instant**, so every
exported angle *already begins at the same moment*. Which means:

    drop them all at the start of the timeline → they are in sync

No nudging, no waveform alignment, no arithmetic — for every angle whose
recording covers the moment, which is nearly all of them. The only exception is
an angle that started rolling *after* the moment began, and `lateAngles()`
finds exactly those; the guide singles them out with the offset instead of
listing twenty offsets of zero.

`MovaviExporter` therefore ships:

- `Editor/movavi-timeline.csv` — track order, file name, start time, length,
  source size and rate per angle, then the watermark numbers in a form that can
  be typed into Movavi's own fields.
- Media copies numbered in track order (`01 - name.mp4`), so selecting them all
  and dragging them in lands the tracks in a sensible order rather than
  whatever the file manager felt like.
- A guide whose steps change with the data: "drop them all at zero, they are
  already in sync" when every angle aligns, and "these two go this far in"
  when they do not.
- `projectGeneration: 'partial'`, not `'none'` — there is no project file, but
  the export is not nothing, and the UI now says which of those two it is.

### A duplicate-copy bug this found

Every adapter called `preparePackage` and then `writeBasePackage`, which called
`preparePackage` again — so the media was copied twice and the numbered copies
came out `02 - 02 - name.mp4`. Invisible until the copies were named. One
caller, one copy, and a test that counts the files.


## §26 — Find-POVs, re-checked (and one bug the dedupe hid)

The flow is intact: every route to a new clip goes through `requestCreateClip`
→ the name prompt → `createClip`, and the search fires in that same handler.
Separating those two is how the automatic part would quietly stop being
automatic, so `findPovsWired.test.ts` now pins them together, along with the
dialog rendering, the event window being passed, both sweeps being called, the
once-per-opening effect, and the add path.

**The bug.** §24's "do not offer somebody already on the wall" compared
`personKey()` on both sides — but that function answers with the *best* key it
has: the library's person link when there is one, the name otherwise. A loaded
POV known only by name produced `name:leonarwho` while the same human found by
the sweep produced `person:p1`, so the two never matched and the duplicate came
straight back. Silent, and exactly the case the exclusion was written for.

`personAliases()` returns every key an identity could be known by and
`samePerson()` compares the sets, so a name on one side and a person link on
the other still meet. The loaded set is also built through the streamer library
now (platform + handle → saved streamer → person) rather than from the display
name alone.


## §27 — 1.6.0, prepared

`package.json` is at 1.6.0, `CHANGELOG.md` has the entry, and
`release/RELEASE-NOTES-1.6.0.md` is the same text ready to paste into the
GitHub release body. `EditorExportWizard` now stamps the real app version into
every exported manifest instead of the placeholder `'1'` — "which build made
this project" is the first question asked when one turns out wrong.

Everything green at 1.6.0: 1,045 tests, both tsconfigs, `electron-vite build`.

**Not done here, and deliberately.** Packaging is `npm run package:win`, which
needs Windows for the NSIS installer — the bridge into this machine is a Linux
VM with the folder mounted, and its `node_modules` are the Windows install, so
a build from here would either fail on the platform-specific esbuild binary or
produce an installer nobody should ship. Publishing needs a `GH_TOKEN` for
`Omega248/RipperClipper`, which is a credential, not something to hand around.

    npm run package:win
    # then, with GH_TOKEN set:
    npx electron-builder --win --config electron-builder.js --publish always

Auto-update reads `latest.yml` from the release, so the release has to carry
both the installer and its `latest.yml` — `--publish always` uploads both.

### Publishing it

`release/publish-1.6.0.bat` does the whole run: checks `GH_TOKEN` is present
without printing it, fetches the bundled tools, type-checks and builds, then a
single `electron-builder --publish always` that packages and uploads in one
pass (`npm run package:win` would have built the installer twice). Everything
goes to `release/publish-1.6.0.log`, which is readable from the mount
afterwards — so a failed run can be diagnosed from here without a screenshot.

It has to be run on Windows, by a person: the Linux bridge has no wine, so an
NSIS build is impossible from there, and computer-use grants terminals in
click-only mode — visible, not typeable. Neither is a policy dodge; both are
what the tooling allows.

electron-builder creates the GitHub release as a **draft**. Nobody updates
until it is published by hand, which is the right shape for a release this
size.
