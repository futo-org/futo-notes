# Block drag — baseline and budgets

Measured 2026-10-08 so the block drag has a fixed hill to climb and a gate that says when it
rolls back down. Re-run with `scripts/perf/block-drag-bench.mjs`; the verdict mode is
`--budget`. Earlier drag work (the reflow curtain outside the scroll box, the arm-class restyle
fix in cd4fd392b) recorded its numbers only in commit bodies and session notes; this file is
where they live from now on.

> **Result:** pointer moves now reach the drag session once per animation frame. On the
> Android emulator, where Chromium already delivers about one move a frame, the real app is
> unchanged within noise and passes every budget before and after. The engine the change is
> for, WebKit, was **not measured after the change**: the desktop session locked mid-lane and
> the WebKitGTK bench gets no frames from a locked screen. Measuring it surfaced a real bug,
> fixed here: after the host's `setContent`, every block drag showed the drop line instead of
> the reflow preview.

## The budgets

`scripts/perf/block-drag-bench/budget.mjs`, `DRAG_BUDGET_MS`. They are reference-phone budgets
(moto g play 2023, Android 13, System WebView, the low-end device
docs/plan/milkdown-transition.md measures against) and are held on every target the bench runs
on.

| Phase     |  Budget | What it is                                                                |
| --------- | ------: | ------------------------------------------------------------------------- |
| lift      |  100 ms | the frame that carries the lift (long press fired → ghost up)             |
| frame p95 | 16.7 ms | the 95th-percentile frame while the finger drags with the scroller moving |
| drop      |  150 ms | the frame that carries the commit (release → document re-laid out)        |

`node scripts/perf/block-drag-bench.mjs --budget …` prints a verdict per variant, size and
phase and exits non-zero on a miss. A phase the chosen mode does not measure prints as
`skip`, never as a pass (M11); a run that measured nothing fails.

**Frame-clock slack.** Every frame figure is the interval between two animation frames. A
run that never misses a 60 Hz vsync still reads 16.9–17.4 ms at its p95 (the emulator,
idle), so a literal 16.7 ms limit failed every smooth run. The frame budget is judged with
`FRAME_CLOCK_SLACK_MS` (2 ms) on top, printed in the verdict line. A dropped frame reads at
least 33 ms, so the slack cannot pass one.

## What changed in this round

**Pointer moves are coalesced to one session move per animation frame** in both gestures:
the ⠿ handle's (`handleBlockDrag.ts`) and the long press's (`mobileBlockDnd.ts`). Before, every
`pointermove` reached `BlockDragSession.move`, which reads geometry and redraws the ghost, the
indicator or the curtain. WebKit (WebKitGTK on Linux, WebKit on macOS, WKWebView on iOS)
delivers every move the device produces: a 1000 Hz mouse is sixteen a frame at 60 Hz, a
120 Hz touch digitizer two. Chromium (Android's WebView) already aligns pointer events to
frames, so there the change should be close to a no-op, and the emulator numbers below agree.

What stays per event: the lift threshold and arming (both gestures), the scroll-cancel
distance before a lift, and the touchend fallback's last position. The release commits at its
own position and cancels the pending frame, so a frame cut short by it is dropped, not drawn
late; the slot is judged against the blocks as last drawn (13021342d). The boundary haptic
ticks once per frame that lands in a new gap: a gap the finger entered and left between two
frames, which was never drawn, no longer ticks.

Locked by `handleBlockDrag.test.ts` → "the moves of one frame reach the session once" and
`mobileBlockDnd.test.ts` → "one session move per frame" (coalescing, drop position) and
"ticks the boundary haptic once per new gap a frame lands in". All three fail on the base
files.

**The reflow preview no longer turns itself off after a content replace.** The curtain matched
the editor's DOM blocks to the document by node identity at lift. ProseMirror keeps a block's
DOM and view descriptor when the new document has an equal block there, without pointing the
descriptor at the new node object. So after the host's `setContent`, every block except the
ones that changed failed the test, and each later drag quietly fell back to the drop line. The
check is now identity or `eq`. Locked by `tests/editor-embed-milkdown-gutter-handle-mid-drag.spec.ts` → "a drag after
the host replaces the content still previews by reflow", which fails without the fix. This is
what the whole-app bench's preview-mode check kept tripping on (first drag on a page `reflow`,
every later one `line`); it was not load. The Android device bench never hit it: it sets the content to empty before
each note, so no block's DOM survives to be reused.

## How to A/B the gesture layer

The bench's variants swap `blockDragSession.ts` only. `--gestures <dir>` serves
`<dir>/handleBlockDrag.ts` and `<dir>/mobileBlockDnd.ts` instead of the working tree's, so the
base and the change run from one checkout without touching it:

```sh
mkdir -p /tmp/base-gestures
for f in handleBlockDrag.ts mobileBlockDnd.ts; do
  git show 13021342d:src/features/editor/milkdown/$f > /tmp/base-gestures/$f
done
node scripts/perf/block-drag-bench.mjs --device android-app --sizes 1000,3000 --repeat 3 \
  --budget --json before-1.json --gestures /tmp/base-gestures current
node scripts/perf/block-drag-bench.mjs --device android-app --sizes 1000,3000 --repeat 3 \
  --budget --json after-1.json current
```

Interleave the two, several rounds. `--json` keeps each run's raw result; the tables below
take each run's value (a single frame, or the run's own p95 for frame rows) and report the
median and p90 across all runs.

## Real Android app (emulator)

