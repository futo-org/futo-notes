# Tab-switch latency — desktop baseline

Measured 2026-08-07 so the switch-speed work has a fixed hill to climb. Re-run
with `scripts/perf/tab-switch-probe.js`; phase timings come from the always-on
timeline in `src/shared/perf/noteSwitchTimeline.ts`.

> **Result:** virtualizing the sidebar folder tree took Ctrl+Tab from a p50 of
> **147 ms to 13 ms** at 2,533 rows. The "After" section at the end has the
> numbers; everything before it is the original baseline that identified the
> cause. Locked by `FolderTreeView.test.ts` → "FolderTreeView virtualization".

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
| → `setEditorContent` returned | ~60 ms | CM6 doc replace + live-preview decorations |
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

The dev vault (`~/Documents/fake-notes`, used by `just tauri-dev` from the main
repo) ships ~30 notes — far too few to show this. Seed it from a real vault,
keeping a backup first:

```bash
cp -a ~/Documents/fake-notes ~/Documents/fake-notes.perfbak
rsync -a --exclude '.*' ~/Documents/futo-notes/ ~/Documents/fake-notes/
```

To restore: `rm -rf ~/Documents/fake-notes && mv ~/Documents/fake-notes.perfbak
~/Documents/fake-notes`.

## After: virtualizing the folder tree

`FolderTreeView.svelte` now mounts only the rows near the viewport (plus 8 rows
of overscan) and represents the rest with two spacer divs, so the scrollbar and
scroll offsets still reflect the full row count. Same vault, same 7 tabs, same
probe — **16–25 rows mounted instead of 2,533**:

| | before | after |
|---|---|---|
| `readNote` resolved | ~31 ms | 1 ms |
| `setEditorContent` returned | ~60 ms | 5 ms |
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
