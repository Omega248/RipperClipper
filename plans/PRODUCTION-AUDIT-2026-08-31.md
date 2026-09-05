# Production readiness audit — Ripper Clipper 1.5.0

31 Aug 2026. Three parallel code audits, a full verification run, a bundle
analysis, and the live app on the target machine.

**Verdict: every defect found is fixed. The code is ready; the release is not,
because nothing here has been run on Windows.**

Twelve defects, four of them invisible on the machine the code was written on.
All twelve are fixed and verified. Three further improvements were deliberately
*not* made — each would need a run to confirm, and shipping an unverifiable
change to the process boundary is the opposite of production-ready. They are
listed in §3 with the reasoning.

**After the fixes: 950 tests, 85 files, typecheck clean on both configs, both
bundles build.**

---

## 1. What was wrong, and is now fixed

### 1.1 The media proxy was an open relay — HIGH

`src/main/mediaProxy.ts`. `GET /media/segment?u=<any URL>` fetched that URL from
the main process and returned the body with `access-control-allow-origin: *`.
No origin check, no host allowlist, no private-IP filter — the only validation
was that the scheme was http(s).

Anything that could reach the loopback port could read `http://192.168.1.1/`,
`http://169.254.169.254/…`, or any intranet app **through** the user's machine,
and read the response body cross-origin. It was also an outbound relay: requests
went out from the user's IP with a spoofed `Origin: https://www.twitch.tv`.

Bound to loopback is not the same as private. Modern Chrome's Private Network
Access checks block the browser route; a non-browser client on the machine is
not blocked at all, and neither are older browsers.

**Fixed** with a per-run secret minted in `proxyUrl()` and checked before
anything is fetched. An `Origin` check alone would not do — a non-browser client
simply omits the header.

### 1.2 The frame server streamed your screen to any origin — HIGH

`src/main/media/frameServer.ts`. `/frames/<id>` and `/audio/<id>` streamed the
decoded picture and sound of whatever was being watched, `ACAO: *`, no
authentication. `/info` helpfully listed all 48 tile ports.

**Fixed** the same way: a per-run token, handed to the renderer in `/info` and
required on every frame and audio request.

### 1.3 The window could navigate anywhere, taking the whole API with it — HIGH

`src/main/index.ts`. `setWindowOpenHandler` denied popups, but nothing guarded
top-level navigation, and the preload is bound to the webContents rather than to
an origin. A single `location = 'https://…'` from any injected script would have
handed a remote page the complete `window.api` surface — every IPC handler,
including the ones that spawn processes and write files. The CSP allows
`script-src 'unsafe-inline'`, so an injection had no brake either.

**Fixed** with a `will-navigate` guard that pins the window to its own origin and
sends real links to the system browser instead. `will-attach-webview` is denied
for the same reason.

### 1.4 `openPath` would run any executable the renderer named — HIGH

`shell.openPath(path)` took an unvalidated string from the renderer. On Windows
that *runs* an `.exe`, `.cmd` or `.lnk`, with no dialog.

**Fixed** by containing both `openPath` and `revealPath` to the directories the
app itself owns — output, cache, projects, logs, temp — which is where every
legitimate caller already points.

### 1.5 A render throw killed the app and your unsaved work — BLOCKER

There was no React error boundary anywhere, and no `window.onerror` in the
renderer. One exception in a 2048-line `App` — a malformed project, an undefined
POV mapping — unmounted the entire tree. The result was a blank window with no
menu bar and no Ctrl+S, because every shortcut is React-bound.

The part that made it a blocker: **autosave is a `setInterval` inside that
tree.** It stopped with everything else, so every clip cut since the last tick
was gone, and the only way out was killing the process.

**Fixed.** `ErrorBoundary.tsx` catches the throw and *saves before it renders
anything* — the project lives in a Zustand store outside React, so it survives
the unmount and can still be written to disk. Then it shows what happened, where
the project went, a Reload button, and the log. The component stack goes to the
app log through a new `logs:crash` channel; it is the only thing that says
*where*, and the main process never sees that exception.

