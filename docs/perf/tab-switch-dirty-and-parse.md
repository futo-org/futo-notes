# Tab switching — dirty switches and per-tab editor state

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

Two questions: does a switch away from a note with an unsaved edit wait longer
than it must, and would keeping each tab's editor state (instead of re-parsing
the note on every switch) make switching faster?

> **Result.** (1) A dirty switch now reads the incoming note while the outgoing
> save runs. That removes the read from the critical path — **1–5 ms p50**
> (5 ms on the 159 KB note) — but the switch is bound by the save itself
> (15–80 ms here, see caveats), so the end-to-end gain is small. (2) Per-tab
> state retention was measured and **not implemented**: swapping a retained
> state in costs 12–113 ms of synchronous DOM build, against 2–5 ms for the
> first-chunk parse a switch pays today. It would make switching slower.

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
holds the new note) is a lower bound on it. The phases that matter for both
questions — save flushed, read started/finished, content applied, open complete
— are timeline marks and need no frames.

## 1. Dirty switch: overlap the outgoing save and the incoming read

Before, `createNoteLoader.load()` awaited `flushSave()` and only then read the
incoming note: save, then read, then parse. The two touch different files, so
the read now starts at once and runs during the save. It is only _handed over_
once the save has settled, from the same microtask the flush resolves in, so the
"no keystroke between the last read and the replace" guarantee is unchanged, and
a failed save still keeps the user on the outgoing note.

The overlap is fenced per note (`noteSession.svelte.ts` `fenceIncomingRead`).
The read waits for the save, as every switch used to, when:

- the incoming note IS the outgoing one, or a save of it is still in flight
  (switching straight back);
- the ids differ only by case or Unicode normalization (one file on macOS and
  Windows);
- the outgoing note has an unsaved title change or no file yet (a rename can land
  under the incoming id, or rewrite links inside it);
- a rename-capable save **started while the read was out** — the fence breaks
  and the note is read again behind the flush.

### Before / after

Dirty switches, frameless, 20 per cell, alternated before/after in two rounds
(load average 17–20 and 5–8). p50 / p90 in ms from the keypress.

"Read on critical path" is the time the read adds after the save is done —
`noteRead − max(saveFlushed, readStarted)` per switch. It is measured within each
switch, so it holds up under the load swings that dominate the other columns.

| incoming note | read duration before | read on critical path, before | after     |
| ------------- | -------------------- | ----------------------------- | --------- |
| `small`       | 1 / 1                | 0 / 1                         | **0 / 0** |
| `blocks-1k`   | 1 / 1                | 1 / 1                         | **0 / 0** |
| `blocks-10k`  | 5 / 6                | 5 / 6                         | **0 / 0** |
| `lines-1k`    | 2 / 2                | 1 / 2                         | **0 / 0** |
| `scratch-a`   | 1 / 1                | 0 / 1                         | **0 / 0** |

End to end, the save dominates and swamps that difference:

| incoming note | save, before | save, after | content applied, before | content applied, after |
| ------------- | ------------ | ----------- | ----------------------- | ---------------------- |
| `small`       | 62 / 82      | 30 / 94     | 66 / 86                 | 35 / 99                |
| `blocks-1k`   | 35 / 89      | 32 / 144    | 40 / 94                 | 42 / 149               |
| `blocks-10k`  | 62 / 112     | 35 / 87     | 75 / 126                | 53 / 99                |
| `lines-1k`    | 67 / 96      | 36 / 105    | 91 / 124                | 68 / 178               |
| `scratch-a`   | 65 / 83      | 38 / 1280   | 74 / 93                 | 51 / 1288              |

Do not read the content-applied column as a 20 ms win: the save column moved by
the same amount between arms, and nothing in the change touches the save. The
honest claim is the first table — the read is gone from the critical path.

**Where a dirty switch actually goes.** The save. At low load a dirty switch's
save took 15–27 ms while the bare `local_notes_flush_draft` IPC measured
**9 ms p50** in isolation (25 calls) and `local_notes_read` 1 ms. The other
~10–18 ms is JavaScript around the IPC (serializing the outgoing document, the
post-commit mutation, notifications). That is the next lever for dirty switches;
it was **not attributed** further here (an in-page `invoke` wrapper did not see
the app's calls).

Locked by `src/features/notes/createNoteLoader.test.ts` (read not blocked by the
save, fenced read, a save failing after the read and one failing BEFORE it
lands — a failed save is no longer pending, so the loader awaits the flush's own
outcome before handing over — keystroke during the read, fence breaking
mid-read) and `noteSession.test.ts` → "reading the incoming note while the
outgoing note saves" (overlap, same note, case-variant id, rename, switching
straight back).

## 2. Per-tab editor state: measured, not implemented

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
  entirely once, failing saves and truncating a file). Save times drifted from
  ~28 ms to 60–80 ms over the session for that reason; that is why the fix-1
  claim rests on the within-switch column.
- **Debug build.** Rust is unoptimized, so the save IPC is slower than in
  release.
- `performance.now()` is clamped to 1 ms in WebKitGTK.
- **Probe fix.** The first version of the probe's frameless poll created a
  `MessageChannel` per tick and never closed it; WebKit killed the web process
  at ~19 GB (`ExceededMemoryLimit`) twice. The probe now reuses one channel;
  the web process stayed under 700 MB over ~200 switches afterwards.
