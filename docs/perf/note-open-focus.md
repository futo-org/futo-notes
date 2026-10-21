# Opening a note and tapping into it — 2026-10-08

Lane `hc-open-focus`, off `editor-hillclimb-faster` at `13021342d`. Two changes to
progressive open (`src/features/editor/milkdown/`), one measured non-change:

1. **The interaction hold.** While a large note's tail is still streaming, a
   pointer down, focus or key in the editor holds the next idle slice until
   150 ms after the last such event (`interactionHold.ts`,
   `createYieldingIdleScheduler` in `progressiveLoad.ts`). The serializer's
   idle cache priming yields the same way.
2. **A viewport-sized first chunk.** The synchronous first chunk was a fixed
   80-line budget. It is now a screen and a half of lines at an estimated 24 px a
   line, clamped to 30–160, with 80 when the viewport cannot be measured
   (`firstChunkLinesForViewport` in `markdownChunks.ts`).
3. **No read-ahead in the Android shell.** The native disk read is under a tenth
   of an open, so prefetching it was not built (numbers below).

> **Result:** tapping into a note whose tail is still streaming went from a
> median of **332 ms to 68 ms** on the 13,877-line real note (p90 514 → 104 ms),
> and the first keystroke after that tap from **70 ms to 17 ms** (p90 132 → 19 ms),
> on an emulator with Chromium's CPU throttle at 6x. Time-to-interactive moved a
> little the right way. The first focus after a FULLY loaded note did not move;
> neither change touches it.

## Why the tap was slow

