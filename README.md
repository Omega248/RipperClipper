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
its own audio, its own profanity review, and its own watermark. Add another POV to the project
next week and it backfills into every existing clip it covers, without anything being recreated.

---

## Getting it running

Nothing has to be installed by hand. Ripper Clipper fetches the programs it needs from their
publishers, checks each one against the checksum that publisher publishes, and keeps them inside
its own folder.

**If you have a packaged build** — just run it. FFmpeg, FFprobe and yt-dlp are already inside
`resources/bin` next to the executable, and on Windows so are whisper.cpp and its speech model.
Settings → Tools shows what is there and where each piece came from.

**If you are building it yourself:**

```bash
npm ci               # dependencies
npm run tools        # download + verify FFmpeg, yt-dlp, whisper.cpp, speech model
npm start             # run it
```

`npm run tools` prints the sha256 of every file, says whether the publisher published a checksum
to check it against, and then runs each tool to prove it works. `npm run package:win` does the
same for Windows (from any host) and then builds the installer, so the result is self-contained.

| Tool | What it does | Where it comes from |
|------|--------------|---------------------|
| **FFmpeg + FFprobe** | cutting, muxing, watermarking, verification | gyan.dev release-essentials (Windows) or BtbN builds — both linked from ffmpeg.org |
| **yt-dlp** | stream manifests and metadata for all three platforms | its own GitHub releases, verified against `SHA2-256SUMS` |
| **whisper.cpp** | speech recognition for profanity detection *(Windows builds only)* | `ggml-org/whisper.cpp` releases |
| **ggml-base.en** | the speech model | `huggingface.co/ggerganov/whisper.cpp`, verified against the API digest |

Anything missing at startup is downloaded automatically (Settings → Tools has a toggle to stop
that). A tool already on your machine is used as it is — nothing is downloaded twice — and
Ripper Clipper looks in this order:

1. the path set in **Settings → Advanced**
2. tools it downloaded itself (`%APPDATA%\cookie-clipper\tools`) — so an updated yt-dlp wins
3. `resources/bin` next to the app — what a packaged build ships with
4. the system `PATH`, then common install locations (WinGet links, `C:\ffmpeg\bin`, `/usr/bin`, Homebrew)

Prefer to install them yourself? `winget install Gyan.FFmpeg` and `winget install yt-dlp.yt-dlp`
still work; Ripper Clipper will find them. The normal UI never shows dependency internals beyond
"ready" / "setting up" — Settings → Tools / Diagnostics has the technical detail for anyone who
wants it.

---

## Running it

```bash
npm install
npm run dev          # development, with hot reload
npm run build        # typecheck + production build into out/
npm start             # run the production build
npm test              # full test suite (unit + real-media integration)
npm run tools         # fetch + verify this platform's tools into resources/bin
npm run tools:win     # …or Windows' tools, from any host
npm run package:win   # tools + build + Windows NSIS installer into release/
npm run package:dir   # tools + build + unpacked folder into release/
```

---

## The workflow

