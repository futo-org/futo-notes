# iOS text-first editor — milestone ledger

Goal: the native iPhone editor reaches the level of the Android text-first editor
(`android-text-first`, MR !564). Debug and release now both use the native editor. Delete this file in the
commit that finishes the last milestone (archive rule).

## Decisions (final)

- A TextKit 2 `UITextView` holding display text only (no Markdown markers), driven by the Rust
  engine (`futo-notes-editor` + `futo-notes-store` over `futo-notes-ffi`), which owns the note's
  exact bytes, history, saving and every Markdown rule. No Markdown rules in Swift.
- Deployment floor stays iOS 18; iOS 27 TextKit APIs are gated behind `#available`.
- The native cutover removed the rollout flag and the mobile web host. No renderer preference
  or launch argument remains. The unfinished evidence items below are follow-ups.
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
| `ToolbarCommandGate.kt` | not needed on iOS for small commands (the main actor runs them whole); large ones now take the engine queue and drop taps meanwhile (see [M8 notes](ios-text-first/notes-m7-m8.md)): every command runs synchronously on the main actor, so none is queued or dropped. Revisit if M8 moves the engine off the main thread. | | |

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
Milestone notes M7 and M8: [ios-text-first/notes-m7-m8.md](ios-text-first/notes-m7-m8.md).

## Input safety net (2026-11-09, lane `ios-tf/input-safety-net`)

- `TextFirstRandomInputTests`: seeded random runs of the input-shape calls (typing, deletion,
  text-service replacement, marked text, dictation) mixed with Enter, toolbar commands, undo, redo,
  paste, cut and selection changes, on a note holding every block kind. After every operation the view
  text and selection equal the engine's display and `engineSelection` (Swift's copy: the FFI has no
  selection getter), `divergences` is empty, the engine holds no composition the view does not, and no
  call was refused (`recoveries`). 24 seeds of 120 operations, about 4 s; a failing seed prints its
  shortened operations for a named row. Explore with `TEST_RUNNER_FUTO_RANDOM_FIRST`, `_SEEDS`, `_OPS`.
  An engine refusal matching an open next-steps item (`UnrepresentableFormat`, or `InvalidRange` on
  character boundaries in two shapes) is a known issue and the run steps over it; a stale revision, an
  open composition or a split character never is. Fails all 24 seeds with `reconcile`'s repaint
  skipped. Seeds 1 to 800 at 150 operations: no mismatch beyond the two fixed below.
- `tablesWidthChanged()` rewrote every table row's attributes on each layout pass, so each scroll
  step edited the text storage (11 edits over 10 steps); it now has a width guard (`tablesWidth`).
- Fixed: a refused composition commit left the engine composing, so every later key was refused (the
  editor stopped taking input). `reloadFromEngine` now cancels the engine's composition.
- Fixed: after a refused edit `recover` kept the caret where the dropped edit left it (it could split
  a surrogate pair) as the engine's selection. It now restores the engine's selection when
  `engineSelectionRev` matches; otherwise it keeps the view's, snapped, and tells the engine. Each fix
  reverted alone fails its row. Opus re-check: the first classifier swallowed both; tightened, SHIP.
- Engine refusals found (next-steps item 3, each a named known-issue row): a selection crossing into or
  out of a code block or from a heading or paragraph into a list; some pastes; Backspace at a code
  block's first line below a blank line and on a line split out of a link; a key, Enter or dictation
  at a caret in a list item holding a pasted block; replacing or deleting inside one line; `InvalidRange`
  for valid ranges; a composition committed after an undo (iOS only).

- Merged origin/main (86573c3f8) into the branch, 2026-11-09: a pasted Markdown link is now a link
  (Justin's call; main's engine already did it). The engine crates now equal main's: the branch's
  engine work was all on main, and `empty_list_body` was dropped as main did (3e5f2acb3, not needed
  after !604's parser patch). Three known-issue rows turned into plain regression rows.

- Codex (gpt-6.1-sol, high) on !591: seven findings, all confirmed, none outside the debug flag.
  Fixed (each test fails without its fix): a title typed inside the rename debounce commits with the
  leave; a screen that left stops acting on its open; the fallback diff keeps surrogate pairs whole;
  the image cache keys by file, size and date and keeps the file's width. Two more: next-steps 2.

## Deferred architecture work

Moved from `docs/plan/ios-text-first-architecture.md` (written 2026-11-09 at `d4ec4cfe2`) when the input safety net landed.

Three refactors that would make the editor simpler to change. None changes what the user sees, each rewrites code that has just stabilized, and iPhone performance is assumed good enough, so each waits for its trigger.

### One engine update per input event

**Today.** A plain keystroke makes seven or eight FFI calls that Swift stitches together (`replaceUtf16Action`, `mirror.applyChange`, two `byteToUtf16`, `stylePlan`, `toolbarHighlights`, `wikilinkCompletion`, `saveDelay`), converting between the engine's byte offsets and UTF-16 itself. `EditorDisplayMirror` is a second rope of text the session already indexes in UTF-16 (`crates/futo-notes-editor/src/coordinates.rs:36`); iOS is its only user. The returned `EditorViewChange` carries a full projection of which Swift reads only the range.

**Idea.** Additive session entry points that take UTF-16 and return one record: the display edit, the selection, the display length, the reparsed window with its style spans, toolbar highlights, wikilink completion and save delay. iOS then drops the mirror, the offset conversions, and `accept`/`restyle`/`syncToolbar`/`refreshCompletion` in favor of one `apply(update)`. Conversion failures become errors (today `style_plan` maps them to offset 0, `crates/futo-notes-ffi/src/editor/host.rs:545`) and every read checks the revision. Get Justin's OK on the API shape before coding; Android would inherit it.

**Trigger.** Mason wants to share input sequencing with Android, or a bug is traced to the mirror or the offset conversions.

### The draft owns saving

**Today.** `TextFirstLeaves` keeps the whole controller (view, storage, image cache) alive to retry a failed save, and hands it back through `claim`/`accept`/`yieldSaving`/`resumeSaving`/`openTicket`. `unsavedNoteIds` misses a pending leave.

**Idea.** A draft object owns the session, the save timer, checkpoint, close, the save fence, identity and the one retry loop; `NotesStore` registers it by note id until its close is durable, discarded or retired by a reset. The controller holds a draft and a view; leaving drops the controller. Reopening a note with a pending draft builds a fresh view from its session.

**Trigger.** A second bug in the leave handover, or a feature that has to change that code.

### Controller phases

**Today.** `TextFirstEditorController` has about 55 stored properties and 15 mode flags; `opening`/`engineBusy`/`commandRunning` are checked at 58 sites.

**Idea.** One `phase` value (opening, live, job, closed), every engine call routed through one wrapper that consults it, and the remaining properties grouped by owner.

**Trigger.** A change that would add another mode flag, or heavy work on the controller for any other reason.

### Also set aside

- Measuring on a phone and setting performance budgets: when someone sees a stall on a real device.
- Pull styling through `NSTextContentStorageDelegate`, raising the iOS long-note thresholds, styler caches, engine work-bound tests, #337: speed only.
- Images as one-character atoms in the engine's display: a cross-platform engine change for Justin and Mason.

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
