# Tab-switch latency — desktop baseline

Measured 2026-08-07 so the switch-speed work has a fixed hill to climb. Re-run
with `scripts/perf/tab-switch-probe.js`; phase timings come from the always-on
timeline in `src/shared/perf/noteSwitchTimeline.ts`.

> **Result:** virtualizing the sidebar folder tree took Ctrl+Tab from a p50 of
> **147 ms to 15 ms** at 2,533 rows on WebKitGTK, and **522 ms to 33 ms** at
> 3,388 rows on macOS/WebKit. The "After" and "Re-derived" sections at the end
> have the numbers; everything before them is the original baseline that
> identified the cause. Locked by `FolderTreeView.test.ts` → "FolderTreeView
> virtualization". Virtualizing also introduced — and this doc records the fix
> for — blank sidebar frames during a fast fling.

## What was measured

Ctrl+Tab between 7 open tabs, driven through the real `window` keydown listener
in `src/app/registerNotesShellShortcuts.ts`. `paint` is the perceived number:
keypress → the frame that shows the new note. Nothing was dirty, so no save ran.

- **App**: `just tauri-dev` (debug Rust, Vite dev frontend), WebKitGTK.
- **Vault**: 2,642 notes copied from a real vault — median 306 B, p90 4 KB,
  max 907 KB. The sidebar renders **2,533 rows**, none virtualized.
- **Tab notes**: 65 B … 114 KB, to test whether note size matters.

## Baseline

| Phase | p50 | Notes |
|---|---|---|
| keydown → transition entered | 2 ms | store update + Svelte effect |
| `flushSave` | 0 ms | nothing dirty |
| → `readNote` resolved | ~31 ms | see below — this is *not* IPC cost |
| → `contentApplied` (editor holds the new doc) | ~60 ms | CM6 doc replace + live-preview decorations |
| → **painted** | **~127–148 ms** | one long 50–87 ms frame after the work finishes |

Range across 21+ switches: **99–272 ms**, p90 ~145 ms.

## Where the time actually goes

**The sidebar note tree is ~85% of the cost.** Hiding it with `display: none`
drops the switch from ~148 ms to **22 ms**; restoring it returns it to ~148 ms.
Cost scales with the number of rendered rows, at roughly **0.05 ms/row**:

| Sidebar rows rendered | paint p50 |
|---|---|
| 0 (tree hidden) | 22 ms |
| 25 | 17 ms |
| 400 | 24 ms |
| 1,200 | 50 ms |
| 2,533 (all) | 148 ms |

Two things this rules out:

- **Note size is irrelevant.** A 65 B note costs the same as a 114 KB one
  (144 ms vs 132 ms median). The document rebuild is not the problem.
- **The Rust read is free.** 40 distinct-id `local_notes_read` calls measure
  ≤1 ms each when the main thread is idle. The ~31 ms attributed to `readNote`
  during a switch is the IPC callback waiting behind the intermediate render
  frame that `patchState({ loading: true })` triggers — main-thread contention,
  not I/O. Removing the sidebar drops this phase to 3 ms on its own.

`contain: layout style` (138 ms) and `content-visibility: auto` (144 ms) on the
rows do **not** help — only `display: none` does. So the cost is per-row work
that containment does not skip (style recalculation over the row set), not row
layout or paint.

## Floor

With the tree not rendered, a switch costs **~17–22 ms** end to end. That is the
target: roughly a **6× improvement** is available without touching the editor,
the note read, or the save path.

## Reproducing the corpus

Generate a synthetic vault **inside a worktree**, and run the app against it.
Never seed a perf run from `~/Documents/futo-notes` (that is real user data) and
never write into `~/Documents/fake-notes`: that path is machine-global, so every
parallel session shares it and one run's 3,000 notes become another's surprise.
A worktree's `.tauri-data/` is per-checkout, which is what `just tauri-dev`
already uses there (`FUTO_NOTES_DATA_DIR`).

