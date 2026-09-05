# The native player

Decided: replace the browser media stack with our own pipeline, GPU-first,
full control. This is the plan and where it has got to.

## What "our own native player" means here

Our own **pipeline** — demux, decode, scale, present, buffering, seeking — built
on libavcodec and the platform hardware-decode APIs. Not our own codecs: an
H.264 decoder is twenty years of edge cases, and anything we wrote would call
the same GPU decode blocks less well. The control we want is over *everything
around* the decoder, which is exactly where the browser gives us none.

## The pipeline

```
HLS → demux → hardware decode (GPU) → scale to tile size (GPU)
    → small NV12 frame → WebGL texture → NV12→RGB shader (GPU)
```

**Scaling before download is the whole design.** A 1080p frame is 3.1 MB; the
same frame scaled on the GPU to a 480×270 tile is 190 KB. Nine tiles at 30fps
is ~50 MB/s, which is nothing. Download first and scale after and it is
840 MB/s, which does not work at all. This is why `scale_cuda` sits *before*
`hwdownload` and must stay there.

## Milestone 1 — the core, proven ✅

`scripts/native-player/` — a standalone server + WebGL page, outside the app on
purpose so the pipeline could be judged without Electron, React or the timeline
in the way.

```
node scripts/native-player/server.mjs --project "C:\path\to\Event.cookieclip"
node scripts/native-player/server.mjs <url> <url> ...
# then open http://localhost:8787
# --width 480 --height 270 --port 8787 --no-hw
```

**Verified end to end** (4 streams, software decode, software GL, in a
container): frames decode, cross the pipe, upload as two single-channel
textures, convert in the fragment shader and draw. 159 fps total across four
tiles on *swiftshader* — the real GPU path has a lot of headroom above that.
Colour is correct: the bars render red-first, so U and V are not transposed.

No native compilation, deliberately. ffmpeg is already bundled. An N-API addon
later removes one memory copy; what it costs is a build toolchain on every
machine, and that trade is only worth making once the pipe is proven to be the
bottleneck. It is not yet.

### Run against a real live stream ✅

