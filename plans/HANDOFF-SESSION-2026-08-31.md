# Handoff — 2026-08-31: the native player is in the app, and how wide it goes

Continues `plans/HANDOFF-SESSION-2026-08-30b.md`. Read that one for the editor,
the Watch screen and milestones 1–2; this covers milestone 3 onward.

**Read `plans/NATIVE-PLAYER.md` alongside this** — it holds the reasoning and
the measurements; this holds the state.

---

## 1. State, honestly

**Verified in full, 31 Aug:** `npm test` **920 passed, 81 files**; typecheck
clean on both configs; `electron-vite build` produces both bundles.

`_verify.bat` in the repo root is still the Windows path and still worth
running before a release, because it builds on the machine that ships. It is no
longer the only way to check the suite: the Linux copy at `~/verify` (its own
`node_modules`, the Windows ones will not run there) does the same tests and
does not need anyone to double-click.

**A test that reaches into the renderer is now named `*.dom.test.ts`.**
`tsconfig.node.json` excludes that pattern and `tsconfig.web.json` includes it;
both used to hold a hand-written list of filenames instead. Two files had
fallen off *both* lists and so were typechecked by neither — one of them was
building a `ProjectFile` with `schemaVersion: 4` against a type that says 5, an
error that had been sitting there invisibly. Name the file correctly and it
cannot happen again.

## 2. Milestone 3 — seeking. Done.

`?t=` on both pipes, `-ss` **before** `-i`, which seeks the demuxer. **No
segment index was needed** — the milestone expected to reuse `rangeFetcher`'s
window logic and the HLS demuxer already does that job. First frame after a
seek: 99ms at t=5s, 101ms at t=575s. Flat, so it is a real seek and not a
re-download.

On an *exact* frame boundary the HLS path lands one frame early. Not a bug:
ffmpeg targets `t + the container's declared start_time`, MPEG-TS declares
1.400s, the first frame is at 1.421s, and 21ms is under a frame. The harness
asserts the property that matters — within one frame, never *past* the instant
asked for.

The live edge is deliberately not done: a live playlist has no zero to be an
offset from, `t` is ignored there and the header says so. DVR seeking needs a
live source to measure against and there is none here.

---

## 3. Milestone 5 — the native player is in the app

`Settings → Playback → Decoder`, defaulting to **browser**. Turning it on makes
the **POV wall** decode natively. The **focused player stays `HlsPlayer`** —
a decision, not an unfinished edge. A browser is good at playing one video, it
handles rate and fullscreen, and the wall of twelve is where the cost is. It
also keeps the clock where the app already puts it: the focused angle owns the
playhead, followers are told where to be, so `NativeFollower` has no clock of
its own.

| file | what it owns |
|---|---|
| `main/media/framePipeline.ts` | which decode chain, proved by running it |
| `main/media/frameServer.ts` | frames + sound over loopback, a port per tile |
| `shared/frameTiming.ts` | every timing decision, pure and tested |
| `shared/tilePorts.ts` | leasing one origin per on-screen angle |
| `shared/tileRendition.ts` | which rung a tile decodes |
| `player/native/{nv12Tile,audioClock,framePump,registry}.ts` | drawing, clock, reading, measurement |
| `player/NativeFollower.tsx` | prop-compatible with `FollowerVideo` |

Frames cross as HTTP chunked bodies, not IPC: a body is back-pressured for
free — if the page stops reading the socket fills and ffmpeg blocks. An IPC
channel has no brake and the main process grows until it dies.

---

## 4. What running it actually found

Four bugs that no amount of unit testing had caught, because they were all in
the wiring rather than in the parts.

**`TilePorts.configure()` had no callers.** The pool held no origins, every
angle was refused, and the whole wall read "No decoder slot free for this
angle". It built, it typechecked, every unit around it passed. Now called from
`App.tsx`, and the pool moved to `shared/` so it *can* be tested — it was in
the renderer where the test config cannot reach.

**`playing` was captured and never used.** A paused wall kept decoding, and
worse: with a static target the queue eventually drops the frame the playhead
is on, drift crosses the tolerance, and the pipe reopens every 1.5s for as long
as you leave it paused. Pausing now closes the pipe.

