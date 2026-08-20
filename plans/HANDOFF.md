# Ripper Clipper — HANDOFF

Read this cold. Everything needed to continue is here or named by exact path.

---

## 1. Goal

**Ripper Clipper** is a Windows desktop app (Electron) for editing NoPixel GTA-RP
**multi-POV** VOD footage. One event is streamed by 5–10 people at once; the
editor wants the same moment from every angle, cut and exported without
downloading 6-hour VODs.

Why it exists: the alternative workflow is "download giant VOD → wait → import
to an NLE → wait → cut". This app replaces that with "paste link → watch → mark
moment → name it → export just that range, from every POV".

Non-negotiables the user has stated repeatedly:
- Never download or process a whole VOD. The unit of work is **clip × POV**.
- Never fake anything: no placeholder processing, no fake progress, no claiming
  a thing works without testing it with real media.
- The source VOD is never modified; all audio decisions are stored as
  instructions and applied only when a file is written.
- **Zero setup.** The user runs the app; it installs FFmpeg, yt-dlp and
  whisper.cpp + speech model itself.
- No DRM/auth circumvention. Only publishers' own release channels, checksum
  verified.

---

## 2. Current state

Repo: the source of truth is the user's own copy at `C:\Cookie-Clipper`; they
build it on Windows. A sandbox working copy is disposable — stage the tree in,
work, and write the changed files back over the device bridge.

Stack: Electron 33 + TypeScript + React 18 + Vite (electron-vite), Zustand,
Vitest. **428 tests pass, 8 skipped** (the skipped ones are the ground-truth
word-timing tests, gated behind `RUN_ASR=1`; they pass — see §2.1).

### Done and verified with real media
- VOD acquisition: Twitch, Kick, YouTube behind one adapter. Kick's bot
  protection is handled directly (UUIDv7 broadcast timestamps + Chromium
  `net.fetch`), not via yt-dlp impersonation.
- Streamer library, past-broadcast browsing, date/time lookup, auto-remember on
  POV load.
- Event-time architecture: clips own a real-world range; each POV's local range
  is **derived**. Adding a POV later backfills every clip by construction.
- Sync: platform metadata → confidence → manual waveform align (per VOD and per
  clip) → audio cross-correlation fallback → padding when uncertain.
- Native player for all platforms; POV switching preserves the moment.
- Clips: in/out, naming, per-POV coverage states, event + clip timelines,
  markers, reorder/duplicate, undo/redo, "find in all POVs".
- Audio: **profanity only** — music detection and music removal were deleted
  in full (see §2.1). One finding per word per clip × POV; strong-profanity-only
  by default; every finding is a proposal with real before/after previews
  rendered through the export graph; bulk actions state their scope before they
  run; findings are scoped to the POV they were measured in.
- Export: range-only fetch, best video + best audio, stream-copy where possible,
  separate video/audio POV, filename + folder templates, queue with
  pause/retry/cancel, ffprobe verification, combined export.
- Four pages: VIDEO (player, Show All grid, timelines), AUDIO, PROPERTIES,
  EXPORT. Timeline shows profanity regions at their exact event time, coloured
  by state; clicking one seeks, switches POV and opens Audio focused on that
  finding.
- Watermarks: per-VOD config with a streamer-level default, a visual
  drag/resize/rotate editor, a normalised (resolution-independent) transform,
  9 anchors, live preview over the player, applied per POV at export only.
- Self-setup: FFmpeg, yt-dlp and whisper.cpp + model install automatically on
  first run, checksum-verified, into the app's own folder.

### Done and verified (UI)
- **Design system.** `src/renderer/src/design/tokens.css` is the only place a
  colour is written; `src/renderer/src/ui/` holds one implementation each of
  Button, IconButton, Icon, Select, Menu/ContextMenu, Dialog/Confirm/Prompt,
  Tooltip, Input/Field/Checkbox/Slider, TimeInput, SearchInput, PageHeader/
  Section, Badge/Status, and the feedback set (ProgressBar, Spinner, Skeleton,
  EmptyState, ErrorState, Notice). `src/shared/status.ts` is the one status
  vocabulary. Counts now: **0 colour literals** outside tokens.css, **0** native
  `<select>`, **0** `window.confirm`/`window.prompt`, 0 one-off button styles.
