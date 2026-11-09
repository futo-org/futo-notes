# iOS text-first editor — milestone ledger

Goal: the native iPhone editor reaches the level of the Android text-first editor
(`android-text-first`, MR !564). Dev builds only, behind a persistent flag. Delete this file in the
commit that finishes the last milestone (archive rule).

## Decisions (final)

- A TextKit 2 `UITextView` holding display text only (no Markdown markers), driven by the Rust
  engine (`futo-notes-editor` + `futo-notes-store` over `futo-notes-ffi`), which owns the note's
  exact bytes, history, saving and every Markdown rule. No Markdown rules in Swift.
- Deployment floor stays iOS 18; iOS 27 TextKit APIs are gated behind `#available`.
- Flag: `TextFirstFlag` (`futo.textFirstEditor` in `UserDefaults`), dev builds only, persisted from
  the launch argument `-futo.textFirstEditor YES|NO`, off by default. When on, `EditorHost.shared`
  (and so the WKWebView) is never touched (`EditorHost.isInUse`).
- Logic that exists only in Kotlin and is not platform UI is written in Rust (`host` module of
  `futo-notes-editor`, UniFFI in `crates/futo-notes-ffi/src/editor/host.rs`) via small engine MRs
  cut from `origin/main`, each noted on !564.
- Spec: an *(Android text-first editor)* line that is not Android-specific moves to
  `docs/spec/editor/mobile/` retagged *(mobile)* in the commit that makes it pass on iOS, and is
  cherry-picked onto `android-text-first`.

## Milestones