**Every tile decoded the wrong rung.** Handed a master playlist ffmpeg takes
the first variant listed — usually the largest — so a 480×270 tile decoded
1080p. This app learned that lesson once already on the browser path
(`capLevelToPlayerSize`); the native path did not get it for free.
`shared/tileRendition.ts` now picks the smallest rung that still fills the
tile: **9x fewer pixels per frame**. This was almost certainly the "only 1 POV
runs smooth" report.

**`atomicWriteJson` failed with EPERM on Windows.** Renaming over an existing
file is atomic on POSIX and is not on Windows, where anything holding the
target for an instant fails it. *Everything durable goes through that
function*: projects, settings, streamers, the VOD library. It now retries the
transient codes (10/20/40/80ms) and fails loudly rather than pretending. Rules
in `shared/atomicWrite.ts`, tested.

---

## 5. How wide the wall goes — and the rewrite that turned out to be unnecessary

`scripts/native-player/stress.mts`, sandbox, **2 cores, software decode**:

| tiles | per tile | of real time | decoders | memory |
|---|---|---|---|---|
| 8 | 30.6 fps | 102% | 8 | 512 MB |
| 16 | 31.3 fps | 104% | 16 | 1.0 GB |
| 40 | 19.7 fps | 66% | 40 | 2.5 GB |

**The memory column above is wrong, and it was measured wrong.** RSS on Linux
and the working set on Windows both count a shared library page once per
process that maps it, and forty ffmpegs map the same libav. Charging each
shared page fairly (PSS) at forty tiles gives **1472 MB, not 3069 MB**. The
harness now measures PSS on Linux and private bytes on Windows; earlier numbers
in this file and in `NATIVE-PLAYER.md` are inflated by roughly 2× and are kept
only so the correction is legible.

That number was the whole case for "fewer decoder processes, each decoding
several angles". The case was tested before it was built —
`scripts/native-player/procmodel.mjs`, 40 angles, 2 cores:

| model | rss | pss | per angle | startup |
|---|---|---|---|---|
| one per angle | 3069 MB | 1472 MB | 36.8 MB | **6.1s** |
| 4 per process | 1492 MB | 1128 MB | 28.2 MB | **0.2s** |
| all in one | 982 MB | 979 MB | 24.5 MB | 1.1s |

**Not worth building.** Sharing decoders takes ~23% off the real memory figure,
and the price is steep: ffmpeg's inputs are fixed when it is spawned, so a
shared process cannot stop, seek or restart one angle without disturbing the
others — which is exactly what the wall does every time a tile scrolls out of
view, pauses, or is scrubbed. A quarter of the memory is not worth that.

**Startup is the real difference** — 6.1s against 0.2s — but forty simultaneous
spawns contending for two cores is not the target machine. Measure it on the
RTX before building anything for it.

The fps column is not quoted from `procmodel.mjs` on purpose: the same
configuration swung between 7.5 and 21.4 fps across runs on this box. Two cores
under forty decoders is not a throughput measurement, and neither is the 19.7
in the table above.

## 6. The wall: eight angles, and you choose which

Two ceilings used to be one number, and it was the wrong number for both jobs.
`maxLivePovs` decided how many tiles decoded *and*, by list order, which ones —
so on fourteen angles the app silently picked the first eight and the only
control was a number in Settings.

They are separate now:

- **`VodSource.hiddenInWall`** — the person's answer to *which* angles. Set
  from the **Angles n/m** button above the wall (`AnglePicker.tsx`). An
  unticked angle gets no tile at all: a tile reading "you turned this one off"
  spends exactly the screen the ticking was meant to reclaim. Persisted with
  the project, because re-ticking eight of fourteen on every reopen would make
  the picker worse than no picker. It is a *view* choice — clips, sync,
  markers, the timeline and export are all untouched.
- **`settings.ui.maxLivePovs`** — the machine's answer to *how many*, now
  defaulting to **8**. It never removes a tile, it just stops it decoding, so
  asking for more than the machine allows is visible and fixable rather than
  silent.

