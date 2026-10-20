# Leaving a note on Android — baseline and first climb

Measured 2026-10-08 on branch `hc-close-android` (off `editor-hillclimb-faster`
at `13021342d`). Re-run with `scripts/perf/android-close-probe.mjs`. The phase
timings come from the debug-only exit ledger in
`apps/android/app/src/main/java/com/futo/notes/ui/CloseLedger.kt`, read off
logcat (tag `FutoClose`).

> **Result:** Back used to wait for the editor's flush round trip and the disk
> write before the note list could start its transition. Navigation now starts
> **0–2 ms** after Back in every scenario, down from a median of **15 ms (p90
> 40 ms)** for a dirty 1k-line note and **24 ms (p90 70 ms)** for a dirty
> 10k-line note. On this emulator the list's _first frame_ barely moved at the
> median: it is dominated by composing the list (about 45–55 ms), not by the
> save. The commit itself now lands later, because it shares the main thread
> with that composition. **Not measured on the reference phone** (moto g play),
> where the disk write is slower and the saving should be larger.

## What was measured

Every sample opens a seeded fixture note from the list like a finger does, lets
the open settle, and leaves. The ledger records each phase as milliseconds
after the Back press:

| phase            | meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `navigate`       | the navigation call that starts the pop transition             |
| `listFrame`      | the first frame the note list draws after it recomposes        |
| `titleCommitted` | the last step of the exit's commit: body and title are on disk |

Scenarios:

- **clean-1k**: a 1,000-line note, no edits, system Back.
- **dirty-1k / dirty-10k**: type for 150 ms over CDP (Chrome DevTools Protocol)
  into the editor WebView, stop, then system Back at once. Back lands inside
  the editor's 200 ms change debounce, so the exit's flush round trip is real.
- **arrow-1k**: the top-bar back arrow with the keyboard down.
- **ime-1k**: tap into the body so the soft keyboard is up, then the top-bar
  back arrow. System Back would only dismiss the keyboard.

The keyboard runs also read `dumpsys gfxinfo` frame stats, reset just before
Back and read 600 ms later, so they cover the whole 220 ms exit animation.

## Setup

- **Device:** emulator `futo-hc-close`, x86_64 Android 16 (API 36), 4 vCPU,
  2 GB RAM, WebView 133. **Not the reference phone.** A fast desktop CPU with
  an emulated disk hides the slow-flash and slow-CPU costs the moto g play has.
- **Host:** Intel Core i9-14900K, 32 threads, NVMe/btrfs. Other agents ran
  emulators and builds at the same time.
- **Builds:** two debug APKs that differ only in compiled Kotlin. The editor
  bundle and the native libraries are byte-identical. Before = the old exit
  order plus the ledger; after = this change.
- **Order:** builds interleaved before/after/before/after/before/after, three
  samples of each scenario per run, nine per cell. The keyboard runs were
  interleaved separately, four samples per run, eight per cell.

**Machine load was uneven.** The first before run started at a load average of
35, with I/O pressure near 90%; the first after run started at 16. The
emulator's disk image lives on the same filesystem, which filled up earlier in
the session and paused the VM until it was resumed. Rounds 2 and 3 ran
back-to-back at a load of 1–13 and are reported separately as the fair
comparison.

## Before and after

Milliseconds after Back, median / p90.

Rounds 2 and 3 only (low load, n = 6 per cell):

| scenario  | build  | Back → navigate | Back → list first frame | Back → commit landed |
| --------- | ------ | --------------- | ----------------------- | -------------------- |
| clean-1k  | before | 2 / 4           | 53 / 72                 | 2 / 4                |
| clean-1k  | after  | 1 / 2           | 53 / 73                 | 2 / 4                |
| dirty-1k  | before | 9 / 16          | 58 / 75                 | 9 / 16               |
| dirty-1k  | after  | 1 / 1           | 56 / 118                | 41 / 116             |
| dirty-10k | before | 21 / 70         | 61 / 229                | 21 / 70              |
| dirty-10k | after  | 0 / 1           | 58 / 86                 | 44 / 86              |
| arrow-1k  | before | 2 / 12          | 55 / 116                | 2 / 12               |
| arrow-1k  | after  | 0 / 1           | 42 / 56                 | 2 / 4                |
| ime-1k    | before | 3 / 9           | 69 / 136                | 3 / 9                |
| ime-1k    | after  | 2 / 3           | 55 / 79                 | 4 / 6                |