- **Themes.** `system | light | dark`, default `system`, persisted, applied by
  `ui/useTheme.ts` and mirrored onto `nativeTheme.themeSource` in main. Light
  and dark are separately authored mappings, verified side by side.
- **Every page migrated**: shell/nav, Video, Audio, Properties, Export,
  Settings, every dialog, toasts, timelines, transport, POV cards, queue.
- **Machinery hidden.** CUDA/PyTorch/Demucs/whisper/FFmpeg/yt-dlp wording is
  gone from normal UI and from `errors.ts`; it survives in Settings →
  Diagnostics and behind `ErrorState`'s "Show technical details".

## 2.1 The 2026-08-19 production pass

Three things changed shape. Read this before touching audio, streamers or
export.

### Music detection and music removal are gone

Deleted, not hidden: `musicDetect.ts`, the separator, the separation pipeline,
the AI-runtime installer (Python/PyTorch/Demucs), the music rows, the music
settings, the music filter kinds and the music AI model panel. `AudioEditKind`
is now `mute | bleep | duck`; `AudioEditOrigin` is `profanity | manual`.

Old projects are migrated on open by `migrateAudioEdits()` in
`src/main/services/projects.ts` (`schemaVersion: 4`): music-origin findings are
dropped, `reduce-music`/`remove-music` become `mute`, `strength` is stripped.
`tests/unit/musicMigration.test.ts` holds that contract. There are no dead
controls left — grep for `music` before believing otherwise.

### Profanity timing is now measured, not guessed

The reported bug ("the mute starts late and eats the next word") had **two**
independent causes and both are fixed:

1. **whisper gave one timestamp per segment, not per word.** It now runs with
   `--output-json-full --max-len 1 --split-on-word --dtw <preset>` and reads
   `t_dtw`. If the binary rejects `--dtw`, `transcribe.ts` falls back and sets
   `dtwSupported = false`, and every finding produced that way is tagged
   `timingSource: 'inferred'` and padded more generously.
2. **`t_dtw` is not the word's start.** Ground-truth fixtures (sentences built
   by concatenating individually-synthesised words, so every span is known by
   construction) showed it is a **lagged end anchor**, 30–300 ms late. The lag
   table is in the header comment of `src/shared/profanityTiming.ts`.

`profanityTiming.ts` is the correction layer: an 8 kHz amplitude envelope of the
clip window → voiced runs → a segmental dynamic program (`assignRunBlocks`)
that assigns runs to tokens monotonically, scored on position **and** expected
duration. Without the duration term a short word steals a long word's run
("is" took 0.71 s while "fucking" kept 0.25 s). `padWord` then extends over the
consonant release and the initial fricative, which carry 21–25 % of the energy.
Safety margin is **0.04 s** for measured timing, 0.2 s for inferred — not ±1 s.

3. **FFmpeg's `volume=enable=` is evaluated per audio frame**, so a mute landed
   up to 115 ms late no matter how good the timing was (20.6 % of the word still
   audible). `GATE_RESOLUTION = 'asetnsamples=n=128:p=0'` is prepended to every
   audio graph in `buildAudioFilter`. Measured after: 0.8 %.

**How this is verified.** `tests/integration/profanityTiming.test.ts`, 8 cases
(mid-sentence, at the start, at the end, -ing, -ed, compound, words spoken close
together, rapid speech). Each runs the *real* pipeline and then measures energy
in the *real* output file: the target word must drop below 15 % and every
neighbour must stay above 70 %. Gated because it needs a whisper binary:

```
RUN_ASR=1 WHISPER_BIN=/path/to/whisper-cli WHISPER_MODEL=/path/ggml-base.en.bin \
  npx vitest run tests/integration/profanityTiming.test.ts
```

Re-transcribing the output was tried as an oracle and **rejected**: a small
model reconstructs the expected word from context even when it is fully muted.

### Watermarks

