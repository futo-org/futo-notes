# Engine rebuild on the line reader: status

The brief is `docs/plan/linedown-engine-rebuild.md`; delete this file with it.

## Status

Update this file at the end of every stage, and whenever you stop mid-stage.

- Stage 1: done (see the commit `feat(editor): rebuild the editor core on the line reader`).
  `crates/futo-notes-editor/src/engine/`, called by nothing yet:
  - `store.rs`: lines in chunks of about 64 with a Fenwick tree over chunk sizes (lines,
    source and display bytes, source and display UTF-16 units). Finding a line by any offset
    is O(log chunks + 64); no edit walks the note.
  - `line.rs`: each line's text, carry, reading, spans and display pieces, line-relative, and
    the in-line position mapping. Its header lists the display rules (below).
  - `read.rs`: whole-note read and the incremental re-read (one line above the edit, on until
    the carry settles, from line 1 when front matter can open or close). It calls
    `block::read_line` and `line_spans` directly, because `Reading` stores absolute offsets
    and shifts every later line on each edit.
  - `edit/`: replace, delete (one grapheme), exact source records, undo/redo, composition
    (input during composition commits it first: one acceptance, two undo steps). Every change
    is text edits applied, then one acceptance; a refusal puts the text back.
  - `mod.rs`: queries, conversions, selection, movement, front-matter metadata, UTF-16.
  - `tests/`: 14 literal tests and the five properties (`tests/properties/`). One literal test
    is a 42-case table of selection replacements (source, selected text, typed text, bytes
    written), each also checking the view change and that undo restores bytes and selection.
    The property run also checks that typing over a random selection edits only the source
    that selection spans.
- Stage 1 choices worth a look at review:
  - A collapsed caret keeps its exact source offset after an edit (a pin), so typing
    `**a**b` or `[a](u)x` one character at a time writes exactly those bytes even when the
    display offset alone cannot say which side of hidden syntax the caret is on.
  - Replacing a selection removes its visible text, the markers of lines it joins and the
    hidden lines inside it; spans reaching out of it keep their syntax; spans it empties lose
    theirs; typed text lands at the selection's start, inside spans that start there. A span
    closing right where one of the same kind and spelling opens joins it (deleting `b c` from
    `**ab** **cd**` writes `**ad**`, not `**a****d**`; the table caught this).
  - The caret never rests in front matter or inside a CRLF, also after an edit lands there.
    A selection covering all of the front matter deletes it with its fences.
- Found in stage 1 for stage 3 (not core rules):
  - Deleting text so that bold ends in whitespace (`**b c**`, delete `c`) leaves `**b **`,
    which reads as literal asterisks. Belongs to inline formatting.
  - Backspace at a list item's text start joins it to the line above, marker and all. The
    list family's Backspace takes the marker off first.
  - Input across a fence's hidden lines just lands (a typed character always does); the fence
    family decides whether commands rebuild the frame.
  - `` ```\ncode\n```\n `` shows `code\n` with an editable empty line after the block. The
    old engine hid that line at the end of the code. Kept: it is where you continue writing.
- Fixed in the line reader: `Reading::update` read a re-read table header's inline marks
  before marking it a header, so emphasis spanning its cells survived an edit. Proved by the
  new fixture "marks do not cross a header's cells" (103 cases now).
- Stage 1 verification: 18 engine tests pass (`cargo test -p futo-notes-editor --lib
  engine`), 20,000 cases on each of seeds 1, 3, 7 and 424242, and 100,000 cases on seeds 3
  and 424242 (before the join fix). Read-only: the vault (2,775 notes, 91,081 lines) and the
  ML corpus (30,995 notes, 1,851,015 lines), all five properties hold.
  The chain `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core`:
  871 passed, 389 failed, 4 ignored. The failures are the old engine's: editor plus core
  374 (the count before this stage), store 15, all `tests::editor_session::*`.
