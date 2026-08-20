# Ripper Clipper 🍪

A multi-POV VOD clipping workstation for **Twitch**, **Kick** and **YouTube** — built for cutting
the same real-world moment out of several streamers' broadcasts at once (the NoPixel GTA-RP
workflow: one event, five to ten people streaming it from different angles) without downloading
any VOD in full.

```
Event: a heist goes wrong, 21:15:30 real-world time
                                            │
        ┌───────────────┬───────────────┬──┴────────────┐
        ▼               ▼               ▼               ▼
   POV A (Twitch)   POV B (Kick)   POV C (YouTube)   POV D (Twitch)
   started 20:00     started 20:04:17  started 19:58:32  not recording
   clip → 01:15:30    clip → 01:11:13   clip → 01:16:58    (marked unavailable)
```

Watch any one POV, mark a moment once, and Ripper Clipper derives that same real-world range in
every other loaded POV automatically — each POV keeps its own independently-editable local range,
its own hand-drawn audio edits, and its own watermark. Add another POV to the project next week
and it backfills into every existing clip it covers, without anything being recreated.

**Latest release:** [v1.1.0](https://github.com/Omega248/RipperClipper/releases/latest) — Windows
installer, unsigned (see [Getting it running](#getting-it-running)).

---

## Getting it running

Nothing has to be installed by hand. Ripper Clipper fetches the programs it needs from their
publishers, checks each one against the checksum that publisher publishes, and keeps them inside
its own folder.

**If you just want to use it** — download the installer from the
[latest release](https://github.com/Omega248/RipperClipper/releases/latest) and run it. It's a
per-user install (no admin rights needed). The build is unsigned, so Windows SmartScreen will warn
on first run — click "More info" → "Run anyway". FFmpeg, FFprobe and yt-dlp are already inside
`resources/bin` next to the executable; Settings → Setup shows what's there and where each piece
came from.

**If you are building it yourself:**

```bash
npm ci               # dependencies
npm run tools        # download + verify FFmpeg and yt-dlp
npm start             # run it
```

`npm run tools` prints the sha256 of every file, says whether the publisher published a checksum
to check it against, and then runs each tool to prove it works. `npm run package:win` does the
same for Windows (from any host) and then builds the installer, so the result is self-contained.

| Tool | What it does | Where it comes from |
|------|--------------|---------------------|
| **FFmpeg + FFprobe** | cutting, muxing, watermarking, verification | gyan.dev release-essentials (Windows) or BtbN builds — both linked from ffmpeg.org |
| **yt-dlp** | stream manifests and metadata for all three platforms | its own GitHub releases, verified against `SHA2-256SUMS` |

Anything missing at startup is downloaded automatically (Settings → Setup has a toggle to stop
that). A tool already on your machine is used as it is — nothing is downloaded twice — and
Ripper Clipper looks in this order:

1. the path set in **Settings → Diagnostics**
2. tools it downloaded itself (`%APPDATA%\cookie-clipper\tools`) — so an updated yt-dlp wins
3. `resources/bin` next to the app — what a packaged build ships with
4. the system `PATH`, then common install locations (WinGet links, `C:\ffmpeg\bin`, `/usr/bin`, Homebrew)

Prefer to install them yourself? `winget install Gyan.FFmpeg` and `winget install yt-dlp.yt-dlp`
still work; Ripper Clipper will find them. The normal UI never shows dependency internals beyond
"ready" / "setting up" — Settings → Setup / Diagnostics has the technical detail for anyone who
wants it.

---

## Running it

```bash
npm install
npm run dev          # development, with hot reload — always has the Editor
npm run build        # typecheck + production build into out/
npm start             # run the production build
npm test              # full test suite (unit + real-media integration)
npm run tools         # fetch + verify this platform's tools into resources/bin
npm run tools:win     # …or Windows' tools, from any host
npm run package:win   # tools + build + Windows NSIS installer into release/
npm run package:dir   # tools + build + unpacked folder into release/
```

### Build channels

One `RIPPER_CHANNEL` environment variable picks which of three builds you get, dead-code-eliminated
at build time — a stable build never carries the Editor's code at all, not just a hidden one:

| Channel | What it is | Build | Package |
|---------|------------|-------|---------|
| **stable** (default) | the public release — no Editor | `npm run build` | `npm run package:win` |
| **experimental** | same code as `dev`, packaged like `stable` — try upcoming changes in a real install before they ship | `npm run build:experimental` | `npm run package:win:experimental` |
| **dev** | everything, including the Editor | `npm run build:dev` (or plain `npm run dev`) | `npm run package:win:dev` |

Each channel gets its own app identity and its own `userData` folder (`cookie-clipper-experimental`,
`cookie-clipper-dev`), so all three can be installed side by side without ever touching a real
project, cache, or setting from another channel.

---

## The workflow

```
Find a streamer's VOD                Streamer library
 (paste a link, or pick a       ←──── remembers every channel
  saved streamer's broadcast —        you've loaded a POV from
  a duplicate link switches to
  the POV already loaded)
        │
        ▼
Load every other POV covering the same event   ("Add POV" — or let the
        │                                        Streamers panel suggest
        ▼                                        who else was live)
Synchronise onto one real-world clock
 (platform start time → metadata → automatic audio cross-check between
  POVs → manual waveform alignment → confidence shown per POV, with a
  re-validate action any time)
        │
        ▼
Watch any one POV → mark IN/OUT → Add clip
        │
        ▼
Ripper Clipper derives that clip's range in every other covered POV
 automatically — full / partial / not-available coverage, per POV
        │
        ▼
Draw mute / bleep / duck edits directly on a clip's audio, per POV,
 on the Properties page — an edit takes effect the moment it's placed
        │
        ▼
Apply each VOD's watermark (streamer default, or a VOD-specific
 override) at export time only — the preview and export use the same
 transform, so what you position is what gets written
        │
        ▼
Export one POV, several, or all of them — each with its own video,
 its own audio edits, its own watermark
```

### Real-world event time, not copied timestamps

A clip's canonical range is a real-world time window, not a timestamp borrowed from whichever POV
it was authored in. Every other POV's local range for that clip is *derived* from its own
synchronisation mapping (`eventTime = vodStartRealTime + localTime + offset + drift × localTime`),
never assumed to match. This is what makes two things possible: creating one clip while watching
POV A produces correctly-offset ranges for POV B and POV C in the same action, and loading POV D a
week later automatically evaluates it against every existing clip — covering some, correctly
reporting others as out of range — without recreating anything.

### Every POV stays independent

Each POV owns its own synchronisation, its own watermark, and its own audio edits — muting a range
in POV A's cut of a clip never touches POV B's. Sound and picture for a clip can also be mixed
across POVs deliberately (cut the picture from one angle, the audio from another) without breaking
sync.

---

## How ingestion and export work

```
URL or saved streamer VOD
 ↓  platform adapter recognises the link and extracts the VOD id
Metadata resolution (yt-dlp, or Kick's own API directly — see below)
 ↓  title, creator, duration, thumbnail, stream start time
Preview            One native Ripper Clipper player for all three platforms — Twitch, Kick and
                   YouTube all play through the same in-app HLS/progressive player, fetched
                   through the app's own loopback proxy so playback is always same-origin.
                   YouTube's own embedded player is not used.
 ↓
Your selections (numeric seconds, millisecond precision), derived per POV from one event range
 ↓
Stream selection   best video + best audio the source *actually* offers
 ↓
Range fetch        HLS  → parse #EXTINF, download only the covering segments
                   HTTP → FFmpeg seeks with byte-range requests
                   Segments are cached by URL, so overlapping clips across POVs and clips
                   share downloaded media instead of re-fetching it.
 ↓
Cut                stream copy when it lands on a keyframe, frame-accurate re-encode when
                   it would not, or when a watermark/audio edit means the picture or sound
                   is being redrawn anyway
 ↓
Mux                MP4 (default) or MKV, watermark and hand-drawn audio edits applied per POV
 ↓
Verify             ffprobe: streams, duration, A/V skew
 ↓
Final file(s)      one per exported POV, or a combined file where that mode is used
```

**Kick** is not read through yt-dlp: its bot protection is handled directly by decoding the
UUIDv7 timestamp embedded in modern Kick VOD links and matching it against the channel's own video
list through Electron's own network stack (`net.fetch`), which is what avoids needing yt-dlp's
browser-impersonation extra.

### The three cutting modes

| Mode | What it does | When to use |
|------|--------------|-------------|
| **Smart** (default) | Stream-copies when the requested start is within the keyframe tolerance, otherwise re-encodes for a frame-accurate cut. Either way it tells you which happened. | almost always |
| **Stream copy** | Never re-encodes. The clip starts at the nearest earlier keyframe and the drift is reported — it is never hidden. | archival, maximum speed |
| **Frame accurate** | Always re-encodes with the best available encoder (NVENC / Quick Sync / AMF / VideoToolbox / VA-API, else software) at visually lossless quality. | exact frames matter, or a watermark/audio edit is being applied |

Hardware encoders are **smoke-tested at startup** by actually encoding a frame, so the app never
selects a GPU encoder that would fail mid-export, and it falls back to software automatically if a
GPU encode fails at run time. Hardware is preferred by default whenever it's available and working.
Output is always H.264 or HEVC, except an AV1 source exports as real AV1 when — and only when — a
hardware AV1 encoder is actually available; otherwise it's downgraded to HEVC rather than falling
back to slow software AV1 encoding. Every export states which encoder it actually used.

---

## Multi-POV clipping

1. **Load POVs.** Paste links, or pick saved streamers' recent broadcasts from the Streamers
   panel — which also suggests other saved streamers whose VODs overlap the event you're currently
   looking at ("Other saved POVs live at this time"). Pasting a link that's already in the project
   switches to the existing POV instead of adding a duplicate.
2. **Synchronise.** Automatic where the platform's own metadata is reliable enough, corroborated
   automatically by cross-correlating audio between POVs once each one is opened; a visual
   waveform-based manual alignment is available per VOD and per clip for anything that still needs
   it, plus a one-click re-validate action per POV. Each POV shows its own sync confidence.
3. **Clip once.** Watching any POV, mark IN/OUT and add the clip. Every other loaded POV that
   covers that real-world moment gets its own derived range in the same action — full, partial, or
   not-available, shown per POV.
4. **Edit audio per POV.** On the Properties page, draw mute, bleep or duck edits directly onto a
   clip's waveform for its chosen audio POV. There's no detection or review queue — an edit is
   authoritative the moment it's placed, the same as a marker or a trim point.
5. **Watermark per VOD.** A streamer's saved default watermark applies to a newly-loaded VOD from
   that streamer automatically; overriding it for one VOD never changes the streamer's default.
6. **Export.** One POV, several, or all of them — each exported file uses that POV's own video,
   audio edits and watermark. Video and audio can also be sourced from different POVs for the same
   clip.

---

## Network efficiency

- Only the media segments covering a selection are fetched — never a whole VOD.
- Segments are cached by URL, so **overlapping clips across POVs and events share downloaded
  media**.
- The cache is size-capped and pruned least-recently-used; it can never quietly fill your disk.
  Clear it any time from **Settings → Storage**.

---

## Editing

### Timeline

Two timelines: the **event timeline** (the real-world moment) and each **POV timeline** (that
POV's own local VOD time). Zoomable, pannable, shows every clip's boundaries, markers and an
adaptive time scale.

- **click / drag** on the ruler or empty area — seek
- **Shift + drag** — mark a new selection
- **drag a clip edge** — trim the start or end
- **drag a clip body** — move the whole selection
- **wheel** — zoom at the cursor; **Shift + wheel** — pan
- **Alt + drag** or **middle-drag** — pan

### Making a clip

Every step has a button — no shortcut is ever required:

1. **Load** a VOD link, or add more POVs of the same event.
2. Play to the moment you want, in any loaded POV.
3. **⟦ Mark in**, then **Mark out ⟧**.
4. **✚ Add clip** — every covering POV gets its derived range automatically.

They live in the transport bar under the player, and again in the Clips panel while it is empty.
**? How to clip** in the title bar opens a step-by-step guide at any time.

### Keyboard

| Key | Action |
|-----|--------|
| `Space` / `K` | play / pause |
| `←` / `→` | seek 5 s |
| `Shift + ←` / `Shift + →` | seek 30 s |
| `I` / `O` | set selection start / end |
| `Enter` | add the current selection as a clip |
| `Delete` | delete the selected clip |
| `J` / `L` | previous / next clip |
| `M` | add a marker at the playhead |
| `P` | loop the selected range |
| `=` / `-` | zoom the timeline |
| `Ctrl + Z` / `Ctrl + Shift + Z` | undo / redo |

All bindings are editable in **Settings → Keyboard**. Shortcuts never fire while you are typing in
a field. "Find in all POVs" — jump every loaded POV to the same real-world instant — is a toolbar
button rather than a shortcut.

### Filenames

Clip filenames are built from a configurable template — `{Name}` `{VODTitle}` `{Creator}`
`{Platform}` `{Date}` `{Index}` `{Start}` `{End}` `{Duration}` — sanitised for Windows and never
overwriting an existing file: collisions become `Name (2).mp4`, `Name (3).mp4`, …

### Projects

Projects (`.cookieclip`) store every source, streamer, clip, POV mapping, synchronisation anchor
and watermark configuration — but never the media itself. Saves are **atomic**, so a crash or power
loss cannot corrupt a project, and an autosave recovery copy is offered on the next launch
(**Recover** in the toolbar).

Every save also keeps a rolling history of the previous version — up to 10, oldest dropped first —
next to the project file. **Project → Version history** lists them with a one-click restore, for
when an edit needs undoing after the fact rather than in the moment.

---

## The three pages

| Page | What it's for |
|------|----------------|
| **Video** | The player, POV switching, "Show All" multi-POV synchronised playback, event and per-POV timelines, markers, sync controls, clipping tools. |
| **Properties** | Facts about the current project, event, clip, POV and VOD, plus the hand-drawn mute / bleep / duck edits for the clip's chosen audio POV. |
| **Export** | Selected clips and POVs, video/audio source per clip, watermark status, filename/folder templates, the export queue (pause/retry/cancel), ffprobe verification. |

The `dev` build channel adds a fourth, **Editor**, page — see [Build channels](#build-channels).

---

## Platform notes

| Platform | Preview | Range export | Caveats |
|----------|---------|--------------|---------|
| **Twitch** | native player, direct HLS | yes — VOD HLS segments | Sub-only VODs need an authenticated session. Twitch's official *clip* API cannot express an arbitrary VOD range, so it is deliberately not used for this. |
| **Kick** | native player, direct HLS | yes — VOD HLS segments | Resolved through Kick's own API directly rather than yt-dlp (see above). |
| **YouTube** | native player, same as Twitch/Kick | yes — byte-range reads of the adaptive streams | Plays through Ripper Clipper's own player, not YouTube's embedded IFrame player. Age-restricted / private / members-only videos need cookies. Videos served only under DRM are reported as unsupported rather than failing silently. |

Ripper Clipper only retrieves media you are authorised to access. It contains no DRM circumvention
and no access-control bypass.

---

## Audio edits

Mute, bleep or duck (turn down without silencing) any range of a clip's audio, per POV — drawn by
hand on the Properties page's waveform. An edit is an instruction, never a change to the source
media: it lives on the clip, survives saving, and is only ever applied when a file is actually
written, so undoing one later costs nothing. Edits are independent per POV, since each POV is a
different microphone in a different room, and can be scoped to a single clip without touching any
other clip's edits for the same POV.

Automatic speech-based profanity detection and music detection were both part of earlier iterations
of this app and have since been removed entirely — there is no speech recognition, music
processing, detection UI, or related dependency left in the current build. Audio editing today is
manual, immediate, and has no review or approval step.

---

## Security

- Untrusted URLs, ids, filenames and paths are validated before use.
- Every external process is launched with an explicit argument array and `shell: false` — there is
  no string-concatenated command anywhere.
- The renderer has no filesystem, network or process primitives; it can only call the small typed
  IPC surface in `src/shared/ipc.ts`.
- Logs redact tokens, cookies, client secrets and the signed query parameters that appear in
  resolved media URLs.

---

## Testing

```bash
npm test                  # everything
npm run test:unit         # fast, no media
npm run test:integration  # builds real HLS/HTTP-range fixtures and exports from them
```

The integration suite generates a VOD-like fixture with a distinct colour and audio tone per
10-second chunk, serves it over a local HTTP server with Range support, and exports from it — so
tests assert the exporter cut **the right part**, from **the right POV**, with the **right audio
POV** where the two differ, by checking actual frame colours and audio tones in the produced
files, not just that a file of roughly the right length appeared.

`tests/integration/workflow.test.ts` runs the full specified workflow — create named ranges →
reorder → save → reopen → export → verify — and writes `tests/.artifacts/workflow-report.md` with
ffprobe results for every file it produced.

---

## Look and feel

A near-black editing surface in dark mode — so the video stays the brightest thing on screen — and
a soft light-gray surface in light mode, both with a blue accent, built from one shared set of
design tokens rather than per-component colours. Follows Windows' own light/dark setting by
default; pick one explicitly in **Settings → Appearance**. One design system: one implementation of
every button, dropdown, menu, dialog and status indicator, so every page looks like it belongs to
the same application.

## Architecture

```
src/
  shared/          domain model, event/POV sync math, audio cross-correlation for sync,
                   clip↔POV mapping, hand-drawn audio-edit model, timecodes, filenames,
                   watermark model, error catalogue, IPC contract
  main/
    platforms/     PlatformAdapter + Twitch / Kick / YouTube, adapter registry
    media/         ffmpeg, resolver, HLS/HTTP range fetch, Kick's direct API resolution,
                   formats, exporter, watermark + transform filters, thumbnails, audio peaks
    services/      logger, settings, projects (rolling backups), cache, disk, export queue,
                   streamer library, watermark image library, external-tool location,
                   auto-update
    localServer    serves the built renderer + the same-origin media proxy
  preload/         the only bridge to the renderer
  renderer/        React UI: player, Show All grid, event/POV timelines, Video/Properties/
                   Export pages, streamer panel, watermark editor, automatic audio cross-check
```

The media engine has no dependency on the UI and is exercised directly by the integration tests.
The editor never branches on platform: everything platform-specific lives behind
`PlatformAdapter`. A clip's canonical range is always real-world event time; every POV's local
range for it is derived, never independently stored as ground truth.

---

## Troubleshooting

**"FFmpeg not found" / "Stream resolver not found"** — install them (see above) or point at them
in **Settings → Diagnostics**, then **Re-check everything**.

**"Could not read the VOD"** — usually an out-of-date yt-dlp. Update it
(`winget upgrade yt-dlp.yt-dlp`) and retry.

**"Authentication required"** — the VOD needs an account. Configure browser cookies for that
platform and retry.

**Preview will not play but export works** — the preview and the export use different paths on
purpose. Preview traffic is routed through the app's own loopback proxy precisely because platform
CDNs do not reliably send CORS headers, but a platform can still refuse to serve a preview. You can
enter timestamps by hand and export regardless; the export pipeline does not use the player at all.

**An export failed** — the queue keeps every other job's result. Press **Retry**; the technical
detail is in the log (**Settings → Diagnostics → Open log folder**).

---

## Staying up to date

The stable build checks the [GitHub releases feed](https://github.com/Omega248/RipperClipper/releases)
on launch, and any time you press **Check for updates** in **Settings → Diagnostics**. Nothing
downloads or installs without an explicit click at each step — a check only reports whether a
newer version exists. Experimental and dev builds never check, since neither is published as a
real release.