```bash
# From a worktree root. ~3,000 notes over 30 folders; adjust to taste.
node -e '
const fs = require("node:fs");
const root = process.argv[1];
for (let a = 0; a < 30; a += 1) {
  const dir = `${root}/Area-${String(a).padStart(2, "0")}`;
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 0; n < 100; n += 1) {
    const i = a * 100 + n;
    fs.writeFileSync(`${dir}/Note ${String(i).padStart(5, "0")}.md`, `# Note ${i}\n\nFill note.\n`);
  }
}
' "$PWD/.tauri-data/notes"

just tauri-dev   # already points this worktree at .tauri-data
```

To reset, delete `.tauri-data/notes` — nothing outside the worktree is involved.

## After: virtualizing the folder tree

`FolderTreeView.svelte` now mounts only the rows near the viewport (plus 8 rows
of overscan) and represents the rest with two spacer divs, so the scrollbar and
scroll offsets still reflect the full row count. Same vault, same 7 tabs, same
probe — **16–25 rows mounted instead of 2,533**:

| | before | after |
|---|---|---|
| `readNote` resolved | ~31 ms | 1 ms |
| `contentApplied` | ~60 ms | 5 ms |
| **painted (p50)** | **147 ms** | **15 ms** |
| painted (p90) | ~145 ms | 26 ms |
| painted (min / max) | 99 / 272 ms | 9 / 35 ms |

n=28 switches on a freshly started app (not an HMR-patched one), sampled with
the tree scrolled to the top and to mid-list. The `readNote` phase fell out on
its own: it was never I/O, just the IPC callback queued behind the layout of
2,533 rows.

The tail is worth stating plainly: p50 is 15 ms, but p90 is 26 ms and the worst
of 28 was 35 ms. The win is the median and the removal of the 100 ms+ floor, not
a hard cap under 25 ms on every switch.

This also closes a divergence — `docs/spec/list.md` already described the files
tab as "a virtualized folder tree", which was not true of the implementation.

Things deliberately not done, with reasons:

- **Pinning the drag source row.** Drag identity survives a row unmounting:
  `createFolderTreeDrag` keeps `sourceNoteId`/`sourceFolderPath` in closure
  state and `readDragSources` falls back to them when `dataTransfer` is empty.
- **CSS containment.** The rows already set `contain: layout style paint`, and
  adding `contain: strict` to the scroll container measured 143 ms — no help.
  Containment stops layout *propagating*; it does not stop WebKit laying out
  mounted children.

An inline folder rename **is** pinned into the window — its `<input>` would
otherwise unmount mid-edit and silently drop what the user typed.

## Re-derived on macOS/WebKit, 2026-08-10

The numbers above are WebKitGTK on Linux. Re-measured on macOS/WebKit against a
3,207-note vault (**3,388 sidebar rows**, generated into a worktree's
`.tauri-data` — see "Reproducing the corpus"), same debug build, same session,
same tabs, virtualization toggled by patching `window_` to return the full range:

| | all 3,388 rows mounted | virtualized (17 rows) |
|---|---|---|
| `readNote` resolved | 94 ms | 1 ms |
| `contentApplied` | 245 ms | 6 ms |
| **painted (p50)** | **522 ms** | **33 ms** |
| painted (p90) | 3,538 ms | 34 ms |

n=10 measured switches after 4 warmups per leg. Absolute numbers are much larger
than the Linux ones (bigger tree, different engine and machine) but the shape is
identical: ~16× at p50, and the phases the sidebar was starving — `readNote`,
`contentApplied` — collapse on their own. The claim in the "After" section holds
on both platforms; the specific figures are per-platform.

The window must be **visible** for any of this: WebKit suspends
`requestAnimationFrame` while it is occluded, so `paint` is unmeasurable from a
background window and `scripts/perf/tab-switch-probe.js` simply hangs on a frame
that never arrives (`document.hasFocus()` can be `true` while the page is
`hidden` — `visibilityState` is the check). To bring the window forward with no
OS-level input automation, launch a second copy of the same debug binary —
`tauri-plugin-single-instance`'s handler calls `window.set_focus()` from Rust,
which no capability gates:

```bash
FUTO_NOTES_DATA_DIR=$PWD/.tauri-data ./target/debug/futo-notes-tauri
```

Parallel sessions steal focus back within seconds, so re-run that in a 1s loop
for the duration of a run and record `visibilityState` alongside the result.
Making the probe itself report a stalled frame clock instead of hanging is a
worthwhile follow-up, deliberately left out of this branch.

## The blank-sidebar frames, and what actually fixes them

Virtualizing introduced a defect: during a fast fling the sidebar painted
**completely blank, label-less frames** — up to 4 consecutive captured frames
(~84 ms) on a 3,388-row tree.

Diagnosing it needs ground truth, because **in-page rAF sampling cannot see
it**: `getBoundingClientRect` reports geometry against the *main thread's* scroll
offset, so a probe that samples the DOM every frame happily reports "rows cover
the viewport" while the screen shows nothing. Capture the real window surface
instead — the MCP bridge's `capture_native_screenshot` returns a frame in ~19 ms,
fast enough to catch a 5-frame event — and score the sidebar's row area for ink.

Correlating captures with per-frame DOM samples on one clock showed the cause: at
every blank frame the DOM *did* cover the viewport (25 rows spanning −383…841 px
of a 408 px viewport), so **WebKit had painted a scroll offset the main thread
had not been told about yet**. It scrolls this container on its own thread; a
fling moves 1,000–5,500 px between consecutive scroll notifications, and 8 rows
of overscan cover ~390 px.

That rules out the intuitive fix. Flushing the projection synchronously inside
the scroll handler (`flushSync`) cannot help — the paint already happened — and
measurably **made it worse**, because the extra synchronous render per scroll
event pushes the main thread further behind the compositor:

| variant (10 reps, ~130 native captures each) | blank frames | longest run |
|---|---|---|
| virtualized, 8-row overscan | 12 | 4 frames / 84 ms |
| + `flushSync` in `handleScroll` | 32 | 7 frames / 101 ms |
| + lead the window by the last jump | 3 | 1 frame |
| + one-viewport floor (no cap) | 1 | 1 frame |
| + 128-row lead cap (**shipped**) | 5 | 1 frame |

The shipped fix leads the window in the direction of travel by the larger of the
last scroll jump and one viewport, decays that lead as the fling slows, caps it
at 128 rows so a scrollbar teleport cannot mount the whole list, and drops it to
zero 120 ms after scrolling stops — so a note switch still pays for 17 rows. What
remains is single isolated frames, never a run; the cap trades one extra isolated
frame for a bounded worst case.

Cost of the lead, steady scroll (70 × 400 px steps, 150 sampled frames):

| | scroll handler p50 / max | frame interval p50 / p95 / max | frames > 20 ms |
|---|---|---|---|
| 8-row overscan | 1 / 3 ms | 17 / 19 / 22 ms | 1 |
| with the lead | 1 / 3 ms | 17 / 19 / 28 ms | 5 |

(`flushSync`, for contrast, cost 4 ms p50 and 10 ms max per scroll event.)

## Caveats

- Numbers are from the **dev** build. The dominant cost is browser style/layout
  over sidebar rows, which is build-independent, but absolute figures may differ
  in release. Worth re-confirming against a release build before/after any fix.
- `performance.now()` is clamped to 1 ms in WebKitGTK, so sub-millisecond phases
  read as 0.
- Ctrl+Tab is dispatched as a synthetic `KeyboardEvent`, so OS→WebKit event
  delivery is excluded. That path is small relative to 127 ms.
- The probe measures a clean session. Switching away from a dirty note adds a
  real `flushSave`, which was not measured here.