- Stage 2: done (commit `feat(editor): run the core behind the surface on iOS`).
  - Switch: cargo feature `engine` (futo-notes-editor, forwarded by futo-notes-ffi), off by
    default; only `FUTO_EDITOR_ENGINE=1` in `scripts/build-rust-ios.sh` sets it. Under it,
    `src/session/next.rs` and one `on_next!` line per method hand `EditorSession`'s editing
    path to the core (open, select, conversions, replace, OS replace, one-item replace-many,
    composition, paragraph keys, replay, undo/redo, project, toolbar state, active formats).
    The old fields the store reads (revision, selection, affinity, marked text, source rope)
    follow the core, so store and FFI are unchanged. Commands the core lacks change nothing:
    block commands, format toggles, wikilink completion, table inspection, quick open (a note
    opens whole), external adoption (refused, so a save parks). Stage 4 deletes the switch.
  - `engine/project.rs` builds `ProjectionSlice` from each line's reading; `engine/surface.rs`
    makes `ViewChange`s whose projection covers every line read again (`Shown.lines`). A new
    property check proves restyling only that window matches a fresh read (mutation-tested).
    Wikilinks are unresolved (label = target); Enter writes a bare line break (lists: stage 3).
  - Surface change (approved kind): `ListDescription` is `{indent, marker, ordered, checked,
    first}`; `StyleSpec`/`EditorStyleSpan::ListRow` carry `indent` (columns) and `text` (marker
    as typed). An indented plain line is a `ListRow` with the new marker kind `Plain` (plan,
    "Host and FFI"). Review: `Plain` and `ordered` are additions.
  - The old engine fills the fields approximately (indent = marker column, marker `-` or
    `n.`); old list tests and the wasm list consumer read them through a shim (depth =
    indent/2+1). Both go at the cut-over.
  - iOS draws the marker text and indents 12 pt a column plus a 30 pt gutter on list items;
    every bullet is a disc (shape by depth would be Swift working out nesting).
  - Simulator (pool sim, `FUTO_EDITOR_ENGINE=1`, text-first on), real key presses: `- top`,
    `   - three spaces`, ` - one space`, `  plain under`, `3) three`, `10) ten`. `3)` and `10)`
    draw as typed, bullets at their own indents; the saved file equals the typed text plus the
    store's final line ending (`saved_note_source`).
  - Puppet's iOS editor verbs reach only the web editor (papercut pc_6f36185bc2f2).
  - Verified: engine tests 22 passed; properties 20,000 cases on seeds 1, 3, 7, 424242 pass;
    `cargo test -p futo-notes-ffi --features engine --test editor_engine_slice` 1 passed. The
    chain: 874 passed, 389 failed, 4 ignored; on the parent commit 870/389/4, same failures
    by name. `just test-ios-native TextFirstBlockDrawingTests TextFirstOpeningTests`: 40 of 41;
    the failure is the old engine's Tab indent (26 Rust indent tests fail on the parent).
- Stage 3: in progress. The per-family log is `docs/plan/linedown-engine-rebuild-stage3.md`.
- Stage 4: not started.
- Stage 5: not started.
- Surface methods deleted, with reasons: none yet.
- Display rules that are not "text minus ranges" (stated in `engine/line.rs`):
  1. Frames: an opening fence or front matter line is hidden with its ending; a closing line
     with its own ending, or, on the note's last line, with the ending before it.
  2. An empty code block shows one empty line with no text behind it; so does front matter
     closed on the note's last line (the body).
  3. Typing on such a line writes a line ending, then the text, after the hidden line.
  4. A divider shows as one U+FFFC.
  Front matter lines and a table's delimiter row show their whole text; everything else hides
  its marker and inline syntax.
- Open questions for the maintainer:
  1. Outside changes that touch, open or close front matter are refused by the history-keeping
     adoption, so a dirty draft parks a conflict copy (a clean session drops history and adopts).
     The spec says metadata parks; no hazard in rebasing through it was found. Keep refusing?
  2. A portable page asked to adopt its own text: the core has no record to send, so
     `adopt_merged_source` returns `UnrepresentableFormat`; the old engine sent an empty Append.
  4. Lists: Enter in `1. a` above `1. b` writes `2.` (the Decision read literally), so a list
     numbered `1.` throughout gains a `2.`. Write the item's own number when the list does not
     count up? Enter over two numbered items leaves the second's number as written.
  5. Lists: Indent always writes a tab, so an item indented into a two-space sub-list sits at 4
     columns beside siblings at 2 (the old engine used the sub-list's column).
  6. Quote on a heading or list item makes plain quoted text (`## T` -> `> T`), as before;
     Linedown could write `> ## T`, making Quote an exact toggle.
  7. Quote leaves blank lines at a selection's edges unquoted; a selection ending at a line's
     display start does not touch that line (the old engine made an exception for list items).
  8. A fence typed mid-note: after ``` the line hides and the caret moves into the code, so the
     old "Enter closes a typed fence" cannot trigger.
  9. Property 2 is amended (engine/tests/properties/mod.rs header): with no carried formats,
     typing writes exactly the typed bytes at a source offset the caret's display point maps
     to (either side of hidden marks); under carried formats (a toggle, or the formats a space
     typed at a span's end carries), the display changes by exactly the typed text in those
     formats and only inline marks are written besides. Chosen because Decision 3 (markers stay
     hidden) outranks a literal reading: `__a __` shows underscores.
  3. (Settled: the old refusals were restored on top of read-back.) Images: "safe to write" is now only "reads back as exactly that image" (see the images
     entry); keep, or keep the old engine's blanket refusals of `<`, `\` and backticks too?
