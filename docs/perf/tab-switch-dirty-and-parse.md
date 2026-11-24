# Tab switching — per-tab editor state

Measured 2026-10-08 on the desktop dev build (WebKitGTK, Linux) with the
synthetic vault described in `tab-switch-baseline.md` plus a `Perf/` folder of
fixtures from `tests/lib/editorDevicePerf.mjs`:

| note              | bytes   | top-level blocks |
| ----------------- | ------- | ---------------- |
| `Perf/small`      | ~25 B   | 2                |
| `Perf/blocks-1k`  | 15.6 KB | 616              |
| `Perf/blocks-10k` | 159 KB  | 5,116            |
| `Perf/lines-1k`   | 31.9 KB | 502              |
| `Perf/scratch-a`  | ~40 B   | 2                |

The question: would keeping each tab's editor state (instead of re-parsing the
note on every switch) make switching faster?

> **Result.** Per-tab state retention was measured and **not implemented**:
> swapping a retained state in costs 12–113 ms of synchronous DOM build, against
> 2–5 ms for the first-chunk parse a switch pays today. It would make switching
> slower.

## Method

`scripts/perf/tab-switch-probe.js`, pasted through the MCP bridge, drives
Ctrl+Tab through the real shortcut listener and reads the phase timeline in
`src/shared/perf/noteSwitchTimeline.ts`. Five tabs (the notes above) are cycled;
each mode discards one warm-up cycle per tab. `dirty` types one character into
the outgoing note in the same task as the keypress, so the switch pays a real
save.

**Every number here is from the probe's `frameless` mode.** The window could not
be kept composited: KWin's focus-stealing prevention refused the single-instance
raise in `tab-switch-baseline.md`, and parallel sessions held the screen. So
`paint` is not measured; `layout` (the editor's forced style + layout once it
holds the new note) is a lower bound on it. The phases that matter — content
applied, open complete — are timeline marks and need no frames.

## Per-tab editor state: measured, not implemented

The idea: keep each open tab's ProseMirror `EditorState`, swap it in with
`view.updateState` on a switch, and skip the parse (and keep undo per tab).

What a switch costs today (clean, frameless, 20 per cell; the session's first
pass, before the disk filled — load not recorded):

| incoming note | read → content applied (parse + apply, first chunk) | open complete (whole note, idle slices) |
| ------------- | --------------------------------------------------- | --------------------------------------- |
| `blocks-1k`   | 4 ms                                                | 31 ms                                   |
| `blocks-10k`  | 10 ms                                               | 516 ms                                  |
| `lines-1k`    | 17 ms                                               | 74 ms                                   |

A switch parses only the **first chunk** synchronously; `progressiveLoad.ts`
streams the rest in idle slices after the new note is on screen.

What retention would cost, measured directly on the live editor (median / p90 of
9; the retained state is the fully loaded note, swapped in over `small`, with a
forced layout):

| note                     | parse whole note | parse first chunk | `updateState(retained)` + layout |
| ------------------------ | ---------------- | ----------------- | -------------------------------- |
| `blocks-1k` (4 chunks)   | 34 / 41          | 2 / 2             | **12 / 13**                      |
| `lines-1k` (4 chunks)    | 47 / 64          | 5 / 5             | **25 / 28**                      |
| `blocks-10k` (22 chunks) | 302 / 339        | 2 / 3             | **113 / 139**                    |

The swap is the problem: a retained state holds the WHOLE document, and
ProseMirror builds its DOM in one synchronous pass — it cannot mount part of a
document. Retention would trade a 2–5 ms first-chunk parse for 12–113 ms of
DOM build before the new note shows. What it would save is the idle-slice tail
(31–516 ms of background parsing), which does not block the switch.

Decision: **not worth it** — it fails the "≥ ~10 ms p50 at 1k lines" bar in the
wrong direction (+8 ms at `blocks-1k`, +20 ms at `lines-1k`). It would also cost
complexity the measurement does not pay for: a shared plugin configuration
(`hostHandle.ts` `resetHistory` explains why a new `EditorState` kills the block
handle), invalidation on sync adopt / external content / rename retarget, a
tab whose progressive load was still streaming, and a deliberate change to the
spec'd undo reset on every open. Revisit only if the editor gains progressive
DOM mounting.

## Caveats

- **Frameless.** No `paint` numbers; `layout` excludes paint and compositing.
  A clean frame-driven pass that did complete earlier (fresh launch, window
  briefly composited) put `paint` at 45 / 99 ms for `blocks-10k`, 57 / 63 for
  `lines-1k` and 18 / 22 for `scratch-a`.
- **A contended machine.** Fifteen parallel agent lanes shared it; load average
  ranged 2–62 during the runs, and `/home` was 98–100% full (it ran out
  entirely once, failing saves and truncating a file).
- **Debug build.** Rust is unoptimized, so the save IPC is slower than in
  release.
- `performance.now()` is clamped to 1 ms in WebKitGTK.
- **Probe fix.** The first version of the probe's frameless poll created a
  `MessageChannel` per tick and never closed it; WebKit killed the web process
  at ~19 GB (`ExceededMemoryLimit`) twice. The probe now reuses one channel;
  the web process stayed under 700 MB over ~200 switches afterwards.