---

## 2. Also fixed

**Main-process crash handlers.** No `uncaughtException`, `unhandledRejection`,
`render-process-gone` or `child-process-gone` handlers existed. IPC calls are
individually wrapped, which covers the request path — but not the queue worker,
the live-buffer timers, the VOD crawler, or an ffmpeg child's event handlers. On
Node 15+ an unhandled rejection is fatal, so the window would vanish mid-export
with no message, no log line, and no `will-quit` cleanup, leaking the job's
scratch files. Now logged and survived.

**Text contrast failed WCAG AA everywhere.** `--text-tertiary: #75798c` measured
3.52:1 on the darkest surface and 3.34:1 on the lightest — the only entry in the
ramp that failed, and the one colouring every hint, caption and status line at
10.5px, *including the sentence on a failed export that tells you what to do*.
No single value clears 4.5:1 against both a near-black and a near-white
background, so it now differs per theme: `#888ca0` (worst case 4.56:1) and
`#5f6377` (worst case 4.59:1).

**"Add browser cookies in Settings → Advanced" — a setting that did not exist,
in a tab that did not exist.** Both platform adapters told users this was how to
reach subscriber-only and age-restricted VODs. There is no Advanced tab, and no
cookie setting anywhere; `resolver.ts` declared a `cookiesFromBrowser` option
that no caller ever supplied. An instruction the user cannot follow, on the one
error that most needs a way out.

The plumbing was 90% there, so it is now a real feature rather than a corrected
lie: **Settings → Setup → Restricted VODs** picks a browser, and yt-dlp borrows
its cookies at resolve time. Nothing is copied or stored by the app and no
password is asked for. Three other strings pointing at "Settings → Advanced" in
the tool installer now name the real tab.

---

## 3. Also fixed in the second pass

**Two Pause buttons that disagreed.** `QueuePanel` was mounted twice on the
Export page — once globally by `App` as the persistent strip, once again inside
the page — each with its own `paused` boolean. Pausing in one left the other
reading "Pause", and clicking it did nothing. It also duplicated the "Export
queue" landmark for screen readers. The duplicate mount is gone, and the button
now seeds itself from `queue.isPaused()` over a new IPC channel instead of
assuming `false`: a reload — including the one the new crash screen offers —
used to come back showing "Pause" on a queue that was already paused, with no
way to resume but to press it and watch nothing happen.

**Crash recovery is now a dialog.** It was a toast, and toasts dismiss
themselves after six seconds unless they are errors. It told people their
unsaved work still existed, that they had to go and find File → Recover
themselves, and that the copy would be overwritten by the next autosave — then
vanished. Step away while the app starts and the only notice that the work
survived a crash was gone, and then overwritten. Recovering work is a decision,
so it now gets a decision's UI, with Open / Discard / Decide later, and waits.

**`file:///` and header injection reachable from the renderer.** Stream URLs and
HTTP headers arrive on a source object the renderer supplies and went straight
onto ffmpeg's command line. A `file:///` or `concat:` URL after `-i` reads local
files — and the frame server would then stream the result back out over
loopback. ffmpeg's `-headers` is one CRLF-delimited blob, so a newline in a
header value writes headers nobody asked for. Both now go through
`assertHttpUrl` and a shared `headerArgs()` that drops any name that is not a
token and any value containing a line break; the frame server also refuses a
non-http angle at registration rather than at decode time.

**The renderer could name any executable to spawn.** `advanced.ffmpegPath` and
its siblings are spawned, and the settings patch arrives as plain strings, so a
compromised renderer could point one at any file on disk and have it run on the
next export. The only legitimate way to set one is the file picker, so that is
now the only accepted source: anything else keeps the saved value. Clearing to
null is still allowed — it falls back to the bundled tool, which is a safe
direction.

**Combine progress no longer freezes at 94%.** A literal `0.9` overwrote the
real fraction. The total was already known — the sum of the parts' probed
durations, computed ten lines above for the faststart decision — so it is now
that division, on the export that takes longest.

