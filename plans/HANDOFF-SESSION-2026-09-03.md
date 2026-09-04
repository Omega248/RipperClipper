# Handoff — production hardening pass, 3 September 2026

A production-readiness pass over the whole repository: audit, fix, verify. Six
commits landed on `main`, all green. The pass is **incomplete** — twelve of the
sixteen planned audit dimensions never ran, and §"What was never audited" below
says exactly which. Nothing in here should be read as "the codebase has been
cleared"; it has been cleared *in the areas listed*.

---

## 0. First, the state of the working tree

**Uncommitted, passing, safe to commit:**

- `src/main/export/fcpxmlExporter.ts` — `safeName` now delegates to the shared
  `sanitizeFilename`.
- `tests/unit/projectExporters.test.ts` — new test: parses the generated
  FCPXML with a real XML parser, with a hostile project name.

Typecheck is clean and `projectExporters` + `generatedProjectEscaping` pass
(29 tests). The full suite has **not** been run since this edit — run it before
committing.

**Version control was re-attached this session.** The tree had no `.git`: it had
been left half-initialised (no refs, a stray `index.lock`) and moved to
`_to_delete/broken-git`. `origin` is now `https://github.com/Omega248/RipperClipper`
and `main` tracks it. `70bb762` records the tree as it was found, so everything
this session did is `git diff 70bb762`. **Nothing has been pushed.**

The committed `.gitignore` is upstream's, restored — the working copy had been
replaced by a six-line stub that no longer ignored `release/`,
`resources/bin/*`, `tests/.artifacts/` or `*.log`. Committing under that stub
would have added ~1.2 GB of installers and fetched binaries to the repository.

---

## 1. Baseline, and what it is now

|                | Before | After |
|----------------|--------|-------|
| Tests          | 1048 passing, 5 skipped, 101 files | 1065 passing, 5 skipped, 104 files |
| Typecheck      | clean (both configs) | clean |
| Production build | main 447 kB, renderer 2,236 kB JS + 216 kB CSS | main 456 kB, renderer 2,238 kB JS |
| Unhandled errors in the test run | 1–2 intermittent | none |
| Time to window | tool detection blocked it | 1,834 ms / 3,303 ms measured |

The app was also **run on Windows and driven to a clean shutdown**, which the
1.5.0 audit explicitly could not do. Startup and shutdown are verified against
a real profile, not inferred.

---

## 2. What was fixed (committed)

Two of these were blockers.

**Audio edits never reached ffmpeg** (`0f15d97`). Every mute, bleep and duck
drawn in Properties was absent from the exported file, with no note and no
error. `EnqueueRequest.clips[].audioEdits` is declared and the whole main-side
chain supports it, but `exportClips` built its request literal by naming fields
and this one was not among them; `withAudioPovStreams` then rebuilt each clip
the same way, dropping it a second time for any clip whose sound comes from
another POV — the case the feature is most useful in.
`tests/integration/audioEdits.test.ts` calls `exportClip` directly, so a green
suite reported a feature that did nothing. The renderer now also filters edits
to the POV supplying the sound and shifts them by the export's safety margin
(padding moves the file's start earlier than the clip's, so unshifted gates land
early). Guarded by `tests/unit/audioEditsReachExport.test.ts`, which was
confirmed to fail against the pre-fix source.

**Shutdown ran before the user was asked** (`0f15d97`). This was a regression
introduced earlier in the session and caught by the audit. Electron emits
`before-quit` *before* it closes any window, so the whole irreversible teardown
ran before the confirmation dialog appeared — the export the dialog offered to
keep was already aborted and its part-written file already deleted. Answering
Cancel left the app running but gutted: the queue's `stopping` flag is one-way,
the crawler is never restarted, the local server the renderer is *served from*
was closed, and the log stream was shut. Moved to `will-quit`.

**Live clips took the wrong POV's sound** (`4c925e6`). The audio fetch is
skipped for a live source because a live segment is muxed — true of the POV
supplying the picture, false of any other. With no audio window, `muxed`
resolved to true and the cut mapped the picture POV's own audio. Nothing
reported it; `verify` compares durations, not content. The live fixture now runs
a **second angle built from the same segments rotated**, so the two POVs are
never showing the same thing at the same instant; with the fix disabled the test
fails with 294 Hz where 392 Hz was asked for.