`wallSelection(sources, leaderId, cap)` in `shared/multiPov.ts` resolves both
and is what the grid renders from. The focused angle is exempt from each — it
owns the playhead and the sound, so hiding it would leave the wall with no
clock. `firstScreenful()` backs the picker's **First 8** shortcut and counts
the focused angle *against* the ceiling; keeping it as a bonus would land on
nine tiles with one unable to decode, which is the state the shortcut exists to
escape.

### The 0 that had to be deleted

`maxLivePovs: 0` meant "no ceiling" **and** was the old default, so every
existing install has one and nothing can tell a choice from an inheritance —
which makes a migration impossible while 0 remains writable. So "No limit" is
gone from the options (4/6/8/12/16/24 now; a wall past two dozen is not a wall
anyone reads), which makes `normalizeAngleCeiling()` safe: nothing writes a 0
any more, so anything holding one is carrying the old default and gets the new
one. Deleting the sentinel was smaller than any scheme for living with it.

Covered by `tests/unit/povGrid.test.ts` (the pure logic) and
`tests/unit/wallAngles.dom.test.ts` (the wiring: ticking reaches the wall,
survives a save, marks the project dirty, and leaves the POV otherwise alone).

## 7. Two bugs that only exist on someone else's machine

Both found by looking at the app running on Reece's PC, and neither is visible
on a 100%-scaling display.

### The timeline drew at 40% width, and seeking was 2.5× wrong

`.timeline-canvas-wrap canvas` set a CSS `height` and no CSS `width`. A canvas
with no CSS size lays out at its `width`/`height` **attributes** — which this
component sets to CSS pixels × `devicePixelRatio` for a sharp picture. At 100%
scaling the two numbers are equal and nothing shows. At Reece's 250% the
element rendered 2.5× too wide, `overflow: auto` on the wrap clipped it, and
the timeline occupied 40% of the strip.

Measured off his screenshot rather than guessed: the drawn band was 937px of a
2329px track, and 2329/937 = 2.49.

The picture was the smaller half of it. `xToTime` divides by
`size.current.width` — the *CSS* width — while the element the click landed on
was `dpr`× wider, so **clicking the timeline to seek landed 2.5× along the
wrong part of the broadcast.** One line fixes it: `width: 100%`.

`tests/unit/stylesheet.test.ts` now pins it, along with the brace-balance and
dangling-selector rules that had been living as prose in the 30b handoff ever
since a deleted CSS rule silently turned every settings table into a grid. The
canvas rule is a list of components allowed to scale a canvas by `dpr`, each
paired with the CSS rule that must pin it back; a new one fails until it is
added, which is the point — this trap is invisible until someone runs the app
on a scaled display.

### One angle that could not be decoded took itself out permanently

His Kick POV read **"the decoder answered 503"** beside a Twitch angle playing
perfectly. 503 is the frame server's "nothing here could decode this stream" —
and `ensurePipeline` probes against whichever angle opens *first* and keeps the
answer. So an angle whose stream nothing can decode fails permanently if it
happens to be first, while every angle after it succeeds on a pipeline the
failed one never got to use. Order decided which tile died.

`NativeFollower` now reports 503, 404 and "no WebGL" upward through
`onUnsupported`, and `PovGrid` puts the browser player back on that one tile.
The wall already believed this — *"a machine where the native pipeline cannot
run still gets a working wall rather than an explanation"* — it had just never
been applied per tile. It also gets an HTTP status code off the screen, which
§24 of the brief forbids outright.

## 8. A VOD the platform said was zero seconds long

Reece's Kick angle loaded with a duration of `00:00` and the native decoder
answered 503 on it. The 503 was the tile bug above. The `00:00` was the real
one, and it was not the app's arithmetic:

```
Kick's own answer   duration = 0 ms
From the playlist   duration = 4270 s = 1.19 h
```

Kick reports `duration: 0` for a broadcast it has not finished processing. That
VOD was **complete, public, five renditions, and carried `#EXT-X-ENDLIST`** —
there was nothing wrong with it. The app took the platform's number on trust
and had nothing to check it against.

A zero-length POV is not a degraded POV. It has no span on the timeline, no
coverage row, no window to sync against, and the decoder gives up on it — one
angle of a two-angle event simply did not work.