**The capability flags are gone.** `metadata`, `playback`, `rangeDownload` and
`requiresAuth` were hardcoded `true` in all three adapters, read by nothing, and
documented as "shown to the user when a capability is false" when none of them
ever was. `requiresAuth: false` sat directly beside a note saying sub-only VODs
need an account. Deleted across 28 files; the notes, which are real and are
shown, stay.

**DRM now has its own error, decided first.** The YouTube adapter promised
"videos that YouTube serves only under DRM cannot be exported — Ripper Clipper
reports this instead of failing silently", and no DRM branch existed. There is
one now — and it runs *before* the sign-in branch, because yt-dlp's DRM message
mentions signing in, so DRM would otherwise tell people to go and configure
browser cookies for a video no cookie will ever unlock. The classifier was
extracted as a pure function so that ordering is tested rather than asserted.

---

## 3b. Deliberately not done

Three improvements from the first pass are **not** applied. Each needs the app
running to confirm, and this session cannot start it.

| | Why not |
|---|---|
| `sandbox: true` on the renderer | Not the one-liner it looks like. Sandboxed preloads cannot be ES modules, and this preload builds to `index.mjs`. Flipping the flag without converting the preload to CommonJS produces an app that does not start — and a broken preload is the one failure mode that cannot be recovered from inside the app. Worth doing, with a run to prove it. |
| Removing `disable-features: OutOfBlinkCors,BlockInsecurePrivateNetworkRequests` | The renderer loads from `localhost` and fetches the proxy on `127.0.0.1` — different origins to Chromium, and a private-network request. The switch is probably why playback works at all. The supported fix is answering the PNA preflight properly; both paths need playback tested to tell whether they worked. |
| Code splitting the 2148 KB renderer chunk | A startup optimisation, not a defect. A misplaced Suspense boundary is a white screen, which is exactly what cannot be checked from here. |

Everything else from the first pass is fixed. The remaining LOW items — three
benign `TODO`s that each name their missing infrastructure and refuse to invent
data, and hardcoded px type with no OS font-size support — are documented
choices rather than defects.

## 4. What is genuinely good

Worth stating, because an audit that only lists problems misrepresents the
thing.

- **No command injection anywhere.** Every child process goes through one helper
  with an explicit argv array and `shell: false`. No `exec()` with an
  interpolated string exists in the repo. yt-dlp calls use `--ignore-config` and
  a `--` terminator.
- **Filename handling is complete**: the full Windows character set, control
  characters, reserved device names (CON, PRN, LPT1…), trailing dots and spaces,
  a length cap, a non-empty fallback, per-segment re-checking, and collision
  handling that never overwrites. NTFS alternate data streams are impossible
  because `:` is stripped. Tested.
- **A 20-code typed error catalogue** that survives IPC intact — main wraps into
  a JSON envelope, preload unwraps into a titled error. Every code has a title, a
  what-happened sentence, a what-to-do sentence, and a `detail` field kept out of
  the UI. No raw exception reaches the user.
- **Progress is real.** Bytes/second from actual byte deltas over wall-clock, ETA
  from elapsed-vs-fraction, `totalBytes: null` when unknown rather than guessed.
  A failed export deletes its partial output and never reports success.
- **Colour is never the only signal** — all eight states carry a word and a
  glyph, `StatusDot` carries an sr-only label, and `IconButton` makes `label`
  mandatory in the type, so an unlabelled icon button cannot be written.
- **Reduced motion, focus-visible, empty/loading/error states** all present; the
  timeline canvas is a real `role="slider"` with full ARIA and key handling, not
  an inert rectangle.
- **Logging redacts structurally**: sensitive keys, every URL in every message,
  signed query params, and any value over 64 characters.
- **The tool installer verifies checksums** and fails closed, deleting the file
  on mismatch.
- **One `ponytail:` comment** in the whole repo, with its ceiling and upgrade
  path both named. That is a remarkably small debt ledger.