| # | Scope | State |
|---|---|---|
| M1 | Port the proof onto the current engine: open, type, save, IME shapes, kill loop, 20k smoke | done |
| M2 | Toolbar and selection state (Mason's heading/format items), projection styling | done |
| M3 | Lists, checkboxes, quotes, code | done |
| M4 | Links and wikilinks, including completion | done |
| M5 | Images | done |
| M6 | Tables | done |
| M7 | Find | done |
| M8 | Long notes: quick open, streaming, Select All | done (open problems below) |
| M9 | Remaining mobile lines and an evidence pass (incl. VoiceOver must read an image's alt text, not its hidden Markdown) | |

## Engine MRs and !564 notes

| Kotlin | Rust | MR | !564 note |
|---|---|---|---|
| `DisplayIndex.kt`, `DisplayMirror.kt` (UTF-16 to UTF-8 conversion of engine changes) | `futo_notes_editor::host::DisplayMirror`, `EditorDisplayMirror` | !589 | posted |

## Engine MRs and !564 notes (M2)

| Kotlin | Rust | MR | !564 note |
|---|---|---|---|
| `SpanPlan.kt` (`planSpans`, `splitAtLines`) | `host::plan_styles`, `NativeEditorSession.style_plan` | !592 (stacked on !589) | posted |
| `toolbarActive` / disabled-id mapping in `TextFirstToolbar.kt`, `EditorEngineCaret.kt` | `host::toolbar_highlights`, `NativeEditorSession.toolbar_highlights` | !594 (stacked on !592, merges !590 for `ToolbarState`) | posted |
| (no Kotlin: engine gap Android shares) caret Backspace/Delete next to an image removes the whole atom | `ParagraphKey::Backspace/Delete` widen to the atom | !595 (from main) | posted |
| `EditorEngineTables.kt` (`tableSpans`, lookup half of `publishCell`) | `host::plan_tables`, `EditorStyleSpan.TableRow/TableDelimiter`, `NativeEditorSession.cell_view` | !596 (stacked on !593) | to post |
| `SpanPlan.kt` image branch (`SpanSpec.Image`) | `host::StyleSpec::Image`, `EditorStyleSpan.Image` | !593 (stacked on !592, merges !590 for `is_http_image_source`) | posted |
| `EditorEngineFind.kt` (`snapshot`: UTF-16 marks, composition suppression, reveal target; `findStep`'s `landed` first-press rule) | `host::plan_find`, `host::FindLanding`, `NativeEditorSession.find_snapshot` / `find_step_landing`, `EditorFindLanding` | !598 (stacked on !589; cherry-picked here because this branch carries the older !589 commit) | posted |
| `EditorEngineOpening.kt` (`selectWhileOpening`, the queue's range mapping), `RenderWork.map` | `host::PendingEdits`, `EditorPendingEdits` | !603 (stacked on !596, merges !590) | posted |
| `EditorEngineStream.kt` `OpenSlices.sliceEnd` | `DisplayMirror::slice_end`, `begins_with` (the handover's byte-exact prefix test) | !603 | posted |
| `EditorEngineStorage.kt` `showQuickOpen` (`window(quick.projection, tableSpans(quick.tables))`) | `host::plan_quick_open`, `NoteStore.quick_open_view`, `EditorQuickView` | !603 | posted |
| `ToolbarCommandGate.kt` | not needed on iOS for small commands (the main actor runs them whole); large ones now take the engine queue and drop taps meanwhile (see M8 notes): every command runs synchronously on the main actor, so none is queued or dropped. Revisit if M8 moves the engine off the main thread. | | |

## Integration 2026-11-08 (branch ios-text-first)

Merged: `ios-tf/leave-identity` (ff2eed5b5), `origin/main` (engine !589, !592, !595), engine fixes !597
(`carried-formats-os-replace`), !599 (`indent-empty-list-item`), !596 (`host-table-spans`, incl. !602), !600
(`heading-toggle-blank-lines` d4b267815). Host files are main's / the engine branches' versions plus the
iOS-only additions of !594 (toolbar), !598 (find) and !603 (open slices, older round-1 copy; its round-2 fixes are
still in the engine lane); `quick_plan.rs` and `host_open_slices.rs` pass `plan_tables` the whole display as its
window (new signature from !596). Swift follow-ups for windowed tables (all done; origin/main merged 2026-11-08,
engine files are main's): restyle continues from a line past the window when its grid state differs (74f3a35b4,
window-end row fixed in 8cd3f5ab5: a row starting exactly at the window's end is the window's last line); cell
ranges come from the row's place plus `rowOffset` (74f3a35b4; test strengthened in 8182a140d); body rows reuse the
table key of the row above (74f3a35b4). Tests: `TextFirstTableTests` (4,000-row tables). Known: a paragraph line
directly above a table re-slices the rest of the note on each keystroke there.

## Decisions log (reversible)

- 2026-11-06, orchestrator: a table cell edits in place, not in a sheet. `TextFirstCellEditor` is a
  field (a subview of the note's text view, so it scrolls with it) laid over the tapped cell
  (160 pt column, row height, the grid's font and alignment), on the same engine session; its
  accessory bar has Undo and Done; Done, or a tap on the note outside it, returns. Reverse by
  presenting the same object in a sheet again (`openCellEditor`); spec line in mobile/tables.md.

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

## Architecture review follow-up (leave, checkpoint, identity, contention)

Review of !591 at 06ec72176, checked against the merged M8 code. Verdicts and what changed:

- Failed leave (confirmed): `TextFirstLeaves` gave up after 10 detach attempts and `release()`d, so the
  controller (the draft: dropping an unclosed session loses its edits) was freed. A leave now never
  ends on a failure: it keeps the real controller and `claim(id)` hands it back, draft and all, when
  the note is opened again (the screen shows `TextFirstSaveBanner`: "Couldn't save", Retry save, and
  Discard edits behind a confirmation). It ends on a durable save, on `discard()`, or when a full
  reset retires the draft token (`NotesStore.whenRetired`: the leave stops in the same turn, before
  the wipe). `TextFirstNeverOpened` (M8) ends the leave: nothing was attached. iOS keeps committing
  after the pop (editor-exits.md), it does not veto Back as Android does (5155fe70f). Catalog keys
  `notes.save.retry`, `discard`, `discardQuestion`, `discardWarning` are byte-identical to
  android-text-first's.
- One owner of a pending draft (review of the above, 2026-11-06): from `leave` on the registry owns ALL
  saving. The controller's timer is cancelled and cannot re-arm (`yieldSaving`; `armSave`, `runSave`
  and `checkpoint` stay off; `close()` no longer re-arms on failure), so each leave has ONE retry loop.
  Backoff 2 s, 4 s, 8 s ... capped at 60 s (`TextFirstLeaves.Pacing`, injectable). The failure is
  toasted once per leave by the registry, never through the screen that left (`onFailure` and
  `onIdentityChange` are cleared at `leave`). Backgrounding (willResignActive, didEnterBackground)
  attempts every pending leave at once under a `beginBackgroundTask` that ends with the attempt.
  Handover is atomic: `claim(id, accept:)` stops the loop after its attempt, then the screen mounts the
  controller inside `accept` (false if that screen was popped again meanwhile, `openTicket`) and only
  then does the registry release it and the screen's saving resume; a declined draft stays with its leave.
  Discard and reset fence saves with `TextFirstSaveFence` (closed on the main thread, read on `io`
  before each save touches the engine): a save queued before the Discard writes nothing. A save already
  inside the engine's write is ordered before the Discard (like an autosave a moment earlier); against a
  reset the store gate orders it before the wipe. Not covered: a save that passed the fence read but has
  not yet taken the gate while the wipe runs (microseconds, against a reset that starts seconds later);
  closing it for good wants Rust: `LocalNoteStore::reset` terminating the attached sessions under the
  gate (`terminal` makes a late save report `SessionDeleted`). Not in the draft register, so
  `unsavedNoteIds` still misses a pending leave (flushing it through `flush_draft` would be refused by the
  attachment).
- Coordinated changes (confirmed): drained after both checkpoint outcomes and while the view holds
  marked text the engine settled (the view shows the engine's text and selection); deferred while
  an M8 engine job runs and taken by `settleJobs`.
- Identity (confirmed for the title action, the wikilink self-check and the leave registry; the
  untouched-new-note delete now also checks it; image destinations refuted: an image goes to the vault root under a bare name and its claim
  belongs to the attachment, tests pin it across a rename and a park). The editor follows the
  session's own id (read on the I/O queue after every save attempt, a returned disposition, or the
  rename mutation), never a name pattern; `TextFirstTitle.rename` acts on that id. An id read on `io`
  carries the `identityEpoch` it was queued at; a rename's or a park's adoption bumps it, so a read
  older than the adoption is dropped and the engine is asked again (no stale save moves the editor
  back to a vacated name). Residual: `TextFirstTitle.rename` reads the id, then renames by it; a peer
  that moves the attachment and makes a new note at the old name inside that window is renamed instead
  (the vault rename takes no expected id).
  Not done: a screen pushed over (wikilink) holds no attachment, so a peer rename meanwhile leaves
  its `noteId` stale and the re-open bounces back to the list (nothing is lost).
- Contention (characterized, release-ffi, 20k-line 899 KB note, simulator): the save holds the FFI
  session mutex and the attachment lock through its filesystem work, so the first main-thread session
  call after it starts waits for the rest of it. Injected write delay 200 / 600 / 1500 ms: a
  `revision()` call waited 160 / 565 / 1461 ms. A real save of this note (no injected delay) held the
  session about 45 ms warm and about 110 ms for the note's first save; a keystroke behind it waited that long. A toolbar command with a caret ran on the main thread and took 560 ms behind
  a 600 ms save. A save queued behind another workflow's gate hold (a 96 MB write, 117 ms) made a
  `revision()` call wait 72 ms. M8's engine jobs share the saves' I/O queue and do not set
  `engineBusy` for a save: a heavy command asked for during a slow save stays off the main thread but
  input is dropped until the save and the job end (+619 ms for a 600 ms save). Proposed engine MR
  (not in !591): on the no-divergence path the save snapshots (id, base, source, revision) under
  the attachment lock, takes the gate and writes without it, then commits by revision (revision
  moved: base becomes the written bytes and the draft stays dirty); the divergent path (adoption,
  park) stays under the lock; the FFI session drops the one mutex in front of `StoreEditorSession`,
  which already shares `Arc<Mutex<Attachment>>`.
  Measure: `TEST_RUNNER_TEXT_FIRST_CONTENTION_OUT=/tmp/c.txt just test-ios-native TextFirstSaveContentionTests`
  with a local-only sleep in `vault_fs/unix.rs` `write_temp_and_install` (`FUTO_SLOW_WRITE_MS`).

Milestone notes M1 to M6: [ios-text-first/notes-m1-m6.md](ios-text-first/notes-m1-m6.md).

## Human checklist (needs a physical iPhone; never blocks a milestone)

- Dictation (placeholders never reach the file), QuickPath swipe typing, Writing Tools rewrite and
  proofread, third-party keyboards, Apple Pencil Scribble.
- Toolbar behavior over the real keyboard on a phone, arrow-key caret affinity at format boundaries
  (hardware keyboard), VoiceOver reading headings.
- Camera capture, the photo picker, and pasting from Photos/Safari ("Copy Image") into a note; EXIF-rotated camera photos drawing upright; large photos (12 MP) loading without a hitch.
- Find bar over the real keyboard on a phone (height with the accessory row), stepping through a
  long note, and the in-place cell field with a hardware keyboard.
- Real-device keystroke timings at 20k lines (the simulator numbers are not phone numbers).
- Long notes on a phone: open-to-first-text, Select All then the edit menu (our own UIEditMenuInteraction
  stands in for UIKit's), scrolling while a slice styles, a rotation on a 2 MB note, dictation during
  the first 300 ms of an open.
