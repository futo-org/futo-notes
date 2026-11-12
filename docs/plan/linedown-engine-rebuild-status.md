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
- Stage 3: in progress.
  - Done on `linedown`: the shared command machinery (commit `feat(editor): give the core one
    command shape, one guard and work counts`). `engine/command.rs`: `Command` (edits on named
    lines plus the selection after), `Engine::run` (marked text commits first in the same
    acceptance as its own undo step; then the edits; then the one guard; one undo group),
    `kept_line` (the one escape function). The guard reads unnamed lines again (line 1, the line
    above, lines between named ranges, then forward until the carry settles) and cancels if any
    reads as another kind of block. `engine/commands/` dispatches paragraph keys (families asked
    in order tables, fences, lists, blocks; unclaimed keys type) and toolbar block commands to
    one file per family. `EditWork` now counts re-read bytes, copied source bytes and projection
    descriptions; `engine/tests/commands.rs` pins that a distant edit's counts do not grow with
    the note. The property run presses random paragraph keys and block commands.
  - Families run in parallel, one worktree and branch each (`linedown-<family>`, worktree
    `futo-notes-ln-<family>`), merged into `linedown` in the brief's order. Shared agent brief:
    each family writes its literal cases to a new `tests/fixtures/engine/<family>.json` read by
    a core test, instead of extending the old shared fixtures, because old tests and the wasm
    consumers read those until stage 4 and new cases there would only add old-engine failures.
    Stage 4 points the wasm consumers at the new files.
  - Started: external adoption, lists, heading/quote/divider, inline formatting and links,
    tables, fences, images, wikilinks and tags (with completion, note ids, relinking), find,
    quick open. Paste and clipboard start after lists and tables land.
  - Merged: the line reader fix for a lone CR on the note's last line (a final `---\r` closed
    front matter; property seed 424242 case 10331). Find (`engine/commands/find.rs`, a `Find`
    field on `Engine` fed by one hook in `Engine::accept`; 45 fixture cases): matches follow
    edits without a rescan; front matter and the divider character are barriers (old bug: find
    made a match inside front matter current while the caret snapped to the body); every line
    break is a barrier. Old `host_find_plan` 18/18 on the core; old `tests/find.rs` 4/5, the
    failure is three rows asserting a CommonMark result (a line break reads as a space).
    Stage 4: move the public find types out of `session/find.rs`, do not delete them.
  - Merged: images (`engine/commands/images.rs`, 52 fixture cases, each checking undo and
    redo). Inserted inline at the caret as `![alt](reference)`, `<...>` around a reference with
    a space or parenthesis, one undo step. "Safe to write" is now one rule: the text reads back
    on its line as exactly one image with that alt and destination, else `InvalidText`. Review:
    so `a<b.png`, `a\b.png` and an unpaired backtick in the alt are now written, and an alt
    `[x]` (reads as a wikilink), a `|` in a reference inside a table cell and an image right
    after `\` are now refused. Backspace or Delete stepping into an image removes it whole
    (`image_key`, asked first). The core lets a caret stand inside an image's text; keeping it
    outside is the renderer's, from the atom's before/after. Old `tests/images.rs` 5/7 on the
    core: the alt now shows as typed, and three old refusals are now accepted.
  - Merged: wikilinks and tags (`engine/commands/wikilinks/`, 44 fixture cases with undo and
    redo): completion and accepting it (only the differing bytes are written), note ids held by
    the core so wikilinks resolve again (`note_id`, shortest unique label), `update_note_ids`
    restyling only links whose resolution changed (a 64-bit mask per line over the targets' last
    path components, ORed per chunk in the store), `apply_own_relink` as one command and one
    undo step, tags from the reader, header tags as before. Old bugs fixed: adding a header tag
    when front matter closes on the note's last line was refused; after CRLF front matter the
    new tag block was written with LF. Note-id delivery enters 75 rows (1,000 paragraphs) and
    85 (20,000) against the old 7 and 9, under that test's bound of 128 nodes and 4 links; both
    examine 1 link. Store lib on the core: every relink, identity, wikilink and tag test passes.
  - Merged: taking in outside changes (`engine/external.rs`, 12 literal cases and a property:
    random local edits, an outside edit, a three-way merge, adopt; undo-all reaches the outside
    version byte for byte, redo returns to the merge, fresh read after every step). Prepare
    rebases every undo and redo group with `three_way_merge` and maps every selection; it refuses
    before changing anything on ambiguity, the old bounds (1 MiB / 16 MiB) or composition. Apply
    replaces only the changed window, through `accept` (so find follows it). Old bugs fixed: the
    history-keeping adoption refused every note with front matter, so an outside change parked
    the draft; adoption re-read the whole note; the history-dropping variant put the caret at the
    note's end; `move_caret` had no `on_next!` and panicked on the core. About 3.6% of random
    cases refuse because a historical merge is ambiguous (repeated blank lines), as on the old
    engine; those park, nothing is lost. All store outside-write tests pass on the core
    (`merging` 11, `clean_refresh` 6, `external_rename` 8, `saving`, `quick_open`, `flush_draft`).
    Store lib on the core after this merge: 230 passed, 28 failed (links, clipboard, quick open,
    composition, tables, blocks, list actions: families not merged yet).
  - Merged: quick open (`src/quick_open.rs`; the old CommonMark path moved verbatim to
    `src/quick_open/commonmark.rs`). The core reads the whole lines of the first 16 KB and
    shows all but the last (a delimiter row or closing fence there changes the line above); no
    quick open when line 1 is `---` and the head holds no closing `---`; a cut inside a table
    moves back to the table's first line. A property cuts random notes at random lengths and
    checks the head's projection equals the whole note's (160,000 reads per seed). 20,000-line
    note: head 0.68 ms against 12.36 ms whole (release). Stage 4: delete `quick_open`'s
    `rest_may_define` parameter, `may_define_reference`, `quick_open/commonmark.rs` and the
    tests that only run without the feature (kept now so the surface does not change).
  - Merged: heading, quote and divider (`engine/commands/blocks/`, 138 cases). Divider writes
    `---` at the caret, no blank line; where `---` would make line 1 open front matter it writes
    `----`. Enter splits a heading into heading plus plain line, continues a quote, leaves the
    quote one level on an empty quote line; split inline marks are closed and reopened. iOS
    sends `BackspaceJoiningHeading` for every caret Backspace: at a heading's start it joins up.
    Toolbar heading/quote use the commands' own rules (checked over every selection of a
    450-note corpus). `typed-escapes.md` deleted. Core bug fixed: Backspace at `b` in
    `> a\n>\n> b` wrote `>b`. Budgets (old -> new): quote keys at 20k rows 1117/1039/1538 ->
    71/70/80; Quote over 4k headings 856,640 -> 16,001 metadata items.
  - Merged: lists (`engine/commands/lists/`, 152 cases in `tests/fixtures/engine/lists/`).
    Enter splits an item (next number, unchecked box); on an empty item removes the marker (no
    blank line) or outdents it; at the text start opens an empty item above. Backspace at an
    item's text start takes the marker off. Indent writes a tab; outdent takes the leading
    whitespace of the item it sits under, else one tab or every space; both carry the lines
    under the item. Toggles act on every touched line. Renumbering as the Decisions say. Fixed
    as cases: #414, #421, #422, #355/!661, #353 (a link cannot cross a line). Guard made
    near-linear (Bullet over 40,000 lines 442 ms -> 75 ms, release). Budgets all lower (e.g.
    middle bullet toggle at 20k 1099 -> 49).
  - Merged: fences (`engine/commands/fences/`, 93 cases). Code block and Wrap code block are one
    command: lines keep their source exactly, one fence for the selection, the fence longer than
    any backtick-only line inside; taking code out splits the block, `kept_line` keeps lines
    plain (so `# x` comes back `\# x`). Enter in code keeps the line's whitespace; Tab writes
    two spaces. Core rule added to `plan`: a fence line inside a selection whose block goes on
    outside it is kept, moved after the joined line; a block left with no code line goes whole
    (fixes the #348 shapes). Old bugs fixed: Code block wrote the visible text (dropping
    markers), one fence per paragraph. Budget: keys in a 20,000-line block 963/885/1018 ->
    44/43/46.
  - The wikilinks merge put `engine/mod.rs` over the size limit: selection and movement moved
    to `engine/selection.rs`, UTF-16 conversions to `engine/utf16.rs`, verbatim.
  - Rule kept, noted by the fences lane: typing after a ``` that is the note's last line goes
    into the empty code block's body (display rule 3), so `js` there writes "```\njs", not a
    language; mid-note it writes "```js".
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
  3. Images: "safe to write" is now only "reads back as exactly that image" (see the images
     entry); keep, or keep the old engine's blanket refusals of `<`, `\` and backticks too?