---

## 5. Measurements

**Bundle** (stable channel): renderer 2148 KB in a single chunk + 205 KB CSS;
main 397 KB; preload 13 KB. No source maps shipped, one `console.log` left,
no `localhost` literals. Editor tree-shake confirmed: the 81 KB editor chunk is
present with `RIPPER_EDITOR=1` and absent from `stable`.

**Decode capacity** — measured earlier this session on a 2-core sandbox with no
GPU, which is *not* the target hardware:

| tiles | per tile | memory (PSS) | startup |
|---|---|---|---|
| 8 | 30.6 fps | ~0.3 GB | fast |
| 16 | 31.3 fps | ~0.6 GB | fast |
| 40 | 19.7 fps | 1.47 GB | 6.1s |

The 2.5 GB figure in earlier notes was an artifact of `ps rss` double-counting
shared library pages; PSS says 1.47 GB. Both numbers need re-taking on the RTX
machine before they mean anything for release.

**What could not be measured here.** The device bridge exposes a 2-core Linux VM,
not the Windows host, so nothing in this audit ran on the RTX. A packaged
`electron-builder` run needs Windows and could not be executed either — the
newest installer on disk is from 28 Aug.

---

## 6. Screenshots

Captured live from the running dev build earlier in this session: the Watch
screen with the POV wall, the Angles picker open, and the timeline before and
after the HiDPI fix. Full-screen coverage of every page was **not** completed —
the dev build was closed part-way through and this session cannot start it
(no Windows shell), while the installed package is a 28 Aug build that predates
every fix in this report. Screenshotting that would have documented software
nobody should ship.

To finish this: `npm run dev`, then say so and I will walk every screen.

---

## 7. What is left, and it is all yours

The code is done. Three things need your machine, and the first is not optional.

1. **Run it.** `npm run dev`, then click through: the wall, an export, the queue
   Pause, Settings → Setup. This session changed the security boundary of two
   local servers, the window's navigation policy, the settings write path and
   the app's entry point, and **none of it has executed once.** 950 passing
   tests and a clean build say the code is consistent; they do not say the app
   starts.
2. **`_verify.bat` and a package build.** The newest installer on disk is
   28 Aug and predates every fix in this document.
3. **`stress.mts --tiles 40` and the POV wall on the RTX.** Every capacity
   number here comes from a 2-core VM with no GPU.

Then §3b, in that order, each with a run behind it.

---

## 8. After the first real run on the RTX (1 Sep)

`_verify.bat` on Windows: **945 passed, 5 skipped, TEST_EXIT=0, BUILD_EXIT=0.**
The code was fine. Running it found three things the tests could not.

### 8.1 I broke playback, and the tests could not see it

`playbackSrc` in the renderer was a **second, hand-written copy** of the
media-proxy URL template. When the proxy grew a per-run secret (§1.1), that copy
knew nothing about it, so every player URL would 403 — while the test suite
stayed green, because it only ever exercised the main-process builder.

Both halves now go through one `mediaProxyUrl()` in `shared/`, the token rides
in `envInfo` beside `mediaProxyBase`, and the token argument is **required** —
so the compiler found all four call sites rather than leaving one to be
discovered in a screenshot. A test now builds a URL the way the player does and
fetches it through the real proxy.

### 8.2 "Bad quality" — the tile decoded at 480×270 whatever its size

`frameServer` hardcoded `WIDTH = 480, HEIGHT = 270`, chosen for a wall of
twelve. With two angles on a 1440p monitor at 250% scaling, each tile is roughly
1900 device pixels wide — so the picture an editor judges a cut on was being
upscaled about four times.

The size now comes from the tile: `NativeFollower` measures its canvas in
*device* pixels (CSS pixels are what leaves the best screens softest) and asks
for that rung via `?h=`. `tileSizeFor` snaps to 270/360/540/720/1080 so an
ordinary resize does not restart the decoder, and the rendition picker uses the
same number, so a bigger tile also pulls a better rung. `FramePipeline.filter`
became a function of the size instead of a baked string.

