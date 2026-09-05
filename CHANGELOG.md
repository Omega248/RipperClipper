# Changelog

## 1.6.3 — 5 September 2026

Everything 1.6.2 was meant to be. 1.6.2 was withdrawn before anyone had it:
its tag pointed at a commit that did not include all of the below, and
re-cutting the version was safer than moving a published tag.

### YouTube clips no longer come back dubbed

A clip cut from a YouTube video could arrive in the wrong language — German,
Malayalam, Spanish — because audio tracks were ranked on quality alone, and
YouTube encodes its automatic dubs at a marginally *higher* bitrate than the
original, so the ranking did not merely risk a dub, it reliably chose one.

The audio track the video was actually recorded in is now preferred before
quality is considered at all. On a video with twenty-two dubbed languages the
old ranking picked Malayalam, with the English original sitting twenty-seventh
of a hundred and ten candidates; it now picks the original.

Only a track the source positively marks as the original changes anything.
Twitch, Kick and single-track YouTube videos mark nothing, so they are ranked
exactly as before.


### Clear an event without making a new project

The POVs loaded are the wrong event, or were a first attempt, and you want to
start again — but keep the project file you already named, its output folder
and its export settings. **Project → Clear this event…** empties the POVs,
clips and markers and leaves the project itself alone.

It is one undo step, not one per POV. Sync anchors are kept on purpose: they
are tied to a VOD rather than to the event, so loading the same VOD again
gets its timing back immediately.

Undo also now covers the event block itself. Renaming an event and pressing
Ctrl+Z used to restore nothing and leave the new name in place.

## 1.6.1 — 2 September 2026

The application icon is the app's own mark now — the player frame and range bar
from the sidebar, in the accent purple — instead of the unrelated blue wave it
had been carrying. Same everywhere: the installer, the .exe, the taskbar and
the window.

Everything in 1.6.0 below is in this build; 1.6.0's installer was cut minutes
before the icon changed.

## 1.6.0 — 2 September 2026

### Hand a clip straight to an editor

A finished clip can now be sent to an editing application with the timeline
already built, every angle already synchronised and the watermark already
placed. **Send to an editor** on the clip panel.

- **DaVinci Resolve** — a generated Python script you run from Resolve's own
  Scripts menu. It creates the project, imports the angles into a bin, builds
  the timeline with one named track each (`POV | Twitch | Name`, not "Video 1"),
  and positions the watermark. Nothing is executed on your machine by the app.
- **Final Cut Pro** — FCPXML, Apple's documented interchange format, with the
  angles on lanes so they play together and the watermark as a transform.
- **Movavi** — Movavi publishes no project format, so no project file is
  invented. Instead you get the angles numbered in track order and a guide that
  says the thing that matters: every file was cut from the same instant, so drop
  them all at the start of the timeline and they are in sync. Only an angle that
  started recording late needs moving, and the CSV says how far.
- **Any other editor** — a portable folder with the media, the watermark, a
  JSON manifest and an HTML guide carrying every sync offset and the exact
  watermark numbers.

The export is references, numbers and a small PNG: twenty four-hour angles cost
the same to prepare as two ten-minute ones, because no frame of video is read.
Media is referenced where it already sits unless you ask for it to be copied.

### Exports are much faster

- **Watermarked clips composite on the GPU.** When the watermark is the only
  thing redrawing the picture, the chain is now NVDEC → `overlay_cuda` → NVENC
  with the frames never leaving the graphics card. The old path copied every
  frame out to system memory and back, which is why a watermarked cut ran at 2×
  realtime while an unwatermarked one finished at download speed.
- Falls back in three steps — GPU composite, then CPU composite with GPU
  encode, then software — so one unlucky driver is not a tenfold slowdown.
- Encoder presets moved for speed with the quality setting untouched: NVENC p5
  → p4, QSV to `faster`, x264/x265 `medium` → `veryfast`.
- Export notes now name the redraw that made a stream copy impossible.

### Finding other POVs

- **Fixed: the search read the crawled library instead of re-listing every
  channel.** Asking "who else filmed this" used to list all 45 saved channels
  live and then ask the platform for a date per broadcast — about a thousand
  requests, most of which YouTube answers with a bot check. The dates never
  arrived, and an undated VOD cannot be matched to a moment, so the search did
  the most work in exactly the case where it returned nothing. It now reads the
  shelf the background crawl has already built.
- **Fixed: the dialog re-ran its whole sweep on every render** — several times
  a second, for as long as it was open.
- **One angle per person.** A restreamer on Twitch, Kick and YouTube is one
  angle, not three. Twitch wins a tie, because its VODs are the ones that can be
  placed on the clock most reliably. Someone already on the wall is never
  offered again on another platform.

### Timeline

- Much taller by default, with a clips lane whose edges can actually be grabbed.
- **Filmstrip under the ruler** — frames from the broadcast, fetched one at a
  time and only for the segments they need, so a four-hour view does not
  download four hours.
- Fixed: the playhead stopped partway down when more angles were loaded than
  fitted on screen.

### Streamers

- **Add a streamer by name.** Previously the roster only grew as a side effect
  of loading a POV; there was no way to add a channel you had not clipped yet.
  A bare name is enough — Twitch, Kick and YouTube are each checked for it.
- The page no longer opens on an empty pane, the group chips line up with the
  header, and the detail line wraps instead of losing the end of itself.

### Interface

- Text is a step larger and heavier throughout — the scale started at 9.5px.
- The collapsed sidebar's icons sit on one axis. They were 12px left of centre,
  because each row is wrapped in a tooltip that was shrinking to the icon.
- The status bar no longer reports the encoder or an empty queue.

### Live

- Live broadcasts load as the recording the platform is already making, so they
  can be watched, clipped and exported while still on air.