Images may be PNG, WebP, GIF or JPEG, and **alpha is preserved end to end** —
the overlay filter starts with `format=rgba` so opacity and rotation both have
an alpha channel to work on, and `rotate` fills with `c=none`. A transparent
logo arrives transparent.
`tests/integration/watermark.test.ts` holds that: one case uses a green disc on
a fully transparent background and asserts the disc's centre is the logo while
the corners of its bounding box are still the picture underneath. An opaque
test rectangle cannot catch this — it passes every position assertion while
arriving as a visible green *box*.

`src/shared/watermark.ts` is the model (9 anchors, normalised transform,
`resolveWatermark`, `sanitizeWatermark`); `src/main/media/watermarkFilter.ts`
emits the FFmpeg geometry; `src/main/services/watermarks.ts` owns the image
library (images are copied into app data so moving the original cannot break an
export). Precedence is **VOD override → streamer default → nothing**, resolved
in one place. Editing a VOD never writes the streamer default — that needs the
explicit "Save as … default" action, and the editor says so.

### In progress / open
1. YouTube preview path is verified locally (probe → classify → remux/transcode
   a range) but **never tested against a real YouTube VOD** — this sandbox
   cannot reach YouTube.
2. Separation jobs do not resume after an app crash mid-run; they re-run (the
   cache means completed regions are not redone).
3. Show All has no dedicated focus layout beyond promoting the clicked angle.

---

## 3. Files being touched (exact paths)

### Shared (pure logic, imported by both processes; tests import these)
```
src/shared/types.ts          domain model: ClipSegment, VodSource, AppSettings, ProjectFile(schemaVersion 4)
src/shared/ipc.ts            IPC channel names + every request/reply type + RendererApi
src/shared/audioEdits.ts     AudioEdit model + buildAudioFilter() (mute/bleep/duck) + GATE_RESOLUTION + carryDecisions()
src/shared/audioReview.ts    clip × POV rows, sorting, filtering, approvedEditsForExport()
src/shared/profanity.ts      DEFAULT_PROFANITY (strong only), MILD_PROFANITY, vocabularyFor(), detectProfanity(),
                             severityFor(), contextAround()
src/shared/profanityTiming.ts  envelope → voiced runs → segmental DP alignment → padWord. READ THE HEADER COMMENT
src/shared/watermark.ts      anchors, normalised transform, resolveWatermark(), streamerFor(), sanitizeWatermark()
src/shared/eventStreams.ts   coverageOf(), streamsCoveringEvent() — the overlap rule, on the wall clock
src/shared/compat.ts         classifyPreview(): native | remux | transcode | unsupported
src/shared/multiPov.ts       followerTargets(), columnsFor() — Show All maths
src/shared/povMapping.ts     clipRangeInPov(), planExport(), coverage states
src/shared/sync.ts           VodTimeMapping, localToEvent/eventToLocal, confidence
src/shared/filenames.ts      applyTemplate/buildFolderSegments/sanitizeFilename
src/shared/defaults.ts       DEFAULT_* + mergeSettings() ← add new settings keys to the pick lists or they silently vanish
src/shared/errors.ts         AppError catalogue — every user-facing message
```

### Main process
```
src/main/index.ts                    wiring, IPC handlers, autoInstallMissing(), installTools()
src/main/media/exporter.ts           exportClip(), buildCutArgs() (filterLeadIn shift, watermark input)
src/main/media/watermarkFilter.ts    overlay/scale/rotate geometry from real ffprobe frame size
src/main/media/audioPreview.ts       before/after renders through the export graph
src/main/media/analyzeClip.ts        profanity analysis for one clip × POV (envelope + alignment + padding)
src/main/media/transcribe.ts         whisper.cpp; whisperBinaryNames(), parseWhisperJson()
src/main/media/previewMedia.ts       playable preview assets for undecodable ranges
src/main/media/rangeFetcher.ts       HLS segment / HTTP-range window fetching
src/main/services/deps.ts            ToolInstaller: catalogue, checksums, safe extraction, hasAll()
src/main/services/watermarks.ts      image library: copies images into app data, reads intrinsic size
src/main/services/locate.ts          executable discovery; setManagedToolsDir(); isFile() guard
src/main/services/queue.ts           export queue
src/main/localServer.ts              loopback server: renderer, /media proxy, /preview, /local?id=, /watermark/<name>
```