This is self-limiting: twelve angles means small tiles means a low rung.

### 8.3 "Not smooth" — 13fps, and no way to know why

The on-tile readout said `13fps -466ms -57` and **that number existed nowhere
else**. Diagnosing it meant reading the corner of a screenshot. It is still
undiagnosed, and that is the honest state: it could be decode capacity, the
network feeding a rendition too large, or a fallback to the master playlist's
first variant (which is 1080p60 on most platforms).

So the logging went in first:

- `ui:tile` — what each angle opened with: drawn size, device pixel ratio, the
  rung it decodes at, and the pipeline.
- `ui:tile` — a warning whenever an angle drops below the target frame rate or
  slides more than a third of a second, with fps, drift, catch-ups, drops and
  reopens; and a matching line when it recovers, because "bad for ten seconds at
  startup" and "always bad" look identical after the fact.
- `frames` — the rendition chosen for each tile, with its height and bitrate,
  and a warning when no variant matched and the playlist is decoded as given.
- `proxy` — a warning on any refused media request. If that ever fires for the
  app's own player, §8.1 has happened again.
- `ui:crash` — renderer exceptions with their component stack, which the main
  process cannot otherwise see.

All of it through one `logEvent` channel rather than a channel per need.

**Next run should answer it in one line.** Open the wall, let it misbehave for
ten seconds, and send `_verify.log`'s sibling — the app log — which will now say
what each tile is decoding and how far behind it is.

### Still unexplained

A black band across the top of both tiles, with the picture bottom-aligned
rather than centred. Measured off the screenshot: tile 773px tall, picture
563px, 210px of black above and none below. The CSS says `place-items: center`
and `object-fit: contain` on both the leader's `<video>` and the follower's
canvas, which should centre. Not reproduced or fixed — noted here so it is not
lost.

---

## 9. `_diagnose.bat` — and what it found on its first run

A second double-click file beside `_verify.bat`. `_verify.bat` proves the code
is consistent; this proves what the machine actually *does*. It runs the app's
own `framePipeline`, `frameServer` and resolvers — nothing reimplemented, so a
number it prints is a number the app would get — and writes `_diagnose.log`:

- the machine: CPU, RAM, GPU by name
- ffmpeg's path, version and hardware encoders
- **every rendition each POV offers**, with bitrates, and which one each tile
  size would pull
- every decode chain **run** against the real stream, not asked about
- decode throughput at 270/360/540/720/1080, as a multiple of real time — below
  1.0× is a tile that cannot keep up
- the frame server end to end: first-frame latency, fps and MB/s per rung
- the app log from the run

It takes the newest project in `Documents\Ripper Clipper` automatically, or
`--project <file>` / `--url <vod>`.

### It found the "not smooth" bug on its first run

```
=== renditions offered ===
  not a master playlist — ffmpeg gets this exactly as it is
```

`VodSource.playbackUrl` was `best.url` — the **highest variant's** playlist, not
the master. So the player and the tile decoder were handed a media playlist with
exactly one rendition in it, and every mechanism for choosing a smaller one had
nothing to choose from: hls.js's `capLevelToPlayerSize` saw a single level, and
`variantForTile` never ran at all, because `isMasterPlaylist` was false.

**Every angle decoded 1080p60 at whatever size it was drawn**, on every wall,
on both the browser and the native path. That is what `13fps -466ms -57` was.

After the fix, the same command prints:

```
    tile  270p -> 360p @ 630 kbps
    tile  720p -> 720p @ 3484 kbps
    tile 1080p -> 1080p @ 8558 kbps
```

A small tile now pulls **630 kbps instead of 8558** — 13× less to fetch and a
fraction of the decode.

Two existing tests **asserted the bug**: `expect(source.playbackUrl)
.toContain('1080p60')` and `.toContain('/chunked/')`. They are why 950 passing
tests could coexist with a wall that would not play. Both now assert the master,
and `playbackRendition.test.ts` states the property directly.

