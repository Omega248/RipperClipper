# Ripper Clipper — What It Does

*A working reference to the current source (package.json v1.5.0), written by reading the code, not just the docs. Where this disagrees with README.md or plans/HANDOFF.md, that's called out explicitly — both of those had drifted from what's actually built.*

---

## 1. The idea

Ripper Clipper is a Windows desktop app (Electron + React + TypeScript) for cutting the same real-world moment out of several people's livestream VODs at once — the NoPixel GTA-RP workflow, where one in-game event (a heist, a chase, a shootout) is broadcast simultaneously by five to ten streamers across Twitch, Kick and YouTube, each from their own camera, on their own clock, sometimes not recording at all.

The alternative it replaces: download every giant VOD in full, import each into an NLE, hunt for the same moment in each one by eye, cut, export. Ripper Clipper's whole design is built to avoid that — it never downloads a VOD in full, only the segments a selection actually covers, and it treats "the same moment, from another angle" as something the app derives automatically rather than something the editor re-finds by hand.

The one architectural idea everything else sits on: **a clip's canonical range is a real-world time window, not a timestamp borrowed from whichever POV it was marked in.** Mark a moment once, in any loaded POV, and every other POV's local range for that same clip is *derived* from its own independent sync mapping to the event clock. That's what makes two things possible without any extra work: creating a clip while watching POV A produces correctly-offset ranges for POV B and POV C in the same action, and loading POV D a week later automatically evaluates it against every clip that already exists — covering some fully, some partially, correctly reporting others as out of range — without anything being recreated.

---

## 2. Current capabilities

### 2.1 Getting footage into a project

- **Three platforms behind one adapter** (`PlatformAdapter` in `src/main/platforms/`): Twitch, Kick, YouTube. The editor never sees platform-specific code — everything platform-shaped lives behind the adapter interface.
- **Twitch & YouTube** are resolved through yt-dlp for metadata and stream manifests.
- **Kick is not resolved through yt-dlp.** Its bot protection is handled directly: the UUIDv7 timestamp embedded in a modern Kick VOD link is decoded and matched against the channel's own video list through Electron's own network stack (`net.fetch`), which avoids needing yt-dlp's browser-impersonation extra entirely.
- **Pasting a link that's already in the project** switches to the POV already loaded instead of adding a duplicate.
- **The streamer library** remembers every channel a POV has ever been loaded from, browses their past broadcasts, and looks channels up by date/time. Saved streamers can be sorted into named, coloured, iconed **groups** (PD, a gang, EMS, …) — `StreamerGroupsDialog` — and filtered by group, so finding "everyone who might have been on one side of this" doesn't depend on remembering who currently plays for it.
- **Streamer profiles** (`src/main/services/streamerProfile.ts`) fetch each channel's real display name and avatar from the platform's public profile data, so the library shows faces instead of raw handles — read-only, fails soft to the handle if it can't be fetched.
- **Event Discovery** (`EventDiscovery.tsx` / `src/shared/discovery.ts`): give it a real-world moment and it sweeps every reachable platform source (the streamer library, plus keyword/category search where a platform exposes one) for broadcasts that overlap that moment on the wall clock, and is explicit about what it *couldn't* reach — Twitch and Kick expose no public search over past broadcasts, so those are only found through the streamer library, and the UI says so rather than implying a complete sweep.
- **Clip-link resolution** (`src/shared/clipLink.ts`): starting from a Twitch/Kick clip link, a VOD link with `?t=`, or a YouTube link with `&t=` — the way most people actually learn a scene happened, via a link shared in Discord — resolves to a real-world instant that every POV is then matched against, rather than requiring the editor to already know the wall-clock time.

### 2.2 Synchronising POVs to one clock

- Automatic where a platform's own start-time metadata is reliable, corroborated by **automatic audio cross-correlation** between POVs once more than one is loaded (`src/renderer/src/sync/audioCrossCheck.ts` — matches a 30-second probe window against a reference POV's already-synced timing).
- **Cold-start sync** (`src/renderer/src/sync/coldStartSync.ts`) handles a POV with no usable timing at all: it takes several short probes spread across an already-synced reference and searches the *entire* untimed target for each one, turning confident hits into sync anchors through the same weighted least-squares solver every other anchor source uses.
- **Manual waveform alignment** is available per VOD and per clip for anything that still needs a human eye.
- Each POV shows its own **sync confidence**, with a one-click re-validate action at any time.
- The mapping itself (`src/shared/sync.ts`) is `eventTime = vodStartRealTime + localTime + offset + drift × localTime` — never assumed to match another POV's mapping.