`requestIdleCallback` carries a 200 ms timeout so a busy page cannot starve the
stream. On a slow phone the frames after a tap are already long (caret
placement, the editable's focus work, the keyboard inset relayout), so the
timeout fires inside them and parks a whole tail-chunk parse between the finger
and the caret. A tail chunk is up to 500 source lines; at 6x throttle one costs
hundreds of milliseconds.

The hold only stops a slice from STARTING in that window. A slice already
running when the finger lands still finishes first, so a tap that lands mid-slice
still waits for it. Smaller tail chunks would be the next lever for that case;
this lane did not change the tail chunk size.

## Method

`tests/android-editor-perf-quick.mjs` serves `editor.html` to the phone's own
Chrome over `adb reverse` and measures over the DevTools protocol; `--cpu-throttle 6`
(added in this lane) applies Chromium's CPU throttle so an x86 emulator stands
in for the budget reference phone. Throttled numbers are a ratio, not a phone:
compare them only with each other.

Each round ran, per bundle:

- the quick runner on `1000-lines-blocks`, `10000-lines-blocks` (25 keystroke
  samples) and `real-note` (12 samples): interactive-first-viewport, open
  complete, first focus after the open completes, keystroke p95;
- a probe that does what the quick runner cannot: focus the editor one frame
  after `setContent`, while the tail is still streaming, time three frames, then
  time one keystroke into the still-streaming document. 6 reps per synthetic
  fixture, 4 for the real note.

Base and after bundles were built once and swapped per run, interleaved
base/after/base/after. Base ran 6 rounds and after 5 (one after-round was lost to
a full disk, below). Tables pool every round: `median / p90`, with `n` the sample
count.

`real-note` is the maintainer's 13,877-line, 907 KB note
(`tests/editor-gauntlet/local/device-perf-note.md`, gitignored), the note whose
first focus was the 1,132 ms red on the reference phone.

**Machine.** Linux host, AVD `futo-hc-open` (Android 16 x86_64 Google APIs,
720×1600, Chrome viewport 696 CSS px, so the first chunk is 44 lines instead of
80). Up to four other lanes ran emulators and builds at the same time: the
1-minute load average ranged from 1.5 to 91 across the runs (median 23 for both
bundles). Midway, host swap filled, the AVD's virtual CPUs hung, and it was
cold-rebooted; three of the base/after pairs come from before the reboot and
three from after. Interleaving is what keeps the comparison fair under that
noise. An earlier, abandoned A/B in this lane ran base at load 26 and after at
load 12; its numbers are not used.

## Before and after (6x CPU throttle, emulator)

### real-note (13,877 lines)

| metric                             | base                    | after                   |
| ---------------------------------- | ----------------------- | ----------------------- |
| interactive-first-viewport         | 224 / 572 ms (n=6)      | 203 / 355 ms (n=5)      |
| open complete                      | 9,466 / 28,245 ms (n=6) | 9,407 / 12,479 ms (n=5) |
| first focus, after open complete   | 338 / 1,812 ms (n=6)    | 328 / 369 ms (n=5)      |
| keystroke p95, after open complete | 11 / 41 ms (n=6)        | 15 / 20 ms (n=5)        |
| **focus while streaming**          | **332 / 514 ms (n=20)** | **68 / 104 ms (n=20)**  |
| **keystroke while streaming**      | **70 / 132 ms (n=20)**  | **17 / 19 ms (n=20)**   |

### 10000-lines-blocks

| metric                             | base                    | after                  |
| ---------------------------------- | ----------------------- | ---------------------- |
| interactive-first-viewport         | 64 / 68 ms (n=6)        | 52 / 55 ms (n=5)       |
| open complete                      | 4,064 / 7,816 ms (n=6)  | 4,071 / 4,511 ms (n=5) |
| first focus, after open complete   | 212 / 444 ms (n=6)      | 242 / 402 ms (n=5)     |
| keystroke p95, after open complete | 3 / 31 ms (n=6)         | 3 / 4 ms (n=5)         |
| **focus while streaming**          | **161 / 563 ms (n=36)** | **50 / 54 ms (n=30)**  |
| **keystroke while streaming**      | **28 / 103 ms (n=36)**  | **17 / 18 ms (n=30)**  |

### 1000-lines-blocks

| metric                             | base                      | after                  |
| ---------------------------------- | ------------------------- | ---------------------- |
| interactive-first-viewport         | 101 / 321 ms (n=6)        | 91 / 108 ms (n=5)      |
| open complete                      | 419 / 968 ms (n=6)        | 426 / 510 ms (n=5)     |
| first focus, after open complete   | 103 / 221 ms (n=6)        | 95 / 145 ms (n=5)      |
| keystroke p95, after open complete | 4 / 7 ms (n=6)            | 3 / 4 ms (n=5)         |
| **focus while streaming**          | **172 / 1,609 ms (n=36)** | **51 / 109 ms (n=30)** |
| **keystroke while streaming**      | **27 / 244 ms (n=36)**    | **17 / 20 ms (n=30)**  |

Reading the tables:

- The while-streaming rows are the hold's. The interactive row is the first
  chunk's: it is the only metric chunk 0's size can move. Both changes were in
  the one "after" bundle, so this split is by mechanism, not separately measured.
- A keystroke at 17 ms is one frame: the keystroke landed in the next frame.
- The after-complete rows (first focus, keystroke p95) are flat within noise, as
  expected. The 1,132 ms first-focus red on the reference phone is, as far as
  these runs show, Chromium's editable-focus work over the fully rendered
  document (not profiled on the phone in this lane); neither change touches it.
  What changes is the common case on a slow phone, where a 13k-line note's
  tail streams for 10–30 s and the user taps long before it ends.
- Open complete is unchanged at the median. The hold delays slices only while
  the user is touching the editor, and the probes touch it once.

## The shell's share of an open (Android, unthrottled)

Measured with temporary debug-only logcat marks in the native app (removed, never
committed): note-row tap, the open `LaunchedEffect` in `NoteEditorScreen.kt`,
`store.read`, the `setContent` push into the WebView, and the bundle's
`documentLoaded` message, which the editor posts right after chunk 0 is mounted.
Six opens per note from the note list, debug APK, same emulator, no CPU throttle.
`median / p90`, milliseconds:

| note              | tap → effect | `store.read` | read → push | push → `documentLoaded` | tap → `documentLoaded` | read share |
| ----------------- | ------------ | ------------ | ----------- | ----------------------- | ---------------------- | ---------- |
| 2-line note       | 37.9 / 66.4  | 1.4 / 4.5    | 2.4 / 92.3  | 42.7 / 44.1             | 83.0 / 204.6           | 2%         |
| 1,000 lines       | 30.3 / 33.6  | 3.7 / 6.4    | 10.8 / 13.1 | 18.6 / 25.8             | 56.4 / 69.6            | 7%         |
| 10,000 lines      | 32.1 / 33.1  | 5.9 / 7.1    | 13.3 / 14.8 | 21.1 / 48.4             | 65.9 / 89.6            | 9%         |
| real note, 907 KB | 30.2 / 33.6  | 4.6 / 6.6    | 12.9 / 14.7 | 66.6 / 67.4             | 111.3 / 116.3          | 4%         |

The Rust read of a 907 KB note is about 5 ms. Prefetching it on press could save
at most that, so read-ahead was not built. The larger shell costs are the ~30 ms
from tap to the open effect (navigation and composition) and, for the real note,
the push itself (quoting 900 KB into a `evaluateJavascript` string plus chunk 0).
Those are where shell work would go next. Caveat: the native side is not
throttled here, so on the reference phone every column is several times larger.
The share is what carries over, not the milliseconds.

## Correctness

- `progressiveLoad.test.ts`: the yielding scheduler is the plain one when nothing
  is held, waits a frame at a time while held, defers an idle callback that fires
  while held (the timeout case), cancels whichever wait is pending, and keeps a
  progressive load to exactly one completion.
- `interactionHold.test.ts`: the settle window, re-arming, the 1 s cap on an
  unbroken run, and attach/detach on the DOM events.
- `markdownChunks.test.ts`: viewport sizing, clamping, the fallback, and that only
  the first cut moves: every chunk still joins back to the input.
- `tests/editor-embed-milkdown-progressive-open.spec.ts` "a focus while the tail streams holds
  the next chunk until the focus settles": a MutationObserver times the first
  streamed append after a focus. Against the base bundle it landed 21 ms after
  the focus (fails); with the hold, at least 150 ms. Then the open completes
  exactly once, with no `change` message and the host's bytes back.
- `just chunk-census --limit 3000`: every one of the 2,868 notes that took the
  progressive path parsed identically chunked and whole. The census cuts at
  every safe boundary, so it covers any first-chunk size the viewport picks.

## Reproduce

```sh
# Bundles: build once per revision, copy aside.
node_modules/.bin/vite build --config vite.editor.config.ts
cp build/native-editor/editor.html /tmp/after-editor.html

# One round, one bundle (copy it into build/native-editor/editor.html first).
ANDROID_SERIAL=<serial> node tests/android-editor-perf-quick.mjs --no-build \
  --cpu-throttle 6 --fixture 1000-lines-blocks --fixture 10000-lines-blocks --samples 25
ANDROID_SERIAL=<serial> node tests/android-editor-perf-quick.mjs --no-build \
  --cpu-throttle 6 --fixture real-note --samples 12
```

```sh
# The focus-while-streaming probe.
ANDROID_SERIAL=<serial> node tests/android-editor-perf-quick.mjs --no-build \
  --cpu-throttle 6 --eval-file scripts/perf/focus-during-stream.js \
  --fixture 1000-lines-blocks --fixture 10000-lines-blocks
```

Per fixture it empties the editor, calls `setContent`, waits one frame, focuses
and times three frames, dispatches one keystroke and times the next frame, then
waits for `futo:editor-open-complete`.