Also in `6095c30`:

- **Preview builds shared one file.** `ensure()` fetched its source window to a
  fixed `preview-src.<ext>` in a process-wide directory, so two clips from the
  same VOD truncated and interleaved into each other. The wrong footage was then
  cached under a content hash and reused in every later session.
- **A file descriptor leaked per abandoned request.** Three
  `createReadStream(...).pipe(res)` in the local server; `pipe` only unpipes on
  abort, which pauses rather than destroys. The preview prune then deleted files
  whose handles were open, so the space never came back and the cache budget
  silently stopped bounding anything.
- **Ghost jobs.** `enqueue()` registered every clip before checking disk space,
  so a batch rejected for space stayed runnable with no jobs event emitted.
- **A stall was reported as a cancellation.** `run()` set the same `aborted`
  flag for an idle-timeout kill, so a wedged ffmpeg was filed as "Cancelled" —
  not retryable, removed by Clear finished. `runChecked` also returned it as
  success, which is how `keyframes()` turned a stall into "no keyframes" and
  forced a full re-encode.
- **The logger could take the app down.** No `error` listener on the write
  stream, and the uncaught-exception handler reports by calling `log.error`.

And: the shutdown sweep named two directories nothing creates while four real
ones were never swept (scratch names are declared once now); the range-fetcher's
playlist cache was unbounded and could not converge (keyed on a per-resolve
signed URL); the bleep tone was plumbing with no source; `atomicWriteJson` now
fsyncs before publishing (`fbe6e3d`); 53 rules / 7,156 bytes of stylesheet for
removed features are gone (`2c0fb03`).

**Startup** (`0626b53`): `detectEnvironment(true)` was awaited before
`createWindow()`. It spawns three processes and yt-dlp alone takes ~1.7 s. It
now runs beside the window and `envInfo` awaits it, so the answer is still
correct when anything asks. The renderer's startup batch no longer includes
`env()` either — one `Promise.all` meant three external programs held back six
local file reads that had already finished.

---

## 3. Audited and found sound — do not re-audit

- **Accessibility.** Focus trap, Escape, focus return, `aria-modal`,
  `role="dialog"`; `prefers-reduced-motion` honoured in six places;
  `IconButton`'s `label` is mandatory in the type and feeds both `aria-label`
  and the tooltip (0 violations); 0 click handlers without a keyboard path.
- **The security surface the 1.5.0 audit closed.** Proxy token uses
  `timingSafeEqual` with a length guard; `/local` resolves ids through a Map,
  not a path; `/watermark/` is `basename()`-only; static serving does a correct
  containment check. Only gap found was an unclamped Range header, now fixed.
- **`is-*` CSS classes that read as dead.** They are built at runtime as
  `` `is-${tone}` ``, `` `is-${state}` ``, `` `is-${platform}` `` — the literal
  never appears in source. Do not delete them.
- **`.titem-trim-start` / `-end`.** Unused hooks, not a defect: `.titem-trim`
  positions by flex order.

---

## 4. Next actions, highest value first

**a. Finish the sanitiser convergence (in progress).** Three copies of an
incomplete filename sanitiser exist; all strip the characters Windows forbids
but not control characters, and all three build filesystem paths from
user-controlled names. A NUL byte makes the call throw a Node `TypeError`
instead of producing a file. `shared/filenames.ts`'s `sanitizeFilename` already
handles control characters, reserved device names, trailing dots and length.

- `src/main/export/fcpxmlExporter.ts:107` — **done** (uncommitted).
- `src/main/export/projectExporters.ts:45` (`freeDirectory`) — **still to do**.
- `src/main/index.ts` package-export default filename — **still to do**.

**b. Nine audit findings, one verified, eight unverified.** Verification agents
ran out of session budget. Only the first was confirmed (2/2 votes); treat the
rest as leads to check, not as facts.

| Verified | File | What |
|---|---|---|
| ✅ 2/2 | `media/liveBuffer.ts:320` | The no-`PROGRAM-DATE-TIME` fallback stamps `startEpoch` from the buffer's extent, not the clock, so a batch of segments gets *decreasing* epochs and `bufferCovers` becomes unsatisfiable. Both verifiers narrowed it: latency plateaus rather than growing forever, and `latencySeconds` has no renderer consumer. Only reachable on live HLS without PDT — Twitch, Kick and YouTube all stamp it. Fix: `segment.programDateTime ?? this.now() - segment.durationSeconds`. |