Pool emulator futo-qa-5 (Android 16, System WebView 133.0.6943.137, 720×1600), the real dev
app built and installed per side, driven over CDP with real touch input
(`block-drag-bench/app-device.mjs`). Reflow preview (`current`). Three interleaved rounds of
before then after, three runs each: **n = 9 per cell**. Host load average was 5–9 for rounds
1–2 and spiked to 35–94 in round 3 (other lanes building).

ms; median and p90 across runs:

| blocks | phase            | before median | before p90 | after median | after p90 |
| -----: | ---------------- | ------------: | ---------: | -----------: | --------: |
|  1,000 | lift frame       |          16.9 |       22.4 |         16.9 |      33.4 |
|  1,000 | gap frame p95    |          17.7 |       18.1 |         17.0 |      17.4 |
|  1,000 | scroll frame p95 |          16.9 |       17.1 |         16.9 |      17.1 |
|  1,000 | drop frame       |          17.1 |       38.5 |         17.3 |      32.2 |
|  3,000 | lift frame       |          18.7 |       22.0 |         18.1 |      19.7 |
|  3,000 | gap frame p95    |          17.7 |       18.2 |         17.0 |      17.1 |
|  3,000 | scroll frame p95 |          16.9 |       17.1 |         16.9 |      17.1 |
|  3,000 | drop frame       |          41.8 |       50.5 |         37.0 |      39.5 |

`--budget` passed in all six runs, before and after. The gap-frame p95 dropping 0.7 ms is the
one consistent move: the bench's finger moves every 12 ms, faster than the 16.7 ms frame, so
some frames did carry two moves. Everything else is inside the frame clock's jitter. The lift
and drop p90s swing with the round-3 load spike, not with the side.

## Desktop, WebKitGTK

### The editor page

`node scripts/perf/block-drag-bench.mjs --sizes 1000,3000 --repeat 5`. This page calls
`BlockDragSession` directly, so **neither change is on its path**: the two runs are the same
code, taken while other lanes built on the same host (load average 17–30 on 32 threads).
Read them as one baseline under load, with the spread between them as the noise. 1280×800 at
DPR 2, vsync 16 ms; ms per operation, median over 5 runs:

| blocks | phase            | line, run 1 | line, run 2 | reflow, run 1 | reflow, run 2 |
| -----: | ---------------- | ----------: | ----------: | ------------: | ------------: |
|  1,000 | lift frame       |        65.8 |        72.8 |          42.0 |          33.8 |
|  1,000 | gap change       |         0.2 |         0.2 |           0.3 |           0.2 |
|  1,000 | gap frame p95    |        43.0 |        54.0 |          47.0 |          29.0 |
|  1,000 | scroll frame p95 |        41.0 |        50.0 |          37.0 |          36.0 |
|  1,000 | drop             |         8.3 |         8.8 |           6.5 |           4.5 |
|  3,000 | lift frame       |        84.0 |       115.0 |          58.5 |          83.0 |
|  3,000 | gap change       |         0.3 |         0.6 |           0.3 |           0.4 |
|  3,000 | gap frame p95    |        74.0 |        93.0 |          53.0 |          82.0 |
|  3,000 | scroll frame p95 |        47.0 |        55.0 |          38.0 |          34.0 |
|  3,000 | drop             |        25.5 |        34.0 |          10.0 |          19.5 |

Under that load `--budget` misses the frame p95 everywhere and the line preview's lift at
3,000 blocks. It was not re-run on an idle host. `gap change` is one synchronous session move
with the preview redrawn: 0.2–0.6 ms here, so an uncoalesced 1000 Hz mouse spent roughly
3–10 ms of each 16.7 ms frame redrawing a preview nobody would see. That is the cost the
coalescing removes on WebKit, estimated, not measured end to end.

### The whole app (where the gesture runs)

`--target app` drags through the real ⠿ handle inside App.svelte, so it is the one desktop
mode that runs `handleBlockDrag.ts`. `--moves-per-frame N` sends N moves per frame, as a
high-rate mouse on WebKit does. Not measured before and after:

- Until the reflow fix above, every run aborted on the preview-mode check, because each drag
  after the page's first showed the drop line.
- After the fix, the desktop session was locked. The host then gets no frames and times out
  (`webkitgtk-host exited 2`). A private `kwin_wayland --virtual` output gave it no frames
  either. Filed as papercut pc_c03328e0e70a.

The one earlier data point, base code, drop line, 1,000 blocks, 8 moves a frame, host load
about 20–30: scroll frame 20.6 ms median, of which 7.0 ms was pointer-move JavaScript. To take
the comparison on an unlocked desktop:

```sh
node scripts/perf/block-drag-bench.mjs --target app --sizes 1000,3000 --repeat 5 \
  --moves-per-frame 8 --gestures /tmp/base-gestures current:line current
node scripts/perf/block-drag-bench.mjs --target app --sizes 1000,3000 --repeat 5 \
  --moves-per-frame 8 current:line current
```

## Caveats

- **Not the reference phone.** The moto g play 2023 was not attached during this round. The
  Android numbers come from a pooled x86_64 emulator on a desktop-class host with other lanes
  running, which says nothing about a budget phone's absolute frame times; and its Chromium
  aligns input to frames, so it cannot show the coalescing's WebKit win.
- **No iOS run.** WKWebView is where the coalescing should matter most on a phone; no iPhone
  was used in this lane.
- `performance.now()` is clamped to 1 ms in WebKitGTK, so sub-millisecond phases read as 0.