All three rounds (n = 9 per cell; round 1 favors "after", see above):

| scenario  | build  | Back → navigate | Back → list first frame | Back → commit landed |
| --------- | ------ | --------------- | ----------------------- | -------------------- |
| clean-1k  | before | 2 / 31          | 55 / 490                | 2 / 31               |
| clean-1k  | after  | 1 / 3           | 53 / 189                | 2 / 10               |
| dirty-1k  | before | 15 / 40         | 66 / 173                | 15 / 40              |
| dirty-1k  | after  | 1 / 1           | 51 / 118                | 41 / 116             |
| dirty-10k | before | 24 / 70         | 72 / 229                | 24 / 70              |
| dirty-10k | after  | 0 / 1           | 62 / 86                 | 45 / 88              |
| arrow-1k  | before | 2 / 12          | 58 / 116                | 2 / 12               |
| arrow-1k  | after  | 0 / 1           | 43 / 60                 | 2 / 4                |
| ime-1k    | before | 4 / 9           | 69 / 136                | 4 / 9                |
| ime-1k    | after  | 2 / 3           | 54 / 79                 | 4 / 6                |

Keyboard down vs up, with frame stats over the whole exit (n = 8 per cell):

| exit          | build  | list first frame | frames  | janky frames | frame p90 | frame p99 |
| ------------- | ------ | ---------------- | ------- | ------------ | --------- | --------- |
| keyboard down | before | 57 / 86          | 32 / 33 | 2 / 3        | 25 / 81   | 52 / 121  |
| keyboard down | after  | 52 / 65          | 32 / 33 | 2 / 3        | 24 / 57   | 48 / 97   |
| keyboard up   | before | 66 / 113         | 25 / 26 | 5 / 6        | 16 / 34   | 56 / 117  |
| keyboard up   | after  | 62 / 77          | 25 / 26 | 4 / 5        | 16 / 16   | 54 / 65   |

## What changed, and what it did

1. **Navigate first, commit after.** `EditorSession` used to run the whole
   drain (flush the editor's unreported edit, write the body, commit a pending
   rename) and only then call `navigate()`. Navigation now runs first, and the
   drain runs on the store's scope, which outlives the screen. This mirrors the
   iOS back swipe. The `navigate` column is the direct effect. The list's first
   frame moves less, because composing the list costs more than the save.
2. **The commit lands later.** For a dirty note it now lands at about 41–45 ms
   instead of 9–21 ms. The flush reply and the write's result are both handled
   on the main thread, now behind the list's composition. Until it lands, the
   note's draft stays in the draft register, so backgrounding still flushes it.
   A note reopened in that window waits for the commit before reading disk.
3. **Hold the leaving editor's height.** With the keyboard up, the exit blurs
   the editor; the format toolbar goes away and the keyboard animates down,
   which used to resize the WebView, a whole-note relayout, on each frame of
   the exit. The pane now keeps its last height while the exit holds the
   interaction lock. Keyboard-up exits dropped about one janky frame, and the
   frame p90 tail went from 34 to 16 ms. The keyboard-up exit still has two to
   three more janky frames than keyboard-down, and its first list frame is
   still about 10 ms later. The after build carries both changes, so these
   keyboard numbers cannot be split between them.

## Not measured

- **The reference phone.** It was not attached. Every number here is an
  emulator on a desktop CPU.
- **Rename on exit.** No scenario edits the title, so `commitTitle` never
  renames in these runs.
- **The 6-second flush deadline.** No run had a wedged renderer, so the
  failure paths (a body or title that cannot commit after leaving) are covered
  only by the JVM unit tests in `EditorSessionTest`.