### 2.3 Watching & marking clips

- One native, in-app player for all three platforms (HLS/progressive, routed through the app's own loopback proxy so playback is always same-origin) — YouTube's own embedded IFrame player is never used.
- **Show All**: a synchronised multi-POV grid, watching every loaded angle at once.
- Two kinds of timeline: the **event timeline** (the real-world moment) and each POV's own **local timeline**. Zoomable, pannable, shows clip boundaries, markers, an adaptive time scale.
- Full mouse and keyboard model for marking: click/drag to seek, Shift+drag to select, drag a clip edge to trim, drag a clip body to move it, wheel to zoom, Shift+wheel to pan. Keyboard shortcuts for play/pause, seek, mark in/out, add clip, delete, next/previous clip, add marker, "find this moment in every loaded POV", loop, zoom, undo/redo — all rebindable in Settings → Keyboard, and none of them fire while typing in a field.
- **Markers** on the event timeline independent of clips, for flagging a moment without committing to a range yet.

### 2.4 The app shell — navigation ("Shell V2")

This is the single biggest thing that's changed since the README was last written, and it's worth describing on its own. The app used to be a tab strip (Video/Properties/Export) sitting directly on top of whatever project was open, with nowhere to stand when no project was open at all. It's now a **permanent left rail** (`AppRail.tsx`) that is the *only* navigation surface, in two zones:

**Library zone** (exists whether or not a project is open):
- **Backlog** — the actual landing page now. Not a "continue working" card with four recent clips; it's the work queue itself, ordered by the one deadline the app has to respect (Twitch deletes VODs after roughly two weeks): clips at risk of losing footage, clips cut but not yet exported, and failed jobs, each a real queue you can enter and advance through, each band showing a real total rather than the length of what's rendered.
- **Events** — the classic project launcher: open an existing project, start a new one, jump into a recent one.
- **Streamers** — the streamer library as its own page, with group chips across the top for one-click filtering.
- **VODs** — every loaded source across the project, sortable/searchable, leading with sync state and time-to-expiry rather than upload date, because expiry is the actionable fact.

**Event zone** (only present once a project is open):
- **Watch** (the old "Video" page) — player, POV bar, timelines, sync controls, clipping.
- **Clips** — every clip in the event, with **collections** (named folders like "Bank Robbery" or "Chase" — filing only, never affects sync or export) and a **workflow state** per clip (`found → reviewed → povs-collected → ready-for-edit → in-edit → exported`) for a glanceable sense of what still needs work.
- **Export** — the export queue and pre-export summary.
- **Settings** — the same controls as the Settings dialog, reachable as a full page for anyone who wants to sit in them rather than pop them open over their work.

`Properties` still exists as a tab inside the workspace area, alongside Watch/Editor/Export, rather than as its own rail destination.

Two more navigation aids sit on top of the rail: a **command palette** (Ctrl+K) that searches every clip and every dialog-opening action in one box, and an **event search** dialog that searches clips, POVs, collections and markers together — because "find the bank thing" shouldn't require first deciding what kind of thing it is.

### 2.5 Organising clips

- **Collections**: named groupings inside an event. Deleting a collection keeps its clips (they fall back to "loose"); moving a clip between collections changes nothing about its timing or export. Filing is explicitly presentation, never truth.
- **Workflow states**: `found`, `reviewed`, `povs-collected`, `ready-for-edit`, `in-edit`, `exported` — a small linear ladder, not a general workflow engine, meant to answer "what still needs work" at a glance.
- **Tags** on clips, colour-coded by a hash of the tag text so the same tag always renders the same colour without a colour picker.
- **Contact-sheet thumbnails**: a clip's frame from every angle that covers it, not just one POV's frame — because a single frame from a single POV is often the least recognisable version of a moment (it might be pointed at a wall).
- **Review runs** (`ReviewRunStrip.tsx`): a queued, keyboard-driven loop for working through a batch of moments — mark in/out, pick an angle, queue it, move to the next — without the player rebuilding between clips.
- **A clip list export to CSV** (`src/shared/clipListCsv.ts`) for tracking exports outside the app or handing a shot list to someone who isn't running it.

### 2.6 Per-POV audio editing

Two distinct but connected pieces:

- **Hand-drawn edits**: mute, bleep, or duck (turn down without silencing) any range of a clip's audio, per POV, drawn directly on a waveform. An edit is an instruction stored on the clip, applied only when a file is actually written — never a change to the source — so undoing one costs nothing, and it's scoped to one clip's one POV without touching any other clip or angle.
- **Automatic profanity review** (`CensorPanel.tsx`, `src/main/services/censor.ts`, `src/shared/profanity.ts`): every covering POV is transcribed (via whisper.cpp, downloaded on demand as a separate, optional speech model — up to ~488MB, so it isn't bundled for people who'll never use it) and scanned for a configurable strong/mild profanity vocabulary. Every hit is a *proposal*, never an automatic silence — it's reviewed, accepted, dismissed, or nudged by hand, and accepting one simply writes an ordinary hand-drawn `AudioEdit`, so from that point on there's no separate "censor" pipeline to keep in sync with the waveform editor or the exporter.

**This directly contradicts README.md**, which states profanity detection "has since been removed entirely" alongside music detection. That's true for music: `src/shared/musicDetect.ts` still exists on disk but is dead code, imported nowhere. It is **not** true for profanity — `CensorPanel` is actively wired into both the Clips page and the Properties panel, and it's a substantial, working feature (word-level timing correction via a segmental alignment algorithm is described in detail in `plans/HANDOFF.md` §2.1, including the fixes for whisper's lagged end-anchor timestamps and FFmpeg's per-frame volume-gate delay). The README needs a correction here, not the feature.

### 2.7 Watermarking

- Per-VOD watermark configuration with a streamer-level default; overriding a VOD's watermark never changes the streamer's default (an explicit "Save as … default" action is required for that).
- A visual drag/resize/rotate editor on a 16:9 stage, 9 anchor points, a normalised (resolution-independent) transform.
- PNG/WebP/GIF/JPEG, with alpha preserved end to end — a transparent logo arrives transparent, verified by a test that specifically checks a logo's corners stay see-through rather than just checking its centre lands in the right place.
- Live preview over the player uses the same transform math as the actual export filter, so what's positioned is what gets written.
- Applied per POV, at export time only.

### 2.8 The multi-track Editor — dev/experimental only

Beyond the single-clip-per-POV export model, there's a genuine multi-track sequence editor, gated entirely out of the `stable` build (`__EDITOR_ENABLED__`, replaced at build time so a stable build's compiled output doesn't contain the module graph at all, not just a hidden button):

- **Media Library** (`MediaLibrary.tsx`): every clip broken out by the POVs that cover it — a clip and "that clip as seen from POV B" are different drag sources, since the same moment can be placed on the timeline once per angle.
- **Timeline Editor** (`TimelineEditor.tsx`): drag POVs onto as many video/audio tracks as needed, trim, split, delete, snap. Every placed item references a range of a POV's own VOD time, so moving or trimming it on the sequence never touches the original clip.
- **Inspector** (`Inspector.tsx`): per-item properties — including a picture-in-picture transform (position/scale/rotation) for compositing one POV as an inset over another, rendered through the same FFmpeg technique as the watermark filter (`src/main/media/pipFilter.ts`, `transformFilter.ts`).
- **Prepare for Editor** (`PrepareForEditor.tsx`): shows the plan — which clips can be brought in and which can't, with the reason, and which are only partially covered — *before* building anything, rather than discovering half-way through assembly that one POV was never aligned.
- **Scene detection** (`src/main/media/sceneDetection.ts`): picture-cut timestamps (not just audio cuts) for the marking UI, fetched only for the requested window, same caching discipline as everything else.

### 2.9 Export pipeline

- Range-only fetch: HLS parses `#EXTINF` and downloads only the covering segments; HTTP sources use FFmpeg byte-range seeks. Segments are cached by URL, so overlapping clips across POVs and events share downloaded media instead of re-fetching it. The cache is size-capped and LRU-pruned — it can't quietly fill a disk — and clearable from Settings → Storage.
- **Three cutting modes**: Smart (default — stream-copies when the start lands within keyframe tolerance, re-encodes for a frame-accurate cut otherwise, and always says which happened), Stream copy (never re-encodes, reports drift honestly), Frame accurate (always re-encodes at the best available hardware encoder — NVENC/Quick Sync/AMF/VideoToolbox/VA-API — falling back to software).
- Hardware encoders are **smoke-tested at startup** by actually encoding a frame, so a GPU encoder that would fail mid-export is never selected, with automatic runtime fallback to software if a GPU encode still fails. AV1 sources only export as AV1 when hardware AV1 encoding genuinely works; otherwise HEVC rather than slow software AV1.
- Video and audio can be sourced from **different POVs** for the same exported clip.
- Filename templates (`{Name}`, `{VODTitle}`, `{Creator}`, `{Platform}`, `{Date}`, `{Index}`, `{Start}`, `{End}`, `{Duration}`), sanitised, never overwriting — collisions become `Name (2).mp4`.
- Export queue with pause/retry/cancel; a failure keeps every other job's result.
- ffprobe verification after every export: streams, duration, A/V skew.

### 2.10 Projects & data safety

- `.cookieclip` project files store every source, streamer, clip, POV mapping, sync anchor and watermark config — never the media itself.
- Atomic saves (a crash or power loss can't corrupt a project), autosave recovery offered on next launch, and a rolling history of up to 10 previous saves with one-click restore (`VersionHistoryDialog.tsx`).
- **Portable packages** (`.ripperpack`, `src/shared/packaging.ts`): a versioned JSON export of the *work* — clips, sync anchors, watermark config, collections, event info — deliberately never the media (every source already carries the URL it came from, so a package re-resolves on the receiving machine to the same state for a few kilobytes). Optionally notes the paths of already-exported files. Forward-compatible: an older package still opens after the schema moves on.

### 2.11 Look, feel, and consistency

- One design system: `design/tokens.css` is the only file allowed to contain a colour literal; `ui/` holds exactly one implementation each of Button, IconButton, Select, Menu, Dialog, Tooltip, Input family, PageHeader, Status/Badge, and the feedback set (ProgressBar, Spinner, Skeleton, EmptyState, ErrorState, Notice) — no page is allowed to restyle a `.ui-*` class or roll its own control.
- `system | light | dark` theming, separately authored light and dark palettes, resolved in exactly one place (`useTheme`).
- The layout has an explicit, deliberate order of sacrifice as the window shrinks — timeline height, then side-panel width, then chrome — and the video picture itself is never cropped, only scaled, down to a 560×380 minimum window.
- Machinery (FFmpeg, yt-dlp, whisper.cpp) is invisible in normal use; it only surfaces in Settings → Diagnostics or behind an error's "Show technical details".

### 2.12 Self-setup, security, tooling

- FFmpeg, FFprobe, yt-dlp and whisper.cpp + a chosen speech model are fetched from their publishers, checksum-verified, and kept in the app's own folder — nothing is installed by hand, and Settings → Setup/Diagnostics shows exactly what's present and where it came from.
- Discovery order for each tool: an explicit path set in Settings → Diagnostics, tools the app downloaded itself, `resources/bin` next to a packaged build, then the system PATH and common install locations.
- Every external process launches with an explicit argument array and `shell: false` — no string-concatenated commands anywhere.
- The renderer has no filesystem, network, or process primitives; it only has the small typed IPC surface in `src/shared/ipc.ts`.
- Logs redact tokens, cookies, client secrets and signed query parameters.
- No DRM circumvention, no access-control bypass — only media the signed-in user is authorised to reach.

### 2.13 Testing

65 test files across `tests/unit` and `tests/integration`. The integration suite builds real HLS/HTTP-range media fixtures (a distinct colour and audio tone per 10-second chunk) and exports from them, then checks the produced files for the *actual right content* — correct frame colours, correct audio tones, correct POV — rather than just asserting a file of roughly the right length appeared. A full end-to-end workflow test creates named ranges, reorders them, saves, reopens, exports, and verifies, writing an ffprobe report for every produced file.

---

## 3. What's intended but not finished

### 3.1 Open items named directly in the source ("Shell V2")

Three explicit `TODO(SHELL-V2 §…)` comments mark unfinished pieces of the navigation redesign described in §2.4 above — they reference a numbered design brief that isn't in this repository (it's referenced throughout the code as "the design," e.g. §0 through at least §23, covering collections, workflow, contact sheets, participation tracking, the multi-track Editor, portable packaging, and more — evidently a living spec kept outside the repo, likely in the "attached Claude Project" `plans/HANDOFF.md` mentions):

- **AppRail's failure count and the Backlog page are scoped to the currently open project.** The design wants both to be library-wide — every project's at-risk footage, not just the open one's — which needs a `ProjectSummary` type carrying each project's soonest-expiring source, and a summaries IPC call, neither of which exists yet.
- **VODs page's planned "In this event" vs. library-wide scope switch** needs that same `ProjectSummary` work before it can be built.

### 3.2 Items HANDOFF.md itself calls open (as of its most recent revision)

`plans/HANDOFF.md` is a development handoff document, not a public changelog, and parts of it are already stale — most notably its description of the audio/profanity feature set no longer matches the current file layout (`AudioPage.tsx` → now `CensorPanel.tsx`; `analyzeClip.ts` → now `clipAnalysis.ts`). Treat its narrative sections as history rather than a current status report. Its still-relevant open items:

- **The YouTube preview path has never been exercised against a real YouTube VOD** — verified locally against synthetic fixtures, but the sandbox it was built in can't reach YouTube.
- **The live "who was live at this time" cross-platform sweep** (Event Discovery talking to real Twitch/Kick channel data) is covered by unit tests and was seen working against mocked/UI states, but the real network path has apparently never been run end-to-end either, for the same reason.
- **Resizable panels** (a design brief item) are not implemented — panel proportions are fixed with responsive breakpoints, not drag handles.
- **`resources/bin` is gitignored and fetched on demand** rather than bundled in the distributed installer/zip — worth reconsidering for users who can't run `npm run tools` themselves.
- **A watermark config pointing at a deleted library image** is detected and warned about, but nothing repairs it in bulk — a user has to re-pick the image per VOD by hand.

### 3.3 Deliberately not built

- **Editor is dev/experimental-only by design**, not an oversight — the multi-track sequence editor, PiP compositing, and everything that depends on them are compiled out of the `stable` public build entirely.
- **No automatic detection review queue beyond profanity.** Music detection/removal was built, then deleted in full on purpose (not hidden — the separator, the AI-runtime installer, the settings, the UI are all gone). There's no plan visible in the source to bring it back.
- **No project-wide resolution/canvas concept yet** for the PiP transform system — a timeline item's transform is always relative to the clip's own native frame size, not an independent project resolution.

---

## 4. A note on the documentation itself

Three sources describe this app, and they now disagree with each other in specific, checkable ways:

- **README.md** (public-facing) describes an earlier shape of the app: a three-page workspace (Video/Properties/Export, Editor in dev builds only) with no mention of the rail, Backlog, Events, Streamers-as-a-page, VODs-as-a-page, Clips-as-a-page, collections, workflow states, review runs, the command palette, event search, or portable packages — all of which exist and are wired up in the current source. It also states that profanity detection was removed; it wasn't (§2.6 above). Its latest-release badge (v1.1.0) is also well behind `package.json`'s current version (1.5.0).
- **plans/HANDOFF.md** is closer to current but is itself a snapshot from partway through the "production pass" and predates the Shell V2 navigation rebuild and the `censor.ts`/`CensorPanel.tsx` rename — treat its file-path references as directionally right but not always literally accurate, and its "Current state"/"In progress" sections as a checkpoint, not the present.
- **This document** is built by reading the actual current `src/` tree, so it should be the most reliable of the three as of the date at the top — but it's a snapshot too, and the codebase clearly moves fast. The most durable fix is what HANDOFF.md already tells its own future readers to do: update the status docs in the same change that changes behaviour, rather than let a fourth document start drifting the same way.

---

## 5. Architecture, briefly

```
src/
  shared/     domain model, event/POV sync math, collections & workflow state,
              audio-edit model, profanity model + timing correction, watermark
              model, discovery/search, packaging, timecodes, filenames, IPC contract
  main/
    platforms/  PlatformAdapter + Twitch / Kick / YouTube, adapter registry
    media/      ffmpeg, resolver, HLS/HTTP range fetch, Kick's direct API, exporter,
                watermark + PiP + transform filters, thumbnails, audio peaks,
                scene detection, transcription (whisper.cpp)
    services/   logger, settings, projects (rolling backups), cache, disk, export
                queue, streamer library + groups + profiles, watermark image
                library, censor service, whisper model downloads, discovery,
                external-tool location, auto-update
    localServer   serves the built renderer + the same-origin media proxy
  preload/    the only bridge to the renderer
  renderer/   React UI: app rail + routed pages (Backlog, Events, Streamers, VODs,
              Clips, Settings), the event workspace (Watch/Editor/Properties/Export),
              command palette, event search, streamer/watermark/version-history
              dialogs, the multi-track editor (dev-only)
```

The media engine has no dependency on the UI and is exercised directly by the integration tests. The editor never branches on platform — everything platform-specific lives behind `PlatformAdapter`. A clip's canonical range is always real-world event time; every POV's local range for it is derived, never independently stored as ground truth.
