# iOS text-first: notes for milestones M7 and M8

Moved verbatim from the ledger ([../ios-text-first.md](../ios-text-first.md)).

## M7 notes

- Engine: the non-UI half of `EditorEngineFind.kt` is `host::plan_find` (report + matches to UTF-16
  marks, hidden while composing) and `host::FindLanding` (the first press after a query change
  lands on the current match; later ones step). Everything else (matching, wrap, table barriers,
  stale rescans, rebasing) was already the engine's.
- Entry and bar: an overflow menu (ellipsis) in the note screen's toolbar holds "Find in note" (the
  other actions of the WebView screen's menu are M9); the existing `FindInNoteBar` is a layout
  sibling under the editor, so it rides above the keyboard and the note never runs under it.
  Count text is the catalog's `editor.find.matchCount`.
- Marks: never in the text storage. `TextFirstLayoutFragment` paints them behind the glyphs (every
  paragraph is now a custom fragment: a fragment laid out before the first mark is not rebuilt by
  invalidation), inside table cells (cell text laid out as the grid draws it) and over an image
  whose alt text or destination matches (the engine counts those; the spelling is hidden). Orange =
  current, yellow = the rest. Repaint = invalidating the viewport's layout.
- Edits keep the bar open: `accept` schedules a 150 ms refresh (engine rebases on read; a stale
  report takes a scan request, scans on a background queue, applies if the revision still holds).
- Step: lands via the engine selection (`selectUtf16`), scrolls the match a third of the way down,
  and scrolls a table's columns to the match's cell. It does NOT open the cell field (Android does);
  the field opens on tap. Closing restores the selection and scroll position from before find opened
  when nothing was edited (find-in-note.md iOS/Android line; Android text-first does not).
- Spec: `docs/spec/editor/mobile/find.md` (one *(mobile)* line, one *(iOS)* line); Android's find
  line in portable-core/find.md kept only its cell-field-focus half (38cd5c444 on android-text-first).
- Tests: `TextFirstFindTests` (8: marks, stepping with wrap, refresh after edits, close, table
  cells and a column scroll, cell marks after an edit above, image marks, painted pixels) and
  `TextFirstFindUITests` (real touches: menu, bar above the keyboard, count, steps, close).
- Open: the engine counts a match in an image's file name, so a step can land on a hidden spelling (the picture is marked).

## M8 notes

- Opening: `TextFirstNoteScreen` starts the engine's open and the quick open together; a note over 16 KB
  shows `NoteStore.quickOpenView` (display + spans planned by Rust) in a controller with no session
  (`TextFirstEditorController+Opening.swift`). Until `attach(session:)` the view takes input but
  changes nothing: `shouldChangeTextIn` returns false and queues `OpeningOp`s (keys, Enter, selection),
  replayed on landing; a range is mapped through what the engine actually changed
  (`EditorPendingEdits.record/map`), and a key at the range the view never left goes to the engine's
  caret. Toolbar edit buttons are disabled; copy, cut, paste, undo, find and taps on controls wait.
  A leave before landing waits for the open, applies the ops and saves.
- No streaming of text on iOS: appending the rest of a 2.3 MB display to the text storage costs 0 to 2 ms
  (TextKit 2 lays out lazily), so the handover is one append and only styling is in slices.
  Slices now end where the engine says (`slice_end`), wait a gap (8 ms or the slice's own time) so
  touches run between them, and wait while a finger is down or the edit menu shows.
- Select All: UIKit highlighting 2.3 MB held the main thread 2.2 s at once and again after every
  restyle (sampled: `UITextSelectionDisplayInteraction _updateSelectionIfNeeded`). The engine selects
  everything; the view's selection is the stretch around the viewport and follows scrolling; copy, cut,
  typing, commands use the engine's selection (`effectiveSelection`).
- Large commands (selection >= 50,000 units): Bold etc. run on the `io` queue (`engineJobs` counts them;
  any main-thread engine call would wait on the engine's lock, so every engine entry point checks
  `engineBusy`); taps and keys meanwhile are dropped; the result restyles the viewport at once and the
  rest in slices. The toolbar state of a huge selection and a find scan (>= 200,000 units) also run there.
- Not changed after trying: a new width keeps the reader's line (UIKit already does; test only), a
  cell field far from the viewport does not move the reader (test only), double-tap, long-press word
  and handle drags at far offsets use the same hit test as the verified tap (tested at the UIKit-call
  level, not with real fingers).
- Open problems: (1) a new width holds the main thread 0.8 s (1.3 MB) to 2.1 s (2.3 MB) wherever the
  reader is (TextKit 2 re-lays out from the first line; moving to the top first did not help); no iOS 27
  viewport API was tried (not known to exist). (2) After Bold on everything the Swift styler spends
  about 100 ms per 12k-unit slice (160 slices: 21 to 31 s to finish styling a 2.3 MB note). (3) Note shapes
  with one huge paragraph (20k lines, no blank line) restyle at 0.5 to 0.8 s per slice after Bold: engine
  large-paragraph work. (4) Scroll indicator estimate and scroll cost per step: not touched.
  (5) Style slices have no viewport anchoring beyond the viewport-first restyle after a command.
  (6) No loading indicator (Android's 300 ms line): the quick open makes it moot below 300 ms.
- Pipe-line quadratic (engine `inspect_tables`, for the fix lane to confirm on iOS): a 20k-line note of plain lines
  with one `a | b` line before them, versus the same note without it (`TFSLICE`, release Rust, sim):
  first style slice 457 ms vs 48 ms, styling not finished after 20 s vs finished; Select All then Bold on it does
  not finish in 2 minutes. Re-measure with `TEXT_FIRST_BENCH_MODE=slice` after the engine MR lands
  (`ios-text-first-artifacts/m8/pipe-20k.md`, `nopipe-20k.md`).
- Follow-up (engine): find's first press with no current match but total > 0 should step instead of
  doing nothing (Android behaves the same). iOS reschedules the rescan after composition (test added).
- Timings (iOS 27.2 sim futo-qa-6, Debug app, release Rust, `TextFirstLongBenchTests`): see
  `docs/spec/editor/mobile/long-notes.md`; raw logs in `ios-text-first-artifacts/m8/`.
