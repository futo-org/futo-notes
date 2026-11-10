# iOS text-first editor: input safety net, and deferred architecture work

Written 2026-11-09 against `ios-text-first` at `d4ec4cfe2`. One piece of work to do now, and three larger ideas recorded with the conditions that would bring them back.

The plan comes from reading the code; nothing was built or run. Confirm each premise before acting on it.

Rules: `docs/plan/next-steps-2026-11-09.md`, "How to work" and Justin's product decisions, govern this work. Ledger: `docs/plan/ios-text-first.md`.

When the work below lands, move the "Deferred" section into the ledger and delete this file (archive rule).

## Do now: the input safety net

One lane, `ios-tf/input-safety-net`, cut from `ios-text-first` and fast-forwarded back after an Opus re-check (all iOS work stays in !591).

### 1. Random input test

**Why.** The existing suites pin input shapes one at a time. Nothing drives long mixed sequences, which is where a view that edits first and reconciles afterwards goes wrong.

**Change.** Using `TextFirstHarness`, drive seeded random sequences of the operations the input-shape fixtures already define: typing, deletion, text-service replacement, marked text with commit or cancel, Enter, Backspace at a caret, toolbar commands, undo, redo, paste and selection changes. Start from a note containing every block kind (headings, lists, a task list, a quote, a code block, a table, an image, a link, a wikilink). After every operation assert:

- the storage text equals the engine's display;
- the view's selection equals the engine's;
- `divergences` is empty.

Fixed seeds in the ordinary run. A failing seed prints its operation list, shortened to the smallest sequence that still fails. The suite finishes in seconds.

**When it finds a bug.** Expect it to. For each failure:

- a Swift cause with a small fix: fix it in this lane, and keep the shortened sequence as its own named test;
- an engine cause, or a fix that is not small: add it to the engine or iOS fix lane in next-steps with its operation list, and mark that sequence as a known issue naming the item, so the suite stays green and the bug stays visible.

Report every bug found to Justin, fixed or not.

### 2. Table rows rewritten on every scroll step

**Premise to confirm.** `tablesWidthChanged()` (`apps/ios/Sources/Editor/TextFirst/TextFirstTables.swift:163`) is called from `TextFirstTextView.layoutSubviews` with no width guard. A scroll view lays out on every scroll step, so each step re-adds kern and paragraph style to every table row in the styled text. `TextFirstImages.widthChanged` has the guard (`lastWidth`).

**Change.** Write a test showing that scrolling a note with a table edits the text storage; then add the same width guard.

### Done when

- the random suite runs in `just test-ios-native`, and has been shown to fail against a deliberately broken `reconcile` (then restored);
- the table test fails before the guard and passes after it;
- every TextFirst suite passes (drawing suites in light mode);
- the ledger records what landed and each bug the random suite found.

## Deferred

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
