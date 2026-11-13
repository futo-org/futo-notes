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
- Stage 3: done. The per-family log, with each family's behavior, cases, old bugs fixed and
  budgets, is `docs/plan/linedown-engine-rebuild-stage3.md`. Every family in the brief's list
  and the four core pieces (outside changes, quick open, wikilink completion with relinking and
  note ids, work counting) runs on the core under the `engine` switch; no surface method is
  left unwired (the stage 2 "not yet" stub is gone).
  - Size check: the new engine's production code is 12,238 lines (core 4,672; command
    families 7,566, largest inline 2,210, lists 1,121, tables 903), 14,884 with the line reader,
    against 34,537 for the old `session/` plus `inline/` (16,940 + 17,597): 35% (43% with the
    reader). Tests: engine 7,740 lines. Under the bar; the cut-over may go ahead.
  - Budgets: every `tests/long_regions*` and `tests/inline/work.rs` scenario a family touched
    was measured on the old engine and asserted no higher on the core (numbers in the log).
  - Verification at the end of stage 3 (e0feb6dfe): `cargo test -p futo-notes-editor
    --features engine --lib engine::` 133 passed, 1 ignored; TYPING_CASES=20000 properties on
    seeds 1, 3, 7 and 424242 pass (5 passed, 1 ignored each), `engine::tests::external` 13
    passed on seeds 1 and 424242; read-only on the vault (2,775 notes, 91,081 lines) and the ML
    corpus (30,995 notes, 1,851,015 lines; unpacked from `dataset/notes_corpus.jsonl.gz`
    bodies, outside the repo) all five properties hold, with keys, block commands, format
    toggles and paste in the random steps; the chain `cargo test -p futo-notes-editor -p
    futo-notes-store -p futo-notes-core` 985 passed, 389 failed (the same 389 names as before
    stage 3), 4 ignored; `cargo build -p futo-notes-ffi --features engine` ok and
    `--test editor_engine_slice` 1 passed; `cargo clippy -p futo-notes-editor --features engine
    --all-targets` no warnings in `src/engine/`.
  - For stage 4's sort, the must-pass old tests on the core (passed/failed):
    native_input_traces 0/1 (1/0 after the review), composition 17/2, compound_composition 0/5
    (5/0 after the review), compose_after_break
    1/0, compose_after_break_review 1/3, history 12/5, find 4/1, host_mirror 11/0,
    host_find_plan 18/0, unicode 6/0, external 2/1, portable 13/1, wikilinks 3/2,
    wikilink_completion 3/1, images 5/2, tags 4/1, link_target 8/0, plain_note 2/1. Every
    remaining failure was traced to an assertion stating a CommonMark result or a behavior the
    Decisions changed (the log quotes each). Store lib on the core: 237 passed, 21 failed; five
    sampled are deliberate (typed `|` in a cell not escaped, renumbering only in-sequence
    items, equivalent mark spellings, a typed `\!` reads as an escape, `&amp;` not decoded);
    the rest is stage 4's sort.
  - Stage 4 must also: move the public find types out of `session/find.rs` (do not delete
    them); delete `quick_open`'s `rest_may_define`, `may_define_reference`,
    `quick_open/commonmark.rs` and their feature-gated tests; point the wasm consumers at
    `tests/fixtures/engine/`.