`durationFromPlaylist()` in `media/hls.ts` sums `#EXTINF` from the cheapest
rendition (every variant lists the same segments; there is no reason to pull
the 1080p60 index to count its rows). `parseMedia` already computed the total —
this only picks a variant to ask. Wired into **both** direct resolvers, and
only when the platform's own number is missing, so a working `lengthSeconds`
still costs nothing. Verified end to end through the real resolver against the
real VOD: 0 → 4270s for the broken one, and Kick's own 29409s still passes
through untouched on one it reports correctly.

For a playlist still growing the sum is what has been published so far — which
is what `durationSeconds` already means for a live source: a floor that moves,
not a length. (It read 3996s, then 4144s, then 4270s across the session, which
is Kick still appending.)

**Existing POVs keep the zero** — duration is stored on the source at resolve
time. Re-add the angle to pick up the real length.

## 9. Verifying, and the traps in it

`_verify.bat` in the repo root: double-click, it writes `_verify.log`, which a
session reads over the folder bridge. Its first version captured
`%errorlevel%` inside a parenthesised block — which expands at *parse* time —
and reported `TEST_EXIT=0` directly above a failure. Fixed; do not reintroduce.

In the sandbox, `npm test` cannot run (Windows `node_modules`). Use:

```
node --experimental-transform-types --import ./scripts/sandbox-loader.mjs <script>.mts
```

Playwright **is** installed in the cloud container at
`/home/claude/.npm-global/lib/node_modules/playwright/index.js`. An earlier
handoff wrongly said it was not — the npm registry being blocked is not the
same as a tool being absent. Check before claiming something cannot be run.

Harnesses: `seek-check.mjs`, `seek-sync-check.mjs`, `sync-check.mjs`,
`frame-server-check.mts`, `stress.mts`, `procmodel.mjs`, `make-fixture.mjs` —
all under `scripts/native-player/`.

Fixtures must be identifiable at every instant (a colour and a tone per block)
and built as **one recording then split**; independently encoded segments have
discontinuous timestamps and test a situation no encoder produces. Build them
in as few processes as possible — ten spawns took 186s on Windows under a
parallel run and blew a hook timeout; the same fixture via the `concat` filter
takes 1.9s.

---

## 10. Open, in the order I would take them

1. ~~Re-run `_verify.bat`~~ — done; §1 has the numbers.
1b. ~~The Kick POV that loaded as zero seconds~~ — fixed, §7b.
2. ~~Look at the angle picker on the RTX~~ — done, on Reece's machine: the
   **Angles 2/2** button, the picker, unticking (the tile goes and the wall
   reflows), and ticking back all confirmed on screen.
3. **Run the wall on the RTX** with real POVs and read the on-tile numbers
   (`30fps +12ms ↻0`) and `Settings → Decoder`'s pipeline line. Those tell a
   capacity problem, a pacing problem and a reopen loop apart; they look
   identical on screen.
4. **`stress.mts --tiles 40` on the RTX** — now that it measures memory
   honestly. Expect fps to clear. Expect memory around 1.5 GB rather than 2.5,
   and decide from that whether forty is a memory question at all.
5. **Startup at forty angles** (§5). 6.1s on two cores, 0.2s if decoders are
   shared. Measure it on the RTX first — this may already be a non-issue there,
   and the shared-process fix costs more than it is worth (§5).
6. Milestone 4 (native downloading) untouched; its own note says measure first,
   it is network-bound.
7. DVR seeking on a live source, deliberately not done.
8. The audit backlog from the 29 Aug handoff, still untouched.

---

## 11. A note on measurement, since it cost a rewrite

Twice in two sessions a number sent the work in the wrong direction, and both
times the number was the tool's default rather than the thing being asked
about.

- `-hwaccels` lists what the **build** supports, not what the **machine** has.
  Fixed by `verifyPipeline()`, which decodes one real frame per candidate.
- `ps -o rss` and `tasklist` list pages a process **maps**, not pages it
  **costs**. Fixed by PSS / private bytes.

Before a measurement justifies a rewrite, check what the tool is actually
counting.
