# Session handoff — 2026-08-29 (second session)

Continues `plans/HANDOFF-SESSION-2026-08-29.md`. That document ended with three
things outstanding; this one closes all three and reports four bugs found along
the way, three of them in code the previous session had called done.

**The headline correction: the test suite can be run here after all.** The
previous handoff said the npm registry was blocked and Vitest could not start
outside Windows. The registry is reachable from the machine's Linux shell. A
scratch copy of the repo with its own `node_modules` runs the real suite —
see §5. Everything below is verified that way rather than by the hand-rolled
harnesses.

**Still true: nothing has been built or run on Windows.**

---

## 1. Where the four workstreams stand

| Workstream | State |
| --- | --- |
| Smart cut | Done, and it was silently not engaging — see §2.1 |
| Machine responsiveness | Unchanged, still unobserved on Windows |
| Live clipping | Unchanged, passing |
| Streamers VOD library | **Done** — UI rebuilt, §4 |

---

## 2. Bugs found and fixed

### 2.1 Smart cut never engaged on ffmpeg 4.x — `src/main/media/ffmpeg.ts`

`keyframes()` asked ffprobe for `-skip_frame nokey -show_entries frame=pts_time`.
ffprobe 5 and later report a frame's timestamp as `pts_time`; ffprobe 4 and
earlier call it `pkt_pts_time` and return `{}` for every frame when asked for
the newer name. The caller saw no keyframes at all, concluded a splice was
impossible, and re-encoded whole clips — the exact slowness this work set out
to remove, with nothing anywhere saying why.

Now reads **packets** (`packet=pts_time,flags`, keyframes are the ones flagged
`K`). Spelled the same way across versions, and cheaper: no decoding.

This is not hypothetical for a user. The app bundles its own ffmpeg, but the
FFmpeg path is a setting, so an older binary on `PATH` is reachable.

Four smart-cut tests in `pipeline.test.ts` were failing on this and now pass.
Note which ones did *not* fail: the two that check the output frames and
audio sync passed throughout, because the slow fallback produces a correct
file. Only the tests asserting the fast path caught it.

### 2.2 A bleeped export hangs forever on ffmpeg 7 — `src/shared/audioEdits.ts`

The bleep built one `aevalsrc` per range and mixed them over the muted audio
with `amix`. A filtergraph source has no input to wait on, so it is always
ready to produce; when the video encoder pushes back (anything from
`-preset medium` up) ffmpeg 7's scheduler never settles. Measured on one
command and one clip: **0.6s on ffmpeg 4.4, still running after 100 seconds on
7.0.2.** The integration test was timing out at 120s, which is what surfaced it.

The tone is now evaluated over the existing stream with `aeval` — an ordinary
filter, driven by the clip's own samples. No source filter, no mix, one chain.
The 12ms anti-click fade is folded into the amplitude expression, since an
`afade` would apply to the whole stream. That test now finishes in 7s.

### 2.3 An undateable broadcast was re-queued forever — `src/main/services/vodLibrary.ts`

`putListing` kept a known date with `before?.publishedAt ? … : …`. The empty
string means "asked, and the platform would not say" — and is falsy. So every
12-hour re-listing reset those to `null` and the crawl asked the same
unanswerable question again, forever. The file's own comment describes the
distinction the code then discarded. Now keyed on `!== null`.

`datedAt` had the same truthiness bug and would never have been set on a shelf
containing one undateable VOD.

### 2.4 One dead channel starved the whole crawl — `src/main/services/vodCrawler.ts`

A failed listing leaves no `listedAt`, so that streamer stayed permanently the
stalest thing in the library, was chosen again on the very next tick, and
nobody behind them was ever read — a request every 3.5 seconds against a
channel already saying no.

Shelves now carry `attemptedAt` (when the listing was last *tried*, successful
or not). Ordering uses it, so a failing channel drifts to the back, and
`listingIsStale` leaves a failed channel alone for `RETRY_MS` (10 minutes).

Also `prioritise(id)` now ignores a repeat of the id already at the front. It
scheduled the next step at zero delay, and the rebuilt page re-reads a shelf on
every progress event — honouring each one would have pulled the crawl forward
to now, over and over, and the pacing the class exists for would have been gone
for as long as the page was open. Found by reading, not by a test; there is now
a test.

---

## 3. The `waiting: true` mystery from last session

**A harness artifact, not a bug.** `step()` returns immediately unless
`running` is set, and only `start()` sets it. The old harness called `step()`
on a crawler it had never started, so nothing happened at all — which is also
why several other checks in that harness were failing. The vitest version calls
`start()` and drives `step()` by hand; the scheduled timer is 20s out and
unref'd, so it never fires during a test.

The other outstanding check — "a known date survives the re-listing" — was
indeed the test comparing the wrong VOD after sorting, and passes now.

---

## 4. Streamers page — rebuilt as master-detail

`src/renderer/src/components/StreamersPage.tsx` is now roster-left,
broadcasts-right. `App.tsx` passes `onLoadVod`.

- Left: the same group chips and search, a 272px scrollable roster. Group
  colours are dots at that width; the names are spelled out in the detail
  header. Selection is a tint **and** an inset bar, so it survives a
  high-contrast theme.
- Right: the selected streamer's broadcasts, searchable, each row loading as a
  POV through the existing `loadVod`. Because `loadVod` reports its own errors
  and resolves either way, success is read back from the store — the page only
  navigates to the workspace if the source actually landed.