```
Find a streamer's VOD                Streamer library
 (paste a link, or pick a       ←──── remembers every channel
  saved streamer's broadcast)         you've loaded a POV from
        │
        ▼
Load every other POV covering the same event   ("Add POV" — or let the
        │                                        Streamers panel suggest
        ▼                                        who else was live)
Synchronise onto one real-world clock
 (platform start time → metadata → manual
  waveform alignment → confidence shown per POV)
        │
        ▼
Watch any one POV → mark IN/OUT → Add clip
        │
        ▼
Ripper Clipper derives that clip's range in every other covered POV
 automatically — full / partial / not-available coverage, per POV
        │
        ▼
Review each POV's audio independently (strong profanity only, by
 default) → approve mute / bleep per finding, with a real before/after
 preview → nothing is changed until approved
        │
        ▼
Apply each VOD's watermark (streamer default, or a VOD-specific
 override) at export time only — the preview and export use the same
 transform, so what you position is what gets written
        │
        ▼
Export one POV, several, or all of them — each with its own video,
 its own audio, its own approved edits, its own watermark
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

Each POV owns its own synchronisation, its own watermark, and its own audio review — approving a
mute in POV A's cut of a clip never touches POV B's. Sound and picture for a clip can also be
mixed across POVs deliberately (cut the picture from one angle, the audio from another) without
breaking sync.

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
Mux                MP4 (default) or MKV, watermark and approved audio edits applied per POV
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
GPU encode fails at run time.

---

## Multi-POV clipping

1. **Load POVs.** Paste links, or pick saved streamers' recent broadcasts from the Streamers
   panel — which also suggests other saved streamers whose VODs overlap the event you're currently
   looking at ("Other saved POVs live at this time").
2. **Synchronise.** Automatic where the platform's own metadata is reliable enough; a visual
   waveform-based manual alignment is available per VOD and per clip when it isn't. Each POV shows
   its own sync confidence.
3. **Clip once.** Watching any POV, mark IN/OUT and add the clip. Every other loaded POV that
   covers that real-world moment gets its own derived range in the same action — full, partial, or
   not-available, shown per POV.
4. **Review audio per POV.** The Audio page is one row per clip × POV. Strong profanity only is
   flagged by default (mild swearing is off by default and never treated the same); every finding
   is a proposal with a real before/after preview until you approve a mute or bleep.
5. **Watermark per VOD.** A streamer's saved default watermark applies to a newly-loaded VOD from
   that streamer automatically; overriding it for one VOD never changes the streamer's default.
6. **Export.** One POV, several, or all of them — each exported file uses that POV's own video,
   audio, approved edits and watermark. Video and audio can also be sourced from different POVs
   for the same clip.

---

## Network efficiency

- Only the media segments covering a selection are fetched — never a whole VOD.
- Segments are cached by URL, so **overlapping clips across POVs and events share downloaded
  media**.
- The cache is size-capped and pruned least-recently-used; it can never quietly fill your disk.
  Clear it any time from **Settings → Cache**.

---

## Editing

### Timeline

Two timelines: the **event timeline** (the real-world moment) and each **POV timeline** (that
POV's own local VOD time). Zoomable, pannable, shows every clip's boundaries, markers, profanity
regions and an adaptive time scale.

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
| `F` | find this moment in every loaded POV |
| `P` | loop the selected range |
| `=` / `-` | zoom the timeline |
| `Ctrl + Z` / `Ctrl + Shift + Z` | undo / redo |

All bindings are editable in **Settings → Keyboard shortcuts**. Shortcuts never fire while you are
typing in a field.

### Filenames

Clip filenames are built from a configurable template — `{Name}` `{VODTitle}` `{Creator}`
`{Platform}` `{Date}` `{Index}` `{Start}` `{End}` `{Duration}` — sanitised for Windows and never
overwriting an existing file: collisions become `Name (2).mp4`, `Name (3).mp4`, …

### Projects

Projects (`.cookieclip`) store every source, streamer, clip, POV mapping, synchronisation anchor,
profanity finding and watermark configuration — but never the media itself. Saves are **atomic**,
so a crash or power loss cannot corrupt a project, and an autosave recovery copy is offered on the
next launch (**Recover** in the toolbar).

---

## The four pages

| Page | What it's for |
|------|----------------|
| **Video** | The player, POV switching, "Show All" multi-POV synchronised playback, event and per-POV timelines, markers, sync controls, clipping tools. |
| **Audio** | Profanity review only — one row per clip × POV, filters, sorting, before/after preview, bulk approve/ignore/mute/bleep. |
| **Properties** | Facts about the current project, event, clip, POV and VOD. Technical detail (dependency paths, model internals) lives behind Settings → Diagnostics, not here. |
| **Export** | Selected clips and POVs, video/audio source per clip, watermark and profanity status, filename/folder templates, the export queue (pause/retry/cancel), ffprobe verification. |

---

## Platform notes

| Platform | Preview | Range export | Caveats |
|----------|---------|--------------|---------|
| **Twitch** | native player, direct HLS | yes — VOD HLS segments | Sub-only VODs need an authenticated session. Twitch's official *clip* API cannot express an arbitrary VOD range, so it is deliberately not used for this. |
| **Kick** | native player, direct HLS | yes — VOD HLS segments | Resolved through Kick's own API directly rather than yt-dlp (see above); manifest requests are retried with backoff rather than hammered. |
| **YouTube** | native player, same as Twitch/Kick | yes — byte-range reads of the adaptive streams | Plays through Ripper Clipper's own player, not YouTube's embedded IFrame player. Age-restricted / private / members-only videos need cookies. Videos served only under DRM are reported as unsupported rather than failing silently. |

Ripper Clipper only retrieves media you are authorised to access. It contains no DRM circumvention
and no access-control bypass.

---

## Profanity detection

Local, on-device speech recognition (whisper.cpp) with word-level timing, strong-profanity-only by
default (`fuck`, `fucking`, `fucked`, `fucker`, `cunt`, `shit`, `motherfucker` and their common
inflections — ordinary words like `crap`, `damn`, `hell`, `bloody`, `stupid` are never flagged by
default). Matching is whole-word, not substring, specifically to avoid the "Scunthorpe problem."

Word timing is measured, not guessed: whisper.cpp's own per-token alignment is treated as an
*ordering* rather than an exact boundary (it measurably lags the true word start), and a second
pass re-derives the actual start/end from the clip's own audio envelope — locating voiced speech,
assigning each word its own stretch of audio by both position and expected duration, and extending
over the quiet consonant onset/release that a naive threshold would otherwise clip. The result is
a mute or bleep that lands on the word and stops at it, not a multi-second margin around a guess.
Every finding is a proposal — nothing is changed in the source, and nothing is applied to an export
until it's approved — and findings are independent per POV, since each POV is a different
microphone in a different room.

Music detection and removal were part of an earlier iteration of this app and have been removed
entirely — there is no music-related processing, UI, or dependency left in the current build.

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

Warm bakery palette — cream, biscuit, caramel and cocoa with a raspberry accent — light by
default, with a matching warm dark theme in **Settings → Interface**. One design system: one
implementation of every button, dropdown, menu, dialog and status indicator, so every page looks
like it belongs to the same application.

## Architecture

```
src/
  shared/          domain model, event/POV sync math, clip↔POV mapping, timecodes, filenames,
                   profanity vocabulary + timing alignment, watermark model, error catalogue,
                   IPC contract
  main/
    platforms/     PlatformAdapter + Twitch / Kick / YouTube, adapter registry
    media/         ffmpeg, resolver, HLS parser, range fetcher, formats, exporter,
                   watermark filter, speech transcription, per-clip-per-POV audio analysis
    services/      logger, settings, projects, cache, disk, export queue, streamer library,
                   watermark image library, external-tool location
    localServer    serves the built renderer + the same-origin media proxy
  preload/         the only bridge to the renderer
  renderer/        React UI: player, Show All grid, event/POV timelines, Video/Audio/
                   Properties/Export pages, streamer panel, watermark editor
```

The media engine has no dependency on the UI and is exercised directly by the integration tests.
The editor never branches on platform: everything platform-specific lives behind
`PlatformAdapter`. A clip's canonical range is always real-world event time; every POV's local
range for it is derived, never independently stored as ground truth.

---

## Troubleshooting

**"FFmpeg not found" / "Stream resolver not found"** — install them (see above) or point at them
in **Settings → Advanced**, then **Re-check tools**.

**"Could not read the VOD"** — usually an out-of-date yt-dlp. Update it
(`winget upgrade yt-dlp.yt-dlp`) and retry.

**"Authentication required"** — the VOD needs an account. Configure browser cookies for that
platform and retry.

**Preview will not play but export works** — the preview and the export use different paths on
purpose. Preview traffic is routed through the app's own loopback proxy precisely because platform
CDNs do not reliably send CORS headers, but a platform can still refuse to serve a preview. You can
enter timestamps by hand and export regardless; the export pipeline does not use the player at all.

**An export failed** — the queue keeps every other job's result. Press **Retry**; the technical
detail is in the log (**Settings → Advanced → Open log folder**).