### The harness lied once, and that is fixed too

Its first run reported `TOO SLOW FOR PLAYBACK` for five rungs where ffmpeg had
actually **segfaulted** — the same shape of wrong answer this whole exercise
exists to remove. It now reports the exit code, the signal and ffmpeg's own
first line, claims slowness only when frames genuinely arrived slowly, and flags
a pipeline that "failed" in under 50ms as not having run at all.

---

## 10. What the RTX actually said

`_verify.bat`: **955 passed, 5 skipped, 86 files, all three exits 0.**

`_diagnose.bat` on an i7-13700K / RTX 5070 Ti / 32 GB:

```
WORKS  NVDEC decode + scale_cuda (GPU throughout)  (1629ms)
chosen NVDEC decode + scale_cuda (GPU throughout)

rung   fps   speed   frames
 270p   367  12.23x     302
1080p   278   9.25x     302

basedLore @270p:  480x270,  first frame 0ms, 31.7 fps,  5.9 MB/s
basedLore @1080p: 1920x1080, first frame 0ms, 31.5 fps, 93.4 MB/s
```

**The machine was never the problem.** NVDEC works, decode runs at 9–12× real
time at every rung, and the frame server delivers a full 30fps at 1080p with
zero first-frame latency. `13fps -466ms -57` was not capacity.

### The wire cost, which changes the design

93.4 MB/s for **one** 1080p tile. Decoded frames cross uncompressed, so
"decode at the size it is drawn" — correct for two angles — would have made a
twelve-angle wall ask for over a gigabyte a second. The measurement arrived
before that shipped.

`tileSizeFor` now takes the number of decoding angles and shares one budget:
`WALL_BYTES_PER_SECOND = 120 MB/s`, derived from the measured single-tile
ceiling. That allows one tile at 1080p, two at 720p, four at 540p, eight at
360p, twelve at 360p — which is roughly what each of those walls wants to look
like anyway. The arithmetic is checked against the measurement in the tests: if
they ever diverge, the frames are not the size the code thinks they are.

### The fix did not reach the project that needed it

Every angle in `Dead.cookieclip` still read
`.../media/hls/1080p60/playlist.m3u8`, and the diagnostic said *"not a master
playlist"* nine times. `playbackUrl` is derived data **cached in the project
file**, and nothing re-resolves on open — so the resolver fix only helped POVs
added afterwards, and every existing project kept the bug forever.

Kick serves IVS, which puts every rendition in a sibling directory of the
master, so `masterPlaylistFor()` rewrites the stored URL on load with no
network and no guessing. Twitch's master lives on usher behind a signed token
and cannot be derived from a storage URL, so it returns null there rather than
inventing one — those need the POV re-added.

**Anyone with an existing project needs this**, and it is the difference
between the fix working for Reece today and working only for events he creates
tomorrow.

**972 tests, 87 files, typecheck clean, both bundles build.**

---

## 11. 60fps

The frame server forced `-r 30` for every tile. Kick publishes 1080p60 and
720p60; **every angle was being shown at half its frames**, on a machine that
decodes 1080p at nine times real time. That is its own kind of "not smooth" and
no amount of headroom fixes it — the frames were being thrown away on purpose.

The rate now comes from the rendition's own `FRAME-RATE`, capped at 60, and
travels to the client as `x-frame-fps`. `FramePump` adopts it from the response
rather than assuming, because deriving a timestamp by counting frames is only
right while both ends agree on the rate. The on-tile readout shows `48/60fps`
so a shortfall is legible instead of looking like the target.

### Rate and resolution are one decision

A 60fps tile costs twice a 30fps one on the wire, so the rate has to be inside
the budget rather than beside it. When the budget binds, **resolution gives way
before frame rate**: 720p60 and 1080p30 cost about the same, and for judging a
cut in a fast game the smoother one wins.

`_diagnose.bat` now prints the whole model:

```
   1 angles -> tile 1280x720@60  from  720p @ 3484 kbps  wire 79 MB/s each,  79 total
   2 angles -> tile  960x540@60  from  720p @ 3484 kbps  wire 44 MB/s each,  89 total
   4 angles -> tile  640x360@30  from  360p @  630 kbps  wire 10 MB/s each,  40 total
  12 angles -> tile  640x360@30  from  360p @  630 kbps  wire 10 MB/s each, 119 total
```

### It caught a bug in itself

The first version of that table read `4 angles -> 360p@60` — while the 360p
rendition Kick publishes is 30fps. Size and rate depend on each other: the rate
decides what resolution the budget allows, and the resolution decides which
rendition supplies the rate. Resolving it in one pass asked ffmpeg for 60fps
from a 30fps source, which CFR pads by duplicating every frame — twice the
bytes for no extra motion.

Both the server and the harness now settle it in two passes and take the rate
from the rendition **actually** chosen. A rate that falls at the last step only
leaves headroom unused, so it can never go over budget.

**975 tests, 87 files, typecheck clean, both bundles build.**

---

## 12. 8–16 angles, high fidelity, high frame rate

The ask was sixteen 1080p60 angles at once. The arithmetic says no, and it says
so definitively: raw NV12 is 187 MB/s per 1080p60 tile, so sixteen is
**2.99 GB/s** across loopback into JavaScript. No machine does that, and the
GPU is not why.

But "1080p per tile" was never the goal — *seeing what you are editing* is.
Sixteen tiles on a 2560×1440 screen are 640×360 each; decoding 1080p to draw
360p buys nothing until an angle is focused. So the target became: **8–16
angles, each as sharp as its own size allows, all at the source's frame rate.**
Three things were in the way.

### The wall was mostly black

Every tile draws a 16:9 picture inside a box the grid stretches to fill, so any
mismatch is letterboxing. Measured in a real browser against the shipped
stylesheet: **the picture was using 39% of the stage.**

`bestColumns(count, stageAspect)` now tries every column count and takes the
one that makes the picture widest, because which arrangement wins depends on
the shape of the space as well as the number of angles — two side by side waste
half the height on a tall stage and half the width on a wide one. Ties go to
the wider arrangement: on a 16:9 stage two angles are exactly the same size
stacked or side by side, and stacked reads as a mistake.

The stage is measured with a `ResizeObserver` rather than assumed.

**A phantom is also resolved:** §7 recorded a black band with the picture
bottom-aligned rather than centred. Rendering the real stylesheet in a real
browser shows it centres correctly. That was a misread of a screenshot, not a
bug, and it should not have been in the report as one.

### The frame rate was capped by the budget, not by the machine

At eight angles the fixed 120 MB/s budget forced 360p, and Kick's 360p
rendition is 30fps — so asking for more angles silently cost half the frames.

### The budget was a guess, and now it is a measurement

120 MB/s came from one machine. Every machine that runs this is a different
one, and a constant punishes whichever is not the one it was measured on.

`shared/wallQuality.ts` makes it the *starting point* instead. Each tile
reports fps, its target rate and drift once a second; any angle that cannot
hold its rate pulls the **whole wall** down a rung immediately, and ten
consecutive clean seconds earn one back. Down is instant because the person is
watching a stuttering wall now; up is slow because it costs a decoder restart
on every tile.

The wall moves together on purpose. Angles of one moment are for comparing, and
two tiles at different sharpness invite the conclusion that the softer camera
was worse — which is a lie the app would be telling.

That means an RTX climbs past what the constant allowed and a laptop settles
below it, with neither told in advance which it is.

**985 tests, 89 files, typecheck clean, both bundles build.**

### If it still is not enough

`_diagnose.bat` now measures the two ceilings separately: N concurrent NVDEC
decodes at 1/2/4/8/16, and a GPU mosaic — sixteen angles decoded, tiled with
`xstack_cuda` and re-encoded once, so the renderer decodes **one** video
instead of sixteen. If the decode column is healthy at 16 and the wall still is
not, the mosaic is the answer and the numbers will say so.