Also verified against **live Kick HLS** (Aus24, pulled from
`kick.com/api/v2/channels/<slug>` — my prototype skips yt-dlp for a URL that
is already `.m3u8`, which Kick's playback_url is). Three tiles, real broadcast,
correct colour on real content rather than test bars: natural skin tones and
water, so the BT.709 conversion is right and the planes are not transposed.

Two things that run showed, both of which change the plan:

**The tiles are visibly out of sync with each other.** The in-game speedometer
read 057, 050 and 056 across the three tiles of the *same* broadcast. Three
independent decoders each opening at their own live edge, with no shared clock
— which is exactly what milestone 2 has to build, and now there is a picture of
why. `FollowerVideo`'s drift correction is the behaviour that has to be
rebuilt, not discarded.

**ffmpeg chose the 284×160 variant on its own.** Kick's master playlist has
several, and with no `-map` it took the first. For a wall tile that is
accidentally the right answer; for the focused POV it is badly wrong. hls.js
was making this choice for us and now it is ours — which is the control that
was asked for, and a decision that has to be made explicitly rather than
inherited from ffmpeg's default.

Performance from that run is **not** a useful number: software decode under
swiftshader in a container gave 24/31/19 fps per tile. It says the pipeline
holds together, nothing about what the hardware path will do.

### The bug this already caught

`ffmpeg -hwaccels` lists what the **build** supports, which says nothing about
the **machine**. A gyan full build reports `cuda` on a box with no NVIDIA card;
the pipeline then fails at device creation with *"Cannot load libcuda"*, every
frame goes missing, and the wall is black with nothing anywhere saying why.
That is not hypothetical — it is what the first run did.

So the pipeline is now chosen by **running** it: each candidate is asked for one
real frame from a real stream, and the first that produces bytes wins. Costs a
second at startup and cannot be wrong about the hardware, because it used it.
Candidates, best first: NVDEC + `scale_cuda` → QSV + `scale_qsv` → d3d11va /
videotoolbox / vaapi decode with CPU scale → software. A tile that never
receives a frame now says so instead of showing black.

## Milestone 2 — audio, and the sync that goes with it — **done**

The focused angle's audio is the clock; every tile draws the frame that belongs
at one shared instant. Measured, not eyeballed: `sync-check.mjs` drives the page
headlessly and samples the numbers eight times, because 200ms out looks fine on
screen and cuts wrong.

**3 tiles, 480×270, decode keeping up:** tile-to-tile spread **7–20ms**, peak
drift 30ms (one frame), 0 catch-ups, 0 audio underruns.

Three things had to be fixed to get there, and each was a real bug rather than a
tuning knob:

**`-re` pacing.** Without it a local file decodes at ~30×, frames arrive thirty
seconds ahead of the clock that decides when to show them, the queue bound throws
them away and the picture stalls at full CPU: 1025 received, 50 drawn, 945
discarded. Live sources are already real time and must not be paced.

**The clock belongs to the clock, not to a tile.** The shared instant was
anchored on the audible angle's *video* origin, so that angle's decode hiccup
moved everyone else's idea of "now". `AudioClock` now pins its own
`wallOriginMs`, and per-tile origins are purely each tile's own mapping. This is
what took the spread from 18ms to 7ms.

**One listening port per tile.** Chromium allows six concurrent HTTP/1.1
connections per origin and every tile holds one open for as long as it plays. At
eight angles the seventh, the eighth *and the audio request* never connect — so
the clock never starts and nothing draws at all: 2277 frames received, 0 shown.
The limit is keyed on scheme://host:port, so the server listens on `PORT+1+i` per
tile. HTTP/2 would also lift it, but Chrome only speaks h2 over TLS and a
self-signed cert for a loopback preview server is more moving parts than calling
`listen()` nine times.

### Catch-up, and what it honestly cannot fix

A decoder that cannot hold real time makes drift grow without bound — measured at
**−6029ms after twelve seconds** on a live Kick stream where decode managed 16fps
of 30. Each tile now re-anchors its own origin when it falls more than 0.5s
behind, rate limited to once a second and counted (`↻N` beside the fps).

Catching up for the **group** was tried and is worse. Pulling the shared instant
back to suit the slowest angle sounds better — the angles would stay together —
but a tile that is keeping up has already consumed the frames that instant asks
for, so it stalls, its drift freezes, and it drags the group again next second:
**14.2s of slip in 20s, and spread got worse, not better (2063ms against
736ms).** Reverted, and the reasoning is in the comment so it is not retried.

**8 tiles, 960×540, on 2 cores with no GPU:** fps 8 of 30, 15–16 catch-ups (the
cooldown rate), drift bounded near 1s, spread ~700ms. That is a capacity failure
and the numbers say so out loud. No scheduling policy fixes a machine producing
frames four times too slowly — the fix is fewer pixels or a GPU, and it belongs
in the server. Deliberately not implemented as adaptive downscaling yet: the
target machine has an RTX, and this measurement comes from a 2-core container
with no `/dev/dri`. Measure there first.

### Still open before this can replace `HlsPlayer`

- switching angle restarts the audio stream; the re-anchor is handled but the
  gap has not been measured
- `FollowerVideo` still chases the leader's `<video>` clock and must be rebuilt
  against `AudioClock`

## Milestone 3 — seeking — **done** (the live edge is not, and says so)

`/frames/:i?t=` and `/audio/:i?t=` seek with **`-ss` before `-i`**, which seeks
the demuxer: ffmpeg reads the playlist, works out from the EXTINF durations
which segment covers that instant, and starts there. Put after `-i` it would
decode from the beginning and discard, which on a six-hour VOD is the
difference between a seek and a coffee break.

**No segment index was needed.** The milestone was written expecting to reuse
`rangeFetcher`'s window logic, and that turned out to be solving a problem the
HLS demuxer already solves. Measured against a ten-minute fixture:

| asked for | first frame after |
|---|---|
| t=5s | 99ms |
| t=575s | 101ms |

Flat. A re-download would grow with the offset, and on a paced (`-re`) read it
would grow catastrophically. `rangeFetcher` stays where it is, doing the job it
already does for exports.

### Seeks land within one frame, at or before the instant asked for

Both halves land exactly, checked by content rather than by trusting the
request: the fixture is twenty thirty-second blocks, each a distinct colour and
a distinct tone, so "the picture is from t=305s" is a pixel comparison and "the
sound is from t=305s" is a frequency one. Both matter — the audio is the clock
every tile is drawn against, so a seek that moved the picture and not the sound
would anchor the whole wall to the wrong moment.

On an **exact** frame boundary the HLS path lands one frame early, and this is
worth writing down because it looks like a bug. ffmpeg computes the target as
`t + the container's declared start_time`. MPEG-TS declares 1.400s; the first
frame in these segments is actually at 1.421s. That 21ms is under one frame
period, so the target falls just short and the demuxer hands back the frame
that was on screen at that instant — which is what a player should do. A plain
MP4 of the same content has no such offset and lands exactly. The property the
harness asserts is therefore "within one frame, and never *past* what was asked
for"; landing late would show a moment that had not happened yet.

### The client

`pts` is now absolute media time rather than frames since the connection
opened, anchored on the `x-start-seconds` the server reports rather than on
what was requested — the two differ when a request is clamped to the
recording's length, or ignored because the source is live.

`seekTo()` tears everything down and reopens it: frames in flight are from
somewhere else entirely and the clock's zero no longer means what it meant, so
there is nothing to salvage. One abort controller for the whole wall, not one
per tile — a seek moves every angle or none, and two tiles left reading the old
position is exactly the state the shared clock cannot describe. A newer seek
supersedes one still opening, or the older one's pipes arrive afterwards and
quietly move the position back.

Transport: a scrub bar, ⏮ / ±5s (Shift: 30s) / End, and ←→ Home End on the
keyboard. Switching angle now reopens the sound at the position already
reached — it is a change of *whose* sound, not of *when*.

### The live edge is deliberately not done

A live playlist is a sliding window with no zero to be an offset from, so `t`
is accepted and ignored for a live source and the header says so rather than
pretending. The transport shows `LIVE` instead of a slider that would lie about
being able to go back.

Seeking within a DVR window (`-live_start_index`, or `-ss` against a sliding
playlist) is a real feature and is **not** implemented, because there is no
live source in the sandbox to measure it against and guessing at it would
produce exactly the kind of untested claim this file exists to avoid.

### Verified

`scripts/native-player/seek-check.mjs` — 24 checks, all passing, no browser
needed. It builds nothing itself: `make-fixture.mjs` generates the tape.

```
node scripts/native-player/make-fixture.mjs
node scripts/native-player/seek-check.mjs --fixture scripts/native-player/fixture
```

### Does the wall come back together after a seek?

Tearing every tile down and reopening it throws away the thing milestone 2
spent its whole effort building. `seek-sync-check.mjs` drives the page with
playwright and samples the same numbers `sync-check.mjs` does, either side of a
seek. Three tiles, 480×270, software decode:

| | spread | drift | first frame after the seek |
|---|---|---|---|
| before the seek | 5–9ms | — | — |
| after seeking to 300s | 17ms, settling to 7–8ms | −18 to −1ms | **130ms** |

The position reads 307.4s for a seek to 300s — the difference is the seven
seconds spent measuring afterwards, not error. The clock reads 7.4s, so it
restarted rather than carrying on from the old position, which is the thing
that would have silently desynchronised everything. Zero audio underruns.

Playwright turned out to be installed in the cloud container after all
(`/home/claude/.npm-global/lib/node_modules/playwright/index.js`), so this is
measured rather than handed on. It caught one real defect: aborting the audio
fetch on every seek left an unhandled rejection per seek — console noise that
looks exactly like a fault and would drown a real one. `startAudio()` now
expects it.

## How wide can the wall go?

`scripts/native-player/stress.mts` drives the app's own frame server with N
angles, reads every frame it produces, and reports what it cost. It measures
the **steady state** — the first version averaged from t=0 and charged every
tile for time before it had started, which reported a wall running perfectly
well as short of real time. Forty decoders do not begin together.

Measured in the sandbox: **2 logical cores, no GPU, software decode**, against
the generated fixture.

| tiles | per tile | of real time | decoders | memory | verdict |
|---|---|---|---|---|---|
| 2 | 29.7 fps | 99% | 2 | 128 MB | smooth |
| 8 | 30.6 fps | 102% | 8 | 512 MB | smooth |
| 16 | 31.3 fps | 104% | 16 | 1.0 GB | smooth |
| 40 | 19.7 fps | 66% | 40 | **2.5 GB** | not smooth |

### The memory column is wrong, and finding out cost a rewrite

Those memory figures are RSS. **RSS counts a shared library page once per
process that maps it**, and forty ffmpegs map the same libav. Charging shared
pages fairly (PSS) at forty tiles gives **1472 MB, not 3069 MB**. The harness
now measures PSS on Linux and private bytes on Windows; the table above is left
as measured so the correction is legible, but halve its memory column in your
head.

The inflated number had already produced a conclusion — *64 MB per decoder is
process overhead no GPU can fix, so a wall of forty needs a handful of
processes each decoding several angles* — and that conclusion was the next
scheduled piece of work. It got measured before it got built
(`scripts/native-player/procmodel.mjs`, 40 angles, 2 cores):

| model | rss | pss | per angle | startup |
|---|---|---|---|---|
| one per angle | 3069 MB | 1472 MB | 36.8 MB | **6.1s** |
| 4 per process | 1492 MB | 1128 MB | 28.2 MB | **0.2s** |
| all in one | 982 MB | 979 MB | 24.5 MB | 1.1s |

**It is not worth building.** Sharing decoders takes about 23% off the real
memory figure. The price is that ffmpeg's inputs are fixed when it is spawned,
so a shared process cannot stop, seek or restart one angle without disturbing
the others — and that is precisely what the wall does whenever a tile scrolls
out of view, pauses, or is scrubbed. A quarter of the memory does not buy that
back.

**Start-up is the real difference**: 6.1s against 0.2s at forty angles, which
is the same fact as the 11.8s above. But forty simultaneous process spawns
contending for *two* cores is not the target machine. Measure it on the RTX
before building anything for it; it may not exist there.

### What still stands

The fps column is the *least* interesting one, because it is the one a GPU
fixes. Two software cores managing sixteen angles says the pipeline is not
wasteful; an RTX doing the decoding changes that number and not much else.

It is also the least *trustworthy* one at forty tiles: `procmodel.mjs` measured
the same configuration at 7.5 fps and at 21.4 fps on different runs. Two cores
under forty decoders is a thrashing measurement, not a throughput one.

### Caveat worth stating

The fixture is solid colour at 360p, which is close to free to decode. Real
gameplay footage is much harder on the CPU path, so the software numbers here
are optimistic. The memory-per-angle figure is content-independent and is the
one to trust — once it is PSS rather than RSS.

### Running it

```
node scripts/native-player/make-fixture.mjs
node --experimental-transform-types --import ./scripts/sandbox-loader.mjs \
  scripts/native-player/stress.mts --tiles 40 --seconds 30
```

Exits non-zero when the wall is not smooth, so it can gate a change.

In the app, `Settings → Diagnostics → Playback benchmark` now measures native
tiles as well as `<video>` elements and says which engine and pipeline produced
the numbers — the two were not comparable before, because a canvas has no
`getVideoPlaybackQuality()` and a full native wall read as zero.

## Milestone 4 — native downloading

Currently Node fetches HLS segments. This is **network-bound, not CPU-bound**,
so it is the least likely part of the app to benefit — measure before rewriting.
The genuine wins available are HTTP/2 multiplexing across segments and a shared
segment cache, both of which can be done in the existing Node path first.

## Milestone 5 — integration — **the wall is done; the focused player stays the browser's**

The native pipeline is now in the app, behind
`Settings → Playback → Decoder`, defaulting to **browser**.

### What is native, and what deliberately is not

The **POV wall** decodes natively. That is where the cost problem actually is:
a dozen angles, each decoding a rendition far larger than the tile it is drawn
into. The **focused player stays `HlsPlayer`**, and that is a decision rather
than an unfinished edge.

A browser is perfectly good at playing *one* video. It handles scrubbing,
fullscreen, and playback rate — and rate is the awkward one: the native pipe is
paced by `-re` at 1x, so 0.5x and 2x would mean reopening every angle with
different arguments and re-deriving every timestamp. Spending that to replace
something already working, in the one place the browser is not the bottleneck,
buys nothing.

It also keeps the clock where the app already puts it. In this app the focused
angle owns the playhead and every other angle is *told* where to be. So
`NativeFollower` has no clock of its own — a second opinion about "now" is
precisely the bug the shared clock exists to prevent. `AudioClock` is in the
tree (`player/native/audioClock.ts`) for when the focused player does move
across; the wall does not need it.

### The pieces

| | |
|---|---|
| `main/media/framePipeline.ts` | which decode chain, and proving it by running it |
| `main/media/frameServer.ts` | frames and sound over loopback, one port per tile |
| `shared/frameTiming.ts` | every timing decision, pure and tested |
| `player/native/nv12Tile.ts` | NV12 → RGB in a shader |
| `player/native/framePump.ts` | reading a pipe, drawing the right frame |
| `player/native/tilePorts.ts` | leasing one origin per on-screen angle |
| `player/NativeFollower.tsx` | prop-compatible with `FollowerVideo` |

Frames cross as HTTP chunked bodies rather than IPC messages because a body is
back-pressured for free: if the page stops reading, the socket fills, ffmpeg
blocks, and nothing buffers without bound. An IPC channel has no such brake and
the failure mode is the main process growing until it dies.

### Verified

`scripts/native-player/frame-server-check.mts` drives the **app's own**
frame server — not the prototype — against a generated fixture. Serving,
seeking (87ms at t=305, 77ms at t=575), picture checked by content, per-tile
origins all distinct, unknown angles refused, audio seeking with the picture.
It also proves `verifyPipeline` works: on a machine with no GPU it rejected
cuda, qsv and vaapi in turn and settled on software.

`tests/unit/frameTiming.test.ts` covers the timing rules — 19 assertions, no DOM.

**Not yet measured:** the wall running natively inside the app on real POVs.
That needs a Windows build, which no session has run.


Replace `HlsPlayer` and `FollowerVideo` behind their existing interfaces. The
`playerBus` controller contract (`play`, `pause`, `seek`, `getCurrentTime`, …)
is the seam, and it already exists — which is what makes this a layer swap
rather than a rewrite. Adapters, range fetcher, export pipeline and project
format are untouched throughout.

## What is not being rewritten

Export. It is already FFmpeg subprocesses doing stream-copy and NVENC, which is
exactly what a native pipeline would do. There is nothing to win there.

## What has actually been measured, and by whom

| | measured | where |
|---|---|---|
| pipeline works on synthetic streams | ✅ | container, software decode + swiftshader |
| pipeline works on real live Kick HLS | ✅ | container, software decode + swiftshader |
| runtime hardware verification rejects absent GPUs | ✅ | container (no NVIDIA present) |
| seeking lands where asked, picture and sound | ✅ | container, against a generated fixture |
| a deep seek costs no more than a shallow one | ✅ | container, 101ms at t=575 vs 99ms at t=5 |
| **NVDEC throughput on the target machine** | ❌ | needs the Windows box — no GPU in either sandbox |
| **the browser wall's current cost, to compare against** | ❌ | needs the app running with POVs playing |
| the wall re-syncs after a seek | ✅ | container, 3 tiles software decode, 130ms and back to 7–8ms spread |

The missing rows are the ones that decide whether any of this is worth
finishing. All of them have to be run on the real machine:

```
# half 1 — what the browser wall costs now
Watch page, POVs playing → Settings → Diagnostics → Playback benchmark

# half 2 — what the native pipeline does on the same streams
node scripts/native-player/server.mjs --project "C:\path\to\Event.cookieclip"
# the header line says which pipeline actually verified
```

### Re-running the seek measurements

```
node scripts/native-player/make-fixture.mjs
node scripts/native-player/seek-check.mjs --fixture scripts/native-player/fixture

node scripts/native-player/server.mjs --port 8990 <the fixture, three times>
PLAYWRIGHT=<path to playwright/index.js> URL=http://localhost:8990 \
  node scripts/native-player/seek-sync-check.mjs
```

Both were run against software decode on two cores. On the RTX machine they
should only get better; if they get *worse*, the place to look is `seekTo()`'s
teardown and `AudioClock.reset()`.
