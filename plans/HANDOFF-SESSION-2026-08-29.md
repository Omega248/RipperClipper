# Session handoff — 2026-08-29

Companion to `plans/HANDOFF.md` (which stays the project's cold-start doc).
This covers **only what changed in this session**, what is proven, and what is
half-finished.

**Nothing here has been built or run on Windows.** The sandbox cannot run the
build or the test suite — see §6. Both `tsc` configs pass; that is the
strongest static guarantee available from here.

---

## 1. What was asked, in order

1. Exports pegged the CPU and took ages — make clipping fast and light.
2. The whole PC stutters during export; light/dark switching is slow; check
   every page works.
3. Add YouTube + live clipping for YouTube, Kick and Twitch; show channels live.
4. Streamers tab should slowly load all past VODs in the background and let
   them be browsed there. **← in progress, see §5**

---

## 2. Workstream 1 — Smart cut (done, verified)

**Problem.** `cutMode: 'smart'` with `keyframeToleranceSeconds: 0.5` re-encoded
the *entire* clip whenever the in-point missed a keyframe by >0.5s. Twitch/Kick
GOPs are ~2s, so that fired most of the time. Software encoder was pinned at
`libx264 -crf 18 -preset medium`.

**Fix.** Only the frames between the mark and the next keyframe genuinely need
re-encoding. The exporter now encodes that head, stream-copies the tail, and
splices them through MPEG-TS.

Measured, 1080p30, 30s clip, 2s GOP, 2 cores: **30.8s → 1.7s (18x)**.

### Two ffmpeg traps this hit — do not "simplify" these away

Both are documented in comments at the call sites in `exporter.ts`.

- **An output-side `-ss` is silently ignored on a video-only mapping**
  (ffmpeg 6.1). The head came out starting at the pre-roll, seconds early. The
  head is therefore bounded with **input-side `-ss`/`-to`**.
- **The final mux trims sound with an output `-ss`, and slides the spliced
  picture onto the sound's clock with `-itsoffset`.** Seeking the *audio input*
  instead ran sound 0.85s late (a stream copy has no accurate input seek, and
  `-avoid_negative_ts` then shifts everything forward). This was caught by the
  test, not by reading.

### Files
- `src/main/media/exporter.ts` — `planSplice`, `runSplice`, splice decision,
  `SPLICE_*` bounds.
- `src/shared/types.ts` — `ExportSettings.smartCut`.
- `src/shared/defaults.ts` — default `true`, added to both `pick` lists.
- `src/renderer/src/components/QualityPanel.tsx` — "Exact cuts" control.
- `tests/integration/pipeline.test.ts` — +4 cases (the pre-existing
  "Smart Mid GOP" case now sets `smartCut: false` so it still tests the
  single-pass path).

### Falls back to single-pass when
clip < 3s; head > 20s or > half the clip; tail < 1s; source is AV1/VP9
(MPEG-TS cannot carry them); or anything redraws the picture (watermark,
transform, PiP, audio edits).

---

## 3. Workstream 2 — Machine responsiveness (done, not observed running)

- **Child-process priority.** `src/main/services/process.ts` gains
  `ProcessPriority` (`normal` | `background` | `idle`) applied via
  `os.setPriority` after spawn. Exports run `background`; filmstrips,
  waveforms and scene detection run `idle`. This is the main fix for "the whole
  PC freezes".
- **A core is left unclaimed.** `src/main/index.ts` — encode thread budget is
  `cores - 1` divided by concurrency, not `cores`.
- **Theme switching.** The real cause: `settings:update` called
  `detectEnvironment()`, which re-ran **full FFmpeg detection including a
  one-frame smoke-test encode per hardware encoder** — up to a dozen child
  processes — and the renderer then made a *second* IPC call for `env`.
  Changing the theme waited for all of it.
  - `FfmpegService.detect()` and `ResolverService.detect()` now memoise against
    the paths they were derived from, with a `force` flag. Startup, tool
    installs and "Re-check everything" force; a settings change does not.
  - `store.patchSettings` applies optimistically and reconciles, and only
    refreshes `env` when `patch.advanced` is present.
  - Call sites moved over: `App.tsx` (`patchUiSettings`), `AppHeader.tsx`
    (`setTheme`), `SettingsDialog.tsx` (`save`).

**Not verified.** No build was run. Worth confirming on Windows that
`os.setPriority` actually lands (it should — lowering your own child is always
permitted) and that theme switching is now instant under export load.

---

## 4. Workstream 3 — Live clipping (done, verified end to end)

`LiveBuffer` and `LiveService` were already complete and correct. **Both ends
were disconnected**: `sources.ts` rejected every live URL, nothing in the
renderer called `liveWatch`, and nothing called `archiveResolved`.

### What was connected
- **Channel URLs resolve as live sources** — `twitch.tv/name`,
  `kick.com/name`, `youtube.com/@name/live`. `UrlMatch.kind: 'vod' | 'channel'`.
  Reserved-path guards stop `twitch.tv/directory` and `kick.com/browse` being
  read as people; host guards stop `clips.twitch.tv/slug` (caught by test).
- `VodSource.isLive` — what the source *is*, distinct from `live` (buffer state).
- **`App.tsx` reconciling effect** holds media for exactly the live POVs in the
  open event. Written as a diff, so removing a POV / closing a project /
  switching events need no code of their own. Keyed on ids only — the source
  object changes on every state push.
- **Export from held media.** `Exporter.setLiveMedia(LiveMediaSource)` — a
  one-method interface. Live clip in/out are **wall-clock epochs**, not offsets.
- **Archive resolution.** `LiveBuffer` gained a `findArchive` socket;
  `index.ts` supplies it.

### The subtle bug worth re-reading
First end-to-end run cut the wrong frames — a full second off, keyframe-snapped.
The buffer's epochs and `writeRange` were both correct. Cause: **ffmpeg cannot
seek accurately in a raw concatenation of independently-muxed TS segments** —
each carries its own PCR and program tables, so no coherent index spans the
joins. Asking for 1s in returned the frame from 3s in.

Tested four normalisations: TS copy remux, `+genpts`, `+genpts+igndts` — all
still wrong. **Matroska fixed it exactly** (explicit per-frame timestamps + a
real index). The live path now does one `-c copy` pass into `.mkv` before
cutting. That is why the cut, the splice and the verify need to know nothing
about live.

### Archive detection: by *novelty*, not by date
First attempt filtered on publish time and was wrong — platforms date an
archive from when the broadcast **began**, which is before the app started
watching, so "published since we started" excludes the very VOD being sought.
`index.ts` now snapshots the channel's VOD ids when watching begins
(`archiveBaseline`) and takes the first unfamiliar id afterwards.

### Files
`platforms/{types,twitch,kick,youtube}.ts`, `services/sources.ts`,
`shared/errors.ts` (`liveRangeGone`), `media/exporter.ts`,
`media/liveBuffer.ts`, `services/live.ts`, `services/streamers.ts`,
`main/index.ts`, `renderer/store.ts`, `renderer/App.tsx`,
`tests/integration/liveExport.test.ts` (new).

### Known gap
`findArchiveFor` lives in `index.ts`, which no test can reach. It is the one
piece of live with **no coverage**. Extracting it into a service is the fix.

---

## 5. Workstream 4 — Streamers VOD library (IN PROGRESS — pick up here)

### Decisions already taken (user chose these)
- Layout: **streamer list left, VODs right** (master-detail).
- Depth: **everything, paced slowly** — full channel listing, dates filled in
  gradually and persisted.
- When: **on launch, topped up after**; never while an export is running.

### Done
- **`src/main/services/vodLibrary.ts` (new).** Persisted shelf per streamer at
  `<stateDir>/streamer-vods.json`. Merges a fresh listing over known dates
  (never discards expensive dates), drops delisted VODs, coalesces writes on a
  5s settle timer, `flush()` on quit. Sorts newest-first with undated last.
  `publishedAt: ''` means "asked, platform would not say"; `null` means
  "not asked yet" — that distinction is what stops the crawl looping.
- **`src/main/services/vodCrawler.ts` (new).** One unit of work per tick;
  listings before dates; `STEP_MS 3500`, `IDLE_MS 60000`, `BUSY_MS 20000`,
  `LISTING_TTL_MS 12h`, `START_DELAY_MS 20000`. Stands aside on `queue.busy`.
  `prioritise(id)` jumps a streamer to the front.
- **`services/streamers.ts`** — split the cheap half from the expensive half:
  `listChannelVods()` (one request, no dates, `CHANNEL_LISTING_MAX = 5000`) and
  `vodDate()` (one process). `channelVods()` keeps its old behaviour on top.
  `resolverVods` deleted (superseded).
- **`media/resolver.ts`** — `priority` on `resolve()` and `flatPlaylist()`.
- **`services/queue.ts`** — `get busy()`.
- **`shared/ipc.ts`** — `StreamerVodShelf`, `VodCrawlProgress`, channels
  `streamersShelf` / `streamersCrawlProgress` / `streamersCrawlNow` /
  `evtVodCrawl`, and the `RendererApi` methods.
- **`preload/index.ts`** — `streamerShelf`, `vodCrawlProgress`,
  `refreshStreamerVods`, `onVodCrawl`.
- **`main/index.ts`** — constructs both, starts the crawl after the window
  exists, stops + flushes on `before-quit`, forgets a shelf when its streamer
  is removed.

### NOT done — next steps, in order

1. **Rebuild `StreamersPage.tsx` as master-detail.** Currently a card grid;
   "View VODs" only shows a count and the latest title. Needs: scrollable
   streamer list on the left (keep group filter + search), selected streamer's
   VODs filling the rest, each row loadable as a POV via the existing
   `onLoadVod` path, and crawl progress surfaced (`active`, `pending`,
   `waiting`) so "still filling in" is visible rather than looking broken.
   Subscribe to `onVodCrawl`; call `streamerShelf(id)` on selection (it also
   prioritises that streamer).
2. **Finish `run-crawler.mts` verification** — see §6. Two failures were
   outstanding when the session ended:
   - *"a known date survived the re-listing"* — **confirmed test bug**: it
     compared `vods[0]`'s date against a different VOD's date after sorting.
     Already fixed in the harness; re-run to confirm.
   - *"and it says it is waiting"* — `crawler.progress().waiting` came back
     false after a busy `step()`. **Unresolved — treat as possibly real.**
     A debug line was added but never ran. Check whether `step()` is being
     invoked on the real instance (an earlier scratch line in the harness did
     `.call({ ...crawler })`, which would mutate a copy).
3. **Consider the crawl's first-run cost.** A channel with 300 VODs is 300
   yt-dlp processes at ~3.5s apart ≈ 17 minutes. Fine, but worth a visible
   "filling in the back catalogue" affordance so it reads as deliberate.

---

## 6. How to verify anything in this repo from a sandbox

`node_modules` is Windows-only (`@rollup/rollup-linux-x64-gnu` missing) and the
npm registry is blocked, so **vitest cannot run here**. The workaround used all
session, and it works well:

```
node --experimental-transform-types --import ./scripts/sandbox-loader.mjs <script>.mts
```

`scripts/sandbox-loader.mjs` is committed — it is a `registerHooks` resolver
that maps the codebase's `./x.js` specifiers onto the real `.ts` files, so
Node's own type stripping runs the actual source with no bundler.
`--experimental-transform-types` (not `--strip-types`) is required — the
codebase uses constructor parameter properties.

Harnesses written this session (in the sandbox, not the repo):
`run-smartcut.mts` (33 checks), `run-live.mts`, `run-crawler.mts`,
`adapters-check.mts` (15 URL cases). They mirror the vitest files but print a
checklist. **Re-create them from the corresponding `tests/integration/*.test.ts`
if needed** — the pattern is: strip the vitest imports, inline `beforeAll` as
top-level await, replace `expect` with a `check(ok, what)` helper.

Real media matters: two separate bugs this session were only visible because
the fixtures decode to identifiable colours and tones per interval. Also — **a
fixture built by encoding each segment independently is not a valid stand-in
for a broadcast**; timestamps must be continuous, so build one recording and
split it with `-f segment`.

**On Windows, run `npm test` and `npm run build`.** Neither has been run since
any of these changes.

---

## 7. Still open from earlier in the session

- **"Check every page works" was never completed.** The installed build at
  `%LOCALAPPDATA%\Programs\Ripper Clipper` is **older than the source** — its
  rail reads Home/Projects/Clips/Export while the source reads
  Backlog/Events/VODs & live — so clicking through it tests code that no longer
  exists. A real page pass needs a fresh build. Theme *tokens* were audited and
  are clean: only 14 hardcoded colours across all CSS, all deliberate (platform
  brand colours, `#fff` on coloured buttons, the Windows close-button convention).
- **"Show channels live"** (live status for saved streamers on the Streamers
  page) was scoped but deferred — the user chose live clipping first. The
  per-platform calls it needs are half-present in `services/streamerProfile.ts`.
- **NVENC is probably not being used.** Export speeds of 0.8–2.9x indicated
  libx264 despite an NVIDIA GPU. Smart cut makes this mostly moot, but the
  "Video: …" note on any export states the encoder plainly — worth a look.