- After the stage 3 review (2026-11-13, a second agent checked stage 3):
  - The keyboard-input tests run on the core. `native_input_traces` (six real iOS keyboard
    recordings: Japanese, Korean, autocorrect, suggestion, paste) opened notes holding `&amp;`;
    the cases now write `&`, which shows the same, so every recorded range and result is
    unchanged and the raw captures keep their bytes. `compound_composition` used `&#32;` for
    two look-alike spaces: now literal spaces, the `\!` rows kept, two quote rows that pinned
    CommonMark's quote repair rewritten as Linedown quotes. Its "unchanged batch" test now
    states the core's rule: a batch that changes nothing writes nothing and leaves no undo
    step (the old engine saved once and kept an empty undo step).
  - Old bug fixed: a text-service batch during composition that changed nothing put the caret
    back where it was before composing, not after the input (`edit/compose.rs`).
  - Maintainer answers: 1A (property 2 as amended), 3A (a text service's or dictation's line
    break in a table cell becomes a space, as paste's does; `cell_service_text`), 4A (Indent
    takes the joined sub-list's whitespace, else a tab; `sub_list_space`). 2A (a language
    typed after a fence) is 2A-1, built in stage 5: see open question 9.
  - The brief's stage 4 now opens with a simulator pass over every command family.
  - Verified: `cargo test -p futo-notes-editor --features engine --lib engine::` 133 passed,
    1 ignored; TYPING_CASES=20000 properties on seeds 1 and 99, 5 passed, 1 ignored each;
    `--features engine` `native_input_traces` 1/0, `compound_composition` 5/0, `composition`
    17/2 (unchanged); the store's `native_input_traces` 1/0 with and without the switch; the
    wasm `wasm-native-input.mjs` consumer passes (old engine); the chain with
    `--no-fail-fast` 991 passed, 383 failed, 4 ignored (the six fewer failures are these two
    files on the old engine); clippy `--features engine --all-targets`: nothing in
    `src/engine/`. `node scripts/test-editor-wasm.mjs` stops at its first consumer,
    `wasm-consumer.mjs`, on `&acE;` (the old engine no longer decodes entities; stage 4's
    sort).