### Design system (new — read this before touching any component)
```
src/shared/status.ts                      the ONE status vocabulary: Ready | Loading | Processing |
                                          Needs review | Approved | Complete | Failed | Unavailable,
                                          each with a tone AND a glyph so colour is never the only signal
src/renderer/src/design/tokens.css        the only file allowed to contain a colour literal.
                                          Semantic names only; light and dark authored separately
src/renderer/src/ui/ui.css                every control's styling. No page stylesheet may restyle a .ui-* class
src/renderer/src/ui/index.ts              the barrel every page imports from
src/renderer/src/ui/{Button,IconButton,Icon,Select,Menu,Dialog,Tooltip,Input,TimeInput,
                     SearchInput,PageHeader,Status,Feedback,useTheme}.tsx
```

### Renderer
```
src/renderer/src/App.tsx                  shell, page switch, export actions, player selection
src/renderer/src/store.ts                 Zustand store (page, audioFocus, clips, playback, toolProgress)
src/renderer/src/styles.css               ALL styling lives here today (~1.7k lines) ← the UI work starts by splitting this
src/renderer/src/components/AudioPage.tsx        one row per profanity finding: filters, POV filter, scoped bulk actions
src/renderer/src/components/WatermarkEditor.tsx  drag/resize/rotate on a 16:9 stage; precedence notice; save targets
src/renderer/src/components/WatermarkOverlay.tsx live preview over the player
src/renderer/src/watermarkUrl.ts                 relative /watermark/<name> URL (see failure #26)
src/renderer/src/components/PropertiesPage.tsx   clip facts + POV table
src/renderer/src/components/ExportPage.tsx       pre-export summary + queue
src/renderer/src/components/PovGrid.tsx          Show All grid
src/renderer/src/components/ClipTimeline.tsx     per-POV lanes + audio regions
src/renderer/src/components/SetupPanel.tsx       Settings → Tools
src/renderer/src/components/SettingsDialog.tsx   settings shell
src/renderer/src/components/{ClipList,MarkerPanel,QualityPanel,QueuePanel,PovBar,PovMatrix,Properties,StreamersDialog,Timeline,Toasts,Transport,WaveformSync,FindInPovs,QuickGuide}.tsx
                                          (AudioPanel.tsx was deleted — dead, superseded by AudioPage,
                                           and it had not compiled since the per-POV audio model landed)
src/renderer/src/player/{HlsPlayer.tsx,FollowerVideo.tsx,controller.ts,sources.ts,diagnose.ts}
```

### Build / packaging
```
package.json            scripts: dev build test typecheck tools tools:win package:win package:dir
electron-builder.yml    ships resources/bin as extraResources
scripts/fetch-tools.ts  downloads + verifies tools into resources/bin (--platform win32 works from Linux)
resources/bin/          gitignored; filled by `npm run tools`
```

### Commands
```
npm ci && npm run build && npm test          # 428 tests, ~3 min — Bash tool needs timeout: 900000
npm run tools:win                            # assemble Windows tools from any host
RUN_ASR=1 WHISPER_BIN=… WHISPER_MODEL=… npx vitest run tests/integration/profanityTiming.test.ts
                                             # the 8 ground-truth word-timing tests, ~60 s
```

### Live UI run in this sandbox (how every screenshot was taken)
```
Xvfb :99 -screen 0 1600x1000x24 &
env -i DISPLAY=:99 HOME=/tmp/h PATH=/usr/bin:/bin \
  node_modules/electron/dist/electron --no-sandbox out/main/index.js /tmp/demo.cookieclip &
DISPLAY=:99 import -window root /tmp/shot.png     # then Read the png
DISPLAY=:99 xdotool mousemove X Y click 1          # drive the UI
```
`/tmp/demo.cookieclip` is a hand-written project (6 POVs, 5 clips, seeded audio
findings) used to exercise pages without real VODs. Regenerate it with the
python snippet pattern: sources with `syncMapping.vodStartRealTime` offsets,
clips with `eventStartTime`, `audioEdits[]` carrying `povId`.

---

## 4. What has been tried and failed — and why

Do not repeat these.

1. **yt-dlp `--no-call-home`** — removed upstream; every resolve failed. Flag deleted.
2. **Kick via yt-dlp** — 403/404 without curl-cffi impersonation. Fixed by
   reading the UUIDv7 timestamp out of the Kick VOD link and matching it against
   `api/v2/channels/<slug>/videos` through Electron's `net.fetch` (Chromium
   stack), not Node fetch.
