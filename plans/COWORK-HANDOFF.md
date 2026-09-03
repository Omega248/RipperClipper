# Ripper Clipper — handoff for a new Cowork session

Last updated: 31 Aug 2026. Supersedes nothing; read alongside
`plans/HANDOFF-SESSION-2026-08-30b.md` for the detail of the last two rounds.

---

## 1. The prompt to paste into a new Cowork session

Copy everything between the lines.

---

You are continuing work on **Ripper Clipper**, a Windows desktop app I am
building. Read `plans/COWORK-HANDOFF.md` in the repo first — it is the current
state of play — then `plans/HANDOFF-SESSION-2026-08-30b.md` for what the last
two sessions changed and why.

The repo is on my computer at `C:\RipperClipper-main` (mounted for you at
`$HOME/mnt/RipperClipper-main`). There is **no git**, so do not look for
history and do not offer to commit; the `plans/` folder and the project docs
are the only record.

Work like this:

- **Ponytail mode, full.** Laziest solution that works. Reuse before writing.
  Root cause, not symptom. Read the whole flow before picking a fix.
- **Comments carry the rationale.** Match the existing style: explain *why*
  a line exists and what broke without it, not what it does. Delete a comment
  that only restates the code.
- **Every non-trivial change leaves one runnable check.** Put logic that has to
  be right in `src/shared/` as a pure function and test it in `tests/unit/`.
  Do not write DOM tests.
- **Verify before claiming anything works.** The commands are in §5 below.
  `npm test` cannot run in the repo itself — §5 explains why and what to do.
- Ask me before big architectural changes; otherwise decide and go.

Then: <say what you want done>

---

## 2. What the app is

A non-destructive **multi-POV VOD clip editor** for Twitch, Kick and YouTube.
You load the same event from several streamers' VODs, they are aligned to one
real-world clock, and you mark clips once — every angle of that moment comes
with the clip. Nothing is downloaded whole; only the marked ranges are fetched
and muxed on export.

Electron 33 · React 18 · Vite (electron-vite) · Zustand v5 · Vitest ·
ffmpeg/ffprobe as the media engine.

**The one idea everything rests on:** a clip owns a *real-world* range
(`eventStartTime`/`eventEndTime`), not a VOD range. Each POV's local range is a
projection through that POV's `syncMapping`. That is what lets a POV added days
later inherit every existing clip with no backfill. Never make a clip own a VOD
range.

### Layout

```
src/main/       Electron main: platform adapters, media engine, projects, services
src/preload/    the IPC bridge
src/renderer/   React app (store.ts is one Zustand store; app.css is one stylesheet)
src/shared/     pure logic used by both sides — this is where the testable parts live
tests/unit/     ~57 files, pure-function tests
tests/integration/  real ffmpeg runs against generated fixtures
plans/          handoff docs
```

### The three screens

- **Watch** (`page === 'video'`) — the player, the POV wall, and the broadcast
  timeline. Where clips get marked.
- **Clips / Properties / Export** — organising and exporting.
- **Editor** (`page === 'editor'`) — the multi-track sequence editor. Ships on
  `dev` and `experimental` channels only; `stable` drops the module graph
  entirely (`__EDITOR_ENABLED__` in `electron.vite.config.ts`).

---

## 3. What the last two rounds changed

### Every POV runs at once
The POV wall was capped at six live decoders. The cap is gone: followers cap
their HLS level to the size they are drawn at (`capLevelToPlayerSize`), cap
again on FPS drop, hold ≤8 MB each, and stop loading while scrolled out of
view. `livePovBudget()` returns every angle by default; `Settings → Appearance
→ Angles at once` is the only ceiling (0 = none).

### The Editor was rebuilt
Real ruler with adaptive ticks and drag-to-scrub, a marker lane, one scrolling
canvas with pinned headers, Ctrl+wheel zoom, playhead follow, marquee and
shift-click multi-select with group drag, linked picture/sound that move
together, snap toggle, ripple, copy/paste, right-click menu, two-row track
headers with rename and reorder, a status bar, and a full key map
(S · Del · Ctrl+D/C/V/X/A · ←/→ nudge · `[` `]` · M · F · Home/End).

### The Watch timeline was rebuilt
It used to be a flat grey bar. It now draws **one row per POV** showing where
each recording sits on the focused angle's ruler — colour-coded, the watched
angle outlined, live broadcasts' trailing edge faded, unaligned angles hatched
and named. Clicking a row seeks there *and* switches to that angle. Below it, a
**selection bar** states the marked range once: In/Out as editable timecodes,
duration, jump-to-edge, loop, Add clip, clear — and teaches the flow when
nothing is marked. In/out handles are draggable.

### Full per-clip POV control
`ClipTimeline.tsx` is now the single control surface for a clip's angles. One
row per POV with: coverage bar, its position in that POV's own VOD, a **per-clip
alignment nudge** (`povOffsets` — in the data model since forever, previously
only reachable through the waveform dialog), **picture** and **sound** source
toggles, and a **used** marker. Plus `Use best` (picks the best-covered,
best-aligned angle for each role) and `Reset alignment`. A plain-language line
states what the export will actually be. `PovMatrix.tsx` was deleted — it was a
second, weaker copy of the same thing.