Unverified candidates, worth checking in this order:

- `main/index.ts:1014` (claimed **blocker**, security) — `IPC.projectSave` writes
  renderer-controlled JSON to a renderer-controlled path; claimed to reach
  `settings.json` and re-open the executable-path hole 1.5.0 closed. Verify
  first; if real it is the most serious thing outstanding.
- `services/watermarks.ts:61` — `watermarkAddPng` writes arbitrary base64 bytes
  with no PNG magic check.
- `media/exporter.ts:1180` — `ResolvedWatermark.imagePath` crosses IPC
  unvalidated onto ffmpeg's argv as `-i`. Suggested fix is to rebuild the
  watermark from `imageId` in the handlers rather than trust the path.
- `shared/live.ts:243` — a failed segment download leaves an invisible hole;
  `bufferCovers` only checks endpoints, so a clip is silently cut short and
  time-shifted.
- `main/index.ts:363` — `findArchiveFor` reads a listing that filters out
  exactly the in-progress recording it is looking for.
- `renderer/src/App.tsx:394` — a renderer reload orphans live buffers in the
  main process; media and poll timers survive with nothing able to stop them.
- `media/liveBuffer.ts:277` — the media playlist URL is resolved once, so a
  signed URL expiring mid-broadcast leaves the buffer reconnecting forever.
- `services/live.ts:158` — `MAX_LIVE_RESIDENT_BYTES` is documented as
  application-wide but enforced per buffer; the cross-source guard uses a
  hardcoded bitrate guess.

**c. Re-run the audit for the twelve dimensions that never ran** (below).

---

## 5. What was never audited

Both audit runs were killed by API capacity, not by anything about the code. The
first launched sixteen agents at once and every one returned 529; the second was
rebatched to two at a time with retries and still lost most dimensions to a
session limit. **Four dimensions completed: `lifecycle`, `export-pipeline`,
`live`, `security`.**

Never ran, and therefore entirely unexamined by the audit:

`persistence` · `project-export` · `store` · `react-correctness` ·
`render-perf` · `design-system` · `a11y`\* · `shared-logic` · `dead-code` ·
`errors` · `timeline-editor` · `platforms`

\* `a11y` and parts of `security`, `persistence`, `dead-code` and
`project-export` were covered by hand instead — see §3 and §2 — but not to the
depth a dimension agent would reach.

The script is at
`~/.claude/projects/C--RipperClipper-main/<session>/workflows/scripts/audit-batched.js`
with a `REMAINING` set at the top; drop the completed keys and re-invoke. It
must have LF line endings or the permission layer rejects it.

**In particular, nothing has examined the renderer's React lifecycle, the
Zustand store, render performance, or the timeline editor** — the three largest
and most interactive files in the codebase (`App.tsx` 2,201 lines, `store.ts`
1,873, `TimelineEditor.tsx` 1,447). That is where the remaining risk is
concentrated.

---

## 6. Things deliberately not done

- **The 2.2 MB renderer chunk is still one chunk.** The 1.5.0 audit declined to
  split it because a misplaced Suspense boundary is a white screen; that reason
  still holds, though the app can now be run and checked, so it is doable.
- **`sandbox: true`** and **removing the `disable-features` switch** — both
  still open from 1.5.0, both need playback tested.
- **`sanitizeFilename` can split a surrogate pair** at its 150-character cap,
  putting a lone surrogate in a filename. Theoretical, cosmetic, left alone.
- **The `.rcpkg` reader still only shape-checks.** `readPackage` accepts any
  non-empty string as a project name and casts `clips`/`sources` through with
  `as`. The escaping fixes mean a hostile name can no longer break the generated
  Python or XML, but malformed clip data still enters the app unvalidated. This
  is the boundary §15 of the brief asks for and it is not there yet.

---

## 7. One thing to know

`npm start` / `electron-vite preview` **rebuilds on the stable channel** before
launching, which silently discards a `build:dev` and points the app at the real
`cookie-clipper` profile. One run this session did that and refreshed the real
VOD library (47 streamers). To run an isolated instance: `npm run build:dev`
then `npx electron .` — that keeps `__CHANNEL__` at `dev` and userData at
`cookie-clipper-dev`.