3. **Node `fetch` in the main process** — undici ignores system proxy settings
   and the OS certificate store; downloads failed behind proxies and in this
   sandbox. All installer downloads now go through `net.fetch`.
4. **`import demucs` as the readiness check** — succeeds without numpy, then the
   model dies on first run ("Ready" but broken; the user hit this). Now the
   probe imports `demucs.separate` *and* the installer runs a real test
   inference before anything is called ready.
5. **Letting the system Python win** — picked up the user's `C:\Python314`,
   which has no demucs and no PyTorch wheels. Now candidates are *probed* and
   the app's own runtime is used unless a system one genuinely works.
6. **`access(X_OK)` as an executable test** — a *directory* passes it, so
   `tools/python` (a folder) got spawned → EACCES, taking detection down. Now
   `stat().isFile()` too.
7. **whisper lookup with bare names** — `whisper-cli` instead of
   `whisper-cli.exe`; found nothing on Windows right after installing it.
   Everything goes through `executableNames()` now.
8. **whisper keep-list `ggml-cpu.dll`** — current releases ship one backend DLL
   per instruction set (`ggml-cpu-haswell.dll`, …). Copying only the named files
   produced `GGML_ASSERT(device) failed`. Keep-list is now `ggml*.dll` and
   wildcards are supported.
9. **`--only-binary :all:` fear** — it is fine; demucs 4.1.0 has wheels for
   everything. But `numpy` and `soundfile` must be installed explicitly: demucs
   does not declare numpy and current PyTorch no longer pulls it in.
10. **`<file>.partial` staging name** — FFmpeg picks its muxer from the
    extension and refused to write. Staging files must keep the real extension
    (`<id>.partial.mp4`).
11. **`hidden` attribute on a flex container** — `display:flex` beats
    `[hidden]`; the page never hid. `[hidden]{display:none!important}` added.
12. **Audio filter times** — FFmpeg filters run on the *decoded* timeline, which
    includes the pre-roll (precise mode) or keyframe lead-in (copy mode). Edits
    are clip-relative, so they land early unless shifted by `filterLeadIn` in
    `buildCutArgs`.
13. **FFmpeg `sine` source for bleeps** — measured ≈ −21 dBFS, inaudible under
    speech. Replaced with `aevalsrc=0.3*sin(2*PI*1000*t)`.
14. **`sampleFrequency()` test helper for a 1 kHz bleep** — it only Goertzels the
    fixture's twelve tones, so it can never report 1 kHz. Use the
    `bandEnergyDb()` bandpass helper in `tests/integration/audioEdits.test.ts`.
15. **Leetspeak normalisation** — `'Fuck!'` → `'fucki'` because `!`→`i` hit
    trailing punctuation. Trailing `[!*]` is stripped before substitution.
16. **`mergeSettings` pick lists** — new settings keys silently disappeared on
    reload (`folderTemplate`, `uncertainPaddingSeconds`). Every new key must be
    added to the pick list in `src/shared/defaults.ts`.
17. **`electron-builder --win` on Linux** — needs Wine; not available here.
    `--dir` for Linux works and was used to verify the packaged layout.
18. **Sandbox network** — `huggingface.co`, `gyan.dev` and `johnvansickle.com`
    are blocked here; GitHub, PyPI and PyTorch's index are not. A BtbN fallback
    was added for FFmpeg because of it. These are *sandbox* limits, not bugs.
19. **Bash tool timeouts** — the suite takes ~2.5 min; pass `timeout: 900000`.
20. **`pkill -f "out/main/index.js"`** — the pattern matches the tool's own
    shell and kills the session. Use `pkill -x electron`.
21. **Grid items default to `min-width: auto`** — the timeline canvas pushed
    `.main` wider than the window, so the side panel was clipped off the right
    edge. Every grid track that must be allowed to shrink says `min-width: 0`.
22. **`table.grid td.mono { text-align: right }`** — right-aligned the export
    page's *file path* column. Numbers are `.num` now; `.mono` only sets
    tabular figures.