### Two bugs fixed
- **Filmstrips produced no frames on some VODs.** The mjpeg encoder refuses
  limited-range YUV; whether the decoder hands it full or limited range depends
  on the platform's tagging, and Kick's lands on the refusing side. Fixed with
  `format=yuvj420p` in the filter chain (`main/media/thumbnails.ts`).
  Reproduced and confirmed against ffmpeg 6.1.
- **Concurrent writes corrupted the streamer library** (earlier session) —
  `atomicWriteJson` shared one temp filename per process. Fixed with a sequence
  number; `parseJsonSalvagingTail` recovers already-damaged files.

---

## 4. House rules that are not obvious from the code

- **Comments explain why.** Every non-obvious line carries the reason it exists
  and what broke without it. This is the single strongest convention in the
  codebase — match it.
- **Pure logic goes in `src/shared/`.** Anything that has to be *right* —
  timing arithmetic, snapping, layout geometry, coverage — is a pure function
  there with a unit test, not a lump inside a component. Two copies of the same
  arithmetic in a painter and a hit-tester is a bug waiting to happen; that is
  why `timelineBands()` exists.
- **Never fake functionality.** No placeholder progress, no simulated exports.
  If a platform cannot do something, say so in the interface.
- **Errors name the real cause and what to do.** No "Something went wrong."
- **Do not duplicate a control.** Two rounds of this work were spent removing
  the same button from three places. One home per action.
- **Stream-copy over re-encode, always.** Only encode when the cut genuinely
  cannot be made losslessly.

---

## 5. How to verify (read this before running anything)

`node_modules` in the repo is a **Windows** install. Running `npm test` or
`npx vitest` there fails with `Cannot find module @rollup/rollup-linux-x64-gnu`.
That is expected, not a broken repo.

Build a Linux scratch copy once per session, then run everything there:

```bash
# 1. scratch copy (no node_modules)
mkdir -p $HOME/verify && cd $HOME/verify
rsync -a --exclude node_modules --exclude out --exclude release \
  $HOME/mnt/RipperClipper-main/ .
npm install --no-audit --no-fund      # a few minutes, once

# 2. ffmpeg + ffprobe for the integration tests
mkdir -p $HOME/ffm && cd $HOME/ffm
npm i ffmpeg-static @ffprobe-installer/ffprobe --no-audit --no-fund
mkdir -p $HOME/bin
ln -sf $HOME/ffm/node_modules/ffmpeg-static/ffmpeg $HOME/bin/ffmpeg
ln -sf $HOME/ffm/node_modules/@ffprobe-installer/linux-x64/ffprobe $HOME/bin/ffprobe
```

Then, after every change, sync and run:

```bash
cd $HOME/verify
rsync -a --delete --exclude node_modules $HOME/mnt/RipperClipper-main/src/ src/
rsync -a --delete $HOME/mnt/RipperClipper-main/tests/ tests/

npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
PATH=$HOME/bin:$PATH npx vitest run
npx electron-vite build                            # stable
RIPPER_CHANNEL=experimental npx electron-vite build # with the Editor
```

**Current state: 831 tests, 830 pass, 1 skipped.** The one skip is
`hwEncoding.test.ts`, which needs an ffmpeg built with `libsvtav1`; the static
build does not have it. That is the only expected failure — anything else is
yours.

**Rendering the UI to check it.** Headless Chromium in the cloud container
against the real stylesheets has caught a real layout bug every single time.
Copy `src/renderer/src/design/tokens.css`, `src/renderer/src/ui/ui.css` and
`src/renderer/src/app.css` next to a small mock HTML page, stage them, and
screenshot with Playwright (`/home/claude/.npm-global/lib/node_modules/playwright`,
CommonJS — `import pw from '...'; const { chromium } = pw`). Measure rects as
well as looking at the picture.

---

## 6. Open items

**Not done, in rough priority order:**

1. **Windows `npm test` / `npm run build` have never been run.** Everything is
   verified on Linux. Worth doing once on the real machine.
2. `TimelineLivePlayer` keeps one warm decoder per POV referenced anywhere on
   the sequence, unbounded in count (bounded in bytes). Twenty POVs on a
   timeline is twenty hls.js instances.
3. **Audit backlog**, none of it applied: two overlapping keyframe probes per
   export; a redundant probe per HTTP window; a failed HLS window leaving
   in-flight downloads running; uncached event-coverage lookups; cache prune
   stat-ing the whole directory; canvas repaint on every mouse move;
   `WatermarkOverlay` doing one IPC per tile; no `React.memo` anywhere.
4. Persist the *stable* half of a resolve (title, duration, date, resolution,
   fps, codec) — deliberately **not** the signed URLs, which expire.
5. `claude/build-status.md` in the project is badly stale.
6. Per-POV independent trim within a clip (each angle its own in/out). The
   model supports a shift (`povOffsets`) but not a per-POV range; today that
   job belongs to the multi-track Editor.

**Housekeeping:** `_to_delete/` in the repo root holds scratch HTML/CSS from the
headless renders plus the deleted `PovMatrix.tsx` and the previous
`ClipTimeline.tsx`. Delete the folder — I could not delete files on your
machine from the session.
