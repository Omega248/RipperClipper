# Spike — is native decode worth it?

The question: the POV wall decodes through the browser's media stack. Would a
native player (libmpv / FFmpeg) be enough faster to justify replacing it?

Nobody should answer that from instinct, and a benchmark run on different
hardware against different streams answers nothing. So both halves measure
**your machine, your streams**.

## Half 1 — what the wall costs now

1. Open the event and get the POVs playing on **Watch**, with every angle you
   actually want to test showing.
2. **Settings → Diagnostics → Playback benchmark → Run 30-second benchmark.**
3. Copy the result.

It samples every decoding `<video>` once a second alongside Electron's own
per-process CPU and memory. Dropped frames are the number that matters most —
CPU can look fine while the compositor is quietly discarding a third of the
picture, and that is what "the wall feels heavy" actually is.

## Half 2 — what native decode costs

From the repo root, with the same streams live:

```
node scripts/spike-native-decode.mjs --project "C:\path\to\Your Event.cookieclip"
```

or pass the channel URLs directly:

```
node scripts/spike-native-decode.mjs https://kick.com/a https://kick.com/b ...
```

Options: `--seconds 30`, `--no-hw` (software decode, to see what the GPU is
buying), `--ffmpeg <path>`, `--ytdlp <path>`. It finds the bundled tools in
`resources/bin` on its own.

It resolves each page to a direct stream with yt-dlp, then decodes them all
with `ffmpeg -hwaccel auto … -f null -` and samples the process tree.

**Decoding to null is not a player** — there is no compositing and no
presentation. That is deliberate: it is the *floor*. If the floor is not
meaningfully below what the browser already does, no native player built on
top of it can be either, and the rewrite is dead without anyone writing one.

## Reading the answer

Compare CPU and memory for the same number of streams.

- **Native ≥2–3× cheaper, or the wall is dropping frames while native is not** →
  the case is made. Next step is libmpv behind the existing UI: a layer swap,
  not a rewrite. Adapters, range fetcher, export pipeline and project format
  are untouched.
- **Within ~30%** → the browser is not the bottleneck. Spend the effort on the
  known backlog instead: bound the warm decoder pool in `TimelineLivePlayer`,
  split the renderer bundle, add `React.memo`, stop the canvas repainting on
  every mouse move.
- **A local file was used by mistake** → it decodes at ~30× real time and is
  gone before the first sample. Only live streams measure anything.

## Note on the bundle

Measured while setting this up: of the 2.17 MB renderer bundle, hls.js is
604 KB and React 132 KB — the rest is this app's own source. The weight is not
framework bloat, so no framework change makes it smaller.

## Throwaway

`scripts/spike-native-decode.mjs` and `components/PlaybackBenchmark.tsx` (plus
its `app:metrics` IPC) exist to settle this one question. Delete them once it
is settled — or keep the benchmark as the before-measurement for whatever
replaces the player.