23. **An empty queue dock is not free** — a permanent "Nothing exporting"
    panel under the timeline cost ~150px of picture. It renders as a single bar
    until there is a job in it.
24. **`Omit<InputHTMLAttributes, 'size'>`** — the DOM `size` attribute is a
    number, so a `size="compact"` prop on an input wrapper will not typecheck
    without omitting it first.
25. **Theme must be resolved in exactly one place.** `useTheme` sets
    `documentElement.dataset.theme` and nothing else reads `settings.ui.theme`
    for styling, which is why switching repaints every page at once instead of
    leaving a dialog in the old theme.
26. **A watermark image that never appears.** Three separate causes, all with
    the same symptom, all now fixed:
    - a `file://` URL is cross-origin to an http-served page and is blocked;
    - the page CSP had no plain `http:` in `img-src`, so even the loopback URL
      was refused — `img-src` now lists `http://localhost:* http://127.0.0.1:*`;
    - a *relative* `/watermark/<name>` works in a packaged build but **not
      under `npm run dev`**, where the page is served by Vite on a different
      port and the request never reaches the app's own server. `watermarkUrl.ts`
      builds the absolute loopback URL from `env.mediaProxyBase`.
27. **`main_w` is not valid inside `scale`.** "Expressions with scale2ref
    variables are not valid in scale filter". `watermarkFilter.ts` takes the
    real frame size from ffprobe and emits integer geometry.
28. **Re-transcribing an export to prove a word was muted.** A small model
    reconstructs the expected word from surrounding context and "hears" it even
    in silence. Measure **energy in the output file** instead.
29. **`t_dtw` is not a word start.** It is an end anchor lagged 30–300 ms.
    Assuming otherwise put every mute one word late.
30. **A naive nearest-anchor assignment** put every token one voiced run late,
    and a position-only cost let a short word steal a long word's run. The cost
    function needs a duration term (`DURATION_WEIGHT`).
31. **whisper returns nothing for audio under ~1 s.** Clips are padded to
    `MIN_TRANSCRIBE_SECONDS = 2.5` with `apad` and words in the padded region
    are filtered out afterwards.
32. **A watermark test that "detected" the logo every time.** The media fixture's
    chunk 4 is magenta `0xE000E0` — the same colour as the test logo. The logo
    is green now.
33. **A fixed `min-height` on the player** oversubscribed the vertical budget at
    1280×720: `.stage` overflowed and painted its transport bar over the
    timeline below. The picture is the only thing on that page that may yield —
    `min-height: 0`, and `.stage { overflow: hidden }` so nothing can escape
    again.
34. **A grid whose only row is `auto` sizes itself to the video's *intrinsic*
    height.** `.player-wrap` was `display: grid; place-items: center` with an
    implicit `auto` row, so a 1080p source laid out 1080px tall and the wrap
    scrolled — the picture was genuinely cut off on a short window. The tracks
    are explicit now (`grid-template: minmax(0, 1fr) / minmax(0, 1fr)`) and the
    wrap is `overflow: hidden`, so the video letterboxes to fit at any size.
    The same `minmax(0, …)` treatment applies to `.pov-tiles` rows in Show All.
35. **A remove button at `opacity: 0` until hover does not exist.** Removing a
    POV was implemented and tested from the first day and the user still asked
    for the feature, because nothing on screen said it was there. It sits at
    `opacity: 0.55` now and brightens on hover.

---

## 5. What to do next — ordered

### Phase A — UI/UX modernisation: DONE

Delivered and verified on 2026-08-18. The whole application runs on one design
system; the definition-of-done checklist in the user's brief is met. Verified
by running the packaged build under Xvfb at **1280×720, 1600×1000 and
2560×1440**, in **both themes**, exercising the nav, every page, the Select
popup, the Project menu, a clip context menu and a confirmation dialog; and by
the full suite (**406 pass, 1 skipped** — unchanged from before the work).

One test was updated deliberately: `tests/unit/queue.test.ts` asserted on the
literal string `'Download failed'`. It now asserts on `error.code` plus
`Errors.downloadFailed().title`, because the wording is a presentation decision
the design system owns and the code is the contract the queue actually makes.

If more UI work is wanted, these are the honest remaining gaps — none of them
block anything:

1. **Resizable panels** (brief §41). Not implemented. The side panel, the
   audio table/detail split and the timeline are fixed proportions with
   responsive breakpoints. Adding drag handles means persisting sizes in
   `AppSettings.ui` (remember failure #16 — add the key to the pick list).
2. **Skeleton loading states** exist as a component (`ui/Feedback.tsx`) but are
   only used in a couple of places; most slow paths use `Spinner` or a
   `ProgressBar`.
3. **The audio table repeats the clip name once per POV** (5 clips × 6 POVs =
   30 rows). Grouping rows by clip would free real width, but changes how
   sorting works — worth doing only if the user finds the repetition annoying.
4. **The native `datetime-local`** in the streamer "who was live at" search is
   the one browser-default control left. It is deliberate: a hand-built
   date-time picker would be worse than the OS one. It is styled as `.ui-input`.

### Phase B — production pass (multi-POV, music removal, profanity, watermarks): DONE

Delivered 2026-08-19. Every clause of the brief is implemented and exercised;
§2.1 says how each part works and how it was proved. Verified by the full suite
(**427 pass**), the gated ground-truth timing suite (**8/8**), a clean
`npm run build`, and by running the built app under Xvfb at **1280×720** and
**2560×1440** in **both themes** — the watermark editor and live overlay, the
Audio review page, the streamers panel and the per-POV clip timeline.

Two real bugs were found by looking at it on screen and are fixed: failure #33
(the transport bar overlapping the timeline at 720p) and the findings list
floating in the middle of a 2560px window instead of sitting under its own
header.

### Phase B.1 — resizing, 2026-08-19

The window minimum is **560×380** (was 1100×700) and the layout narrows in a
fixed order of sacrifice: timeline height, then side-panel width, then topbar
decoration — never the picture. The picture always *scales*; it is never
cropped.

Verified with a real 1920×1080 video against the built stylesheet at 1280×720,
900×600 and 640×420: the `<video>` box equals its container exactly at every
size, `scrollHeight - clientHeight` and `scrollWidth - clientWidth` are both
**0**, and the whole frame is visible letterboxed. Method:

```
# build first, then point a page at out/renderer/assets/*.css with the
# .main / .stage / .player-wrap / .timeline-stack structure and a real video
node /tmp/vt/shot.mjs      # playwright, three viewports, prints the box metrics
```

Show All gets its own treatment: `.main.all-povs` drops the timeline to 20vh,
and the tile strip's rows are `minmax(0, 1fr)` so tiles shrink with the window
instead of keeping a 16:9 box and being clipped by the strip.

### Phase C — smaller open items
5. Test the YouTube preview path against a real VOD on the user's machine
   (`previewMedia.ensure` → `/local?id=`), since this sandbox cannot.
6. The **overlap discovery** in the Streamers panel is covered by
   `tests/unit/eventStreams.test.ts` and its UI states were seen on screen, but
   the live path (real channels → real VOD lists → real overlaps) has never run,
   because this sandbox cannot reach Twitch or Kick. Run it once on Windows.
7. Show All: a real focus layout (large + strip) rather than promoting the
   clicked angle into the main player.
8. Consider bundling `resources/bin` in the delivered zip for users who cannot
   run `npm run tools` (today it is gitignored and fetched).
9. The watermark editor now warns when a config points at an image that is no
   longer in the library. Nothing yet **repairs** it in bulk if a user clears
   the folder — they re-pick per VOD.

### Always
- The user holds the source at `C:\\Cookie-Clipper` and builds on Windows.
  Changes can be written straight into that folder over the device bridge —
  faster than shipping a zip they have to unpack.
- **Never add a colour, spacing value or radius outside `design/tokens.css`,
  and never build a control that `ui/` already provides.** The consistency is
  enforced by there being exactly one implementation of each thing, not by
  anybody remembering.
- Update `claude/implementation-status.md` and `claude/what-the-app-does.md` in
  the attached Claude Project when behaviour changes.
- **Detection is always a proposal.** Nothing is muted, bleeped or ducked until
  the editor approves it, and no bulk action runs without first naming the scope
  and the count it is about to change.
- Never claim something works without running it and reporting what you saw.