- Crawl progress is stated plainly rather than left to look broken: a line for
  "Reading <name>", a count of what is still to date, and a distinct line for
  "paused while an export is running". A row shows three date states, not two —
  a date, "no date" (asked, refused), and "date pending" (not asked yet). Only
  the last is a promise that something is coming.
- The page follows the crawl on whoever is selected, but only re-reads when the
  pending count moved or this streamer is the active one; a tick that only says
  "still going" is not worth a round trip. See §2.4 for why that matters.

New CSS lives in `app.css` under "streamers: roster and back catalogue" and
"crawl progress note". Only design tokens; no new hardcoded colours.

### The one layout bug it shipped with

The rows were squeezed into a 62px sliver with the rest of the pane empty. The
row markup carried `className="vod-row streamer-vod-row"`, and `.vod-row` in
`app.css` is the VODs page's **eight-column** template
(`62px minmax(0,1fr) 78px 82px 74px 104px 66px 96px`) — defined about 1200
lines further down the file, so it won on source order. The whole row landed in
that first fixed column.

`.streamer-vod-row` is now a complete row style of its own and the `vod-row`
class is gone from the markup; only the inner `.vod-row-title` / `.vod-row-sub`
type styles are still shared, and those carry no layout. The list is capped at
1500px to match `.vods-list`.

**Verified by rendering, not by reading.** The built stylesheets were loaded
into headless Chromium with the page's real markup: the row now measures 1500px
against a 1728px pane. Worth repeating for any further work here — it is much
cheaper than a Windows rebuild and it caught this in one shot.

Still not seen inside the running app beyond the screenshot that found this.

---

## 5. Running the real suite outside Windows

The registry works. Do not install into the repo — its `node_modules` is
Windows-only and would be destroyed. Copy and install beside it:

```
tar --exclude=./node_modules --exclude=./out --exclude=./dist \
    --exclude=./resources/tools -cf - . | (cd ~/verify && tar -xf -)
cd ~/verify && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
node node_modules/electron/install.js     # two suites import electron
npx vitest run tests/unit
npx vitest run tests/integration
```

Each shell call is a fresh, isolated namespace: background jobs do not survive
between calls and `/tmp` is not shared. Run the integration suite in batches
that fit one call, or the results are lost.

`scripts/sandbox-loader.mjs` is still useful for poking at one class without a
test run, and is still committed.

### Results

| | |
| --- | --- |
| `tests/unit` | **645 passed**, 52 files |
| `tests/integration` | **84 passed**, 16 files |
| `npm run build` | typecheck + all three bundles clean |
| `tests/integration/hwEncoding.test.ts` | **cannot run here** — needs `libsvtav1`, absent from both available builds |

Run against **two** ffmpeg builds deliberately: the system 4.4.2 and a modern
7.0.2 (`npm i ffmpeg-static @ffprobe-installer/ffprobe`, symlinked onto
`PATH`). §2.1 and §2.2 are each visible on exactly one of them, and neither
would have been found with one binary.

---

## 6. A test that could not fail — `pipeline.test.ts`, HTTP range export

Worth reading before touching that test.

"Fetches only the needed bytes from a progressive source" was passing when the
file ran alone and failing whenever another test file was in the run. It was
not flakiness in any interesting sense: the fetcher gives ffmpeg
`-probesize 5M`, and the fixture is **2MB**. Opening it reads the whole file,
no seek is ever needed, and whether a Range request happened to appear came
down to timing. The assertion could not distinguish "jumped to the clip" from
"downloaded everything" — the one thing it exists to check.

Two fixes:

- `buildBulkySource` in `tests/helpers/mediaFixture.ts` builds a ~34MB copy of
  the same 120 seconds, comfortably past the probe bound. Size has to come from
  entropy: a solid colour encodes to nothing however many bits x264 is offered
  (`-b:v 3M` produced the same 2MB), so the picture is scaled down and grain
  added. Grain averages out — `sampleColor` scales a frame to one pixel — so
  the colour and tone assertions still hold. It throws if the result is under
  8MB, so a fixture that quietly shrinks fails loudly instead of making the
  test meaningless again.
- `tests/helpers/mediaServer.ts` now destroys the read stream when the response
  closes. Its comment always claimed it charged a client only for what it took;
  it did not, and on a 34MB file that is the difference between "read 3MB and
  jumped" and "downloaded the lot".

The test now records: 2.9MB analysis read, then a seek to 33% of a 34MB file.
Passes alone, in a batch, and on both ffmpeg builds.

---

## 7. Still open

- **Windows.** `npm test` and `npm run build` have not run there. Everything
  above is Linux. The Windows-specific risks are the native `node_modules`,
  path handling, and whether `os.setPriority` lands.
- **`hwEncoding.test.ts`** has not run in either session.
- **The new Streamers page has not been looked at.**
- **"Check every page works"** still needs a fresh build — the installed build
  at `%LOCALAPPDATA%\Programs\Ripper Clipper` is older than the source and its
  rail does not match.
- **`findArchiveFor` in `index.ts`** remains untestable where it lives.
- **NVENC** — export speeds of 0.8–2.9x suggested libx264 despite an NVIDIA
  GPU. Smart cut makes it mostly moot now that it actually engages, but the
  "Video: …" note on any export names the encoder plainly.
- **Which ffmpeg does the packaged app ship?** §2.2 makes that worth knowing:
  the bleep hang is fixed at the source, but the version gap between 4.x and
  7.x produced two separate bugs in one session, so `scripts/fetch-tools.ts`
  and the version check deserve a look.