- Stage 4: done (answers 14B, 15A, 16A, 17B, 18A applied). `just check` green (full run, all
  14 steps); `just test-ios-native` 509 passed, 1 failed, 7 skipped (StoreKit): the failure is
  iOS drawing, an empty last list line's marker sits 0.25-0.5 pt lower than once text is typed
  (`trailingRow` in `TextFirstLayoutFragments.swift`; `TextFirstEmptyMarkerTests` "ordered-list
  on the empty last line"); not fixed, scope kept down (maintainer, 2026-11-13). Android has not
  been built against the new style surface (list rows, tags). On `linedown` since 71e97976c (branch `linedown-cutover`
  fast-forwarded).
  The log of what it did and how it was verified is `docs/plan/linedown-engine-rebuild-stage4.md`.
- Stage 5: not started. What is decided but not on `linedown`, and what is known and not fixed,
  is the "Gaps" section ending the stage 4 log; start there.
- Surface methods deleted, with reasons: `may_define_reference` and `quick_open`'s
  `rest_may_define` parameter (they served the CommonMark path's reference definitions; the
  core reads none). `EditorSession`'s other public methods all remain.
- Display rules that are not "text minus ranges" (stated in `engine/line.rs`):
  1. Frames: an opening fence or front matter line is hidden with its ending; a closing line
     with its own ending, or, on the note's last line, with the ending before it.
  2. An empty code block shows one empty line with no text behind it; so does front matter
     closed on the note's last line (the body).
  3. Typing on such a line writes a line ending, then the text, after the hidden line.
  4. A divider shows as one U+FFFC.
  5. Typing at a divider's edge writes the text on a line of its own beside the rule, in its
     quotes.
  6. Typing on an empty quote line with no space after its `>` writes that space first when
     the text as typed would unquote the line (`>` then `x` writes `> x`).
  Front matter lines and a table's delimiter row show their whole text; everything else hides
  its marker and inline syntax.
- Open questions for the maintainer (each lane took the conservative choice and pinned none):
  1. Answered 1A (approved): property 2 as amended (header of
     `engine/tests/properties/mod.rs`): with no carried formats, typing writes exactly the
     typed bytes at a source offset the caret's display point maps to (either side of hidden
     marks); under carried formats (a toggle, or the formats a space typed at a span's end
     carries) the display changes by exactly the typed text in those formats and only inline
     marks are written besides, because `__a __` would show underscores.
  2. Answered (2026-11-13, not built: stage 4 log, "Gaps"): a paste is cancelled only when it
     must be. Before: paste goes through the guard (cut does not: it is Backspace's deletion). A paste writes
     many lines at once and could restyle lines the user is not looking at; it names its lines
     plus the line above, so a pasted delimiter row still makes a header.
  3. Outside changes that touch, open or close front matter are refused by the history-keeping
     adoption, so a dirty draft parks a conflict copy (a clean session drops history and
     adopts). No hazard in rebasing through it was found. Keep refusing?
  4. A portable page asked to adopt its own text gets `UnrepresentableFormat` (the old engine
     sent an empty Append).
  5. Answered (2026-11-13, built unmerged: stage 4 log, "Gaps"): Enter repeats the number in a
     list numbered alike. Before: Enter in `1. a` above `1. b` writes `2.` (the Decision read literally), so a list
     numbered `1.` throughout gains a `2.`; Enter over two numbered items leaves the second's
     number as written.
  6. Answered 4A: Indent takes the whitespace of the sub-list it joins, else writes a tab.
  7. Answered (2026-11-13, built unmerged: stage 4 log, "Gaps"): Quote is an exact toggle
     (`> ## T`). Before: Quote on a heading or list item makes plain quoted text (`## T` -> `> T`), as before;
     Linedown could write `> ## T`, making Quote an exact toggle. Quote leaves blank lines at a
     selection's edges unquoted; a selection ending at a line's display start does not touch
     that line.
  8. Divider: where `---` would make line 1 open front matter, it writes `----`.
  9. Answered 2A-1, scheduled for stage 5 (brief, "Decided, not yet built"). After a typed ``` the line hides and the caret moves to the line
     below, so a typed `js` is code, not a language: at the note's end (```` ```\njs ````) and
     also mid-note (a blank line above `b` gives ```` ```\njsb ````; the stage 3 log's "mid-note
     it writes ```js" is wrong). Neither renderer draws a fence's language, though the
     projection carries it on each code line, so keeping the caret on the hidden fence line
     would make the typed language invisible.
  10. Answered (maintainer, 2026-11-13): no change. Taking code out of a block preserves how it
      looks, so `# x` comes out as `\# x` (`kept_line`); in and out are not exact opposites.
  11. Answered with 2 (copy closes a fence it opened; the rest stands). Paste: a block pasted into the middle of a numbered item repeats its number on the tail
      (`1. ab`, `- x`, `1. cd`); a block line pasted mid-text starts its own line (a line break
      the user did not paste); copy adds no closing fence when a selection ends inside code.
  12. Answered 3A: a text service's or dictation's line break in a cell becomes a space; a
      typed one still breaks the row.
  13. Images keep the old engine's explicit refusals (`<`, `>`, `\` in the reference; backtick,
      `[`, `]`, `\` in the alt) on top of "reads back as exactly that image". Loosen?
  14. Answered 14B (2026-11-13): in a cell a link destination's `|` is written `\|`; `\|` in a
      cell's code is a pipe (reader fixed, `lines/table.rs` `code_pipes`).
  15. Answered 15A: a key in a long line re-reads that line (about twice its length in counted
      work); on the Moto every key in a 50,000-character line takes 3.1-3.4 ms median, at most
      4.1 ms (long-regions.md), after fixing a deletion that walked the whole line (c1a02dd47).
  16. Answered 16A: Enter past a middle row's last pipe ends the table; that key is bounded by
      the table's bytes.
  17. Answered 17B: the store saves a note's exact bytes (27c1534dd); sync carries them as they
      are. Open: the desktop Milkdown editor still ends every note it edits with one `\n`
      (house style, ADR-0002), so a desktop edit brings back the empty last line a phone shows.
  18. Answered 18A: keep `tags` and the `Tag` style case; Android's renderer needs the case.
  19. Smaller, none failing: a line `\u{feff}---` (byte-order mark) is not front matter; Select
      All then Delete on a note that starts with a code block leaves an empty code block (the
      frame rule; the old engine left an unclosed fence); a selection during composition covering
      only a `*` the commit hides becomes an insertion; Bold or Code at a divider caret does
      nothing; tags.md says no tag inside a link destination but the reader reads `#y` in `[a](<x #y>)`; `header_tags`
      starts after front matter but `extract_header_tag_block` (Rust and TS) at byte 0; the
      one guard compares only lines a command does not name (a blanket "named lines keep their
      kind" rule would break Quote over a table; the link commands check cells themselves).
