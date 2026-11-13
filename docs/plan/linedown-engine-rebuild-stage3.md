# Engine rebuild: stage 3 log

What each family landed, merged into `linedown` in this order. The status file is
`docs/plan/linedown-engine-rebuild-status.md`; delete this file with it.

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
- Merged: tables (`engine/commands/tables/`, 86 cases plus a random run over uneven rows,
  open-ended cells, escaped pipes and CRLF). Inspection reads the line readings; the table is
  as wide as its widest row (#419: an extra cell is a column you can edit and Tab into). Table
  keys move between cells as selection changes (no history); entering a cell a short row lacks
  fills empty cells up to it; leaving the last row appends one. In a cell, Enter/Tab are the
  table's; a Backspace or Delete that would remove a pipe or join two rows does nothing. Row and
  column commands touch only whole cells at their pipes. `cell_paste` is the clipboard's
  helper. A key command with no edits now moves the selection; one that leaves the selection
  where it is changes nothing (fixed after the merge: lists' "Enter changes nothing" cases).
  Old bugs fixed: inserting a column or filling a row whose last cell had no closing pipe wrote
  ` |` into that cell; deleting a last open cell removed the pipe before it; deleting a
  column whose only cell was open left `|  `. Budgets: the pipeless-tail case 4,041 -> 37
  (those lines are plain now); typing in a middle cell of a 20,000-row table 3,201 -> 302,
  the same as at 100 rows.
- Merged: inline formatting and links (`engine/commands/inline/`, 94 cases). A collapsed toggle
  sets the carried formats; typing there writes the marks around what is typed (a space at a
  span's end lands outside, the next letter rejoins). A selection toggle works per line and per
  table cell; each spelling is read back on its line and kept only if the visible text and every
  other character's formats are unchanged; nothing is escaped; `__`/`_` only where `*` cannot
  open or close. Links: inspect, set, edit, unlink; destination plain, else `<...>`, else `\`
  escapes, chosen by read-back. Old bug fixed: deleting `c` from `**b c**` left `**b **`; it now
  writes `**b** ` (except at a line start, where the space would indent the line). Budgets:
  select-all bold over 1,000 sections, metadata items 883,613 -> 17,000; distant typing 501-602
  -> 18. Spec: formatting lines moved to the new `inline-formatting.md`.
- Fixed after the inline merge: marked text draws in the formats it will commit with
  (`Engine::marked_runs`); under the switch compositions reported no runs.
- Old tests the brief says must pass unchanged, on the core after the inline merge
  (passed/failed): native_input_traces 0/1, composition 11/8, compound_composition 0/5,
  compose_after_break 1/0, compose_after_break_review 0/4, history 8/9, find 4/1 (3 rows
  CommonMark), host_mirror 11/0, host_find_plan 18/0, unicode 4/2, external 2/1, portable 12/2,
  wikilinks 3/2, wikilink_completion 3/1, images 5/2, tags 4/1, link_target 8/0, plain_note
  2/1. Being triaged: composition group (inline lane), history/native traces/unicode/
  plain_note/external/portable (external lane), wikilinks/completion/tags (wikilinks lane),
  images (images lane).
- Must-pass triage, merged:
  - Images: the old engine's explicit refusals are back on top of read-back (`<`, `>`, `\` in
    the reference; backtick, `[`, `]`, `\` in the alt). `tests/images.rs` now fails only on
    CommonMark-only assertions (formatting inside an image's alt, reference images, a
    4-space-indented line as code).
  - Composition (inline lane): committing marked text replaces only what differs from the
    display (`hall**way**` reconverted kept its bold), an unchanged commit writes nothing, a
    commit at bold's end joins it, multi-run `replace_many` is `Engine::replace_runs` (marked
    text commits first). composition 17/19; the 2 left: `&amp;` decoding (CommonMark) and Enter
    at a span's end (clipboard lane's Enter split). compound_composition 0/5, all `&#32;`.
  - Outside-change lane: input at a caret the host placed now stands where a fresh select
    would (typing at the end of `__日__` wrote `__日__a`); collapsing a selection never leaves
    the caret inside a grapheme; a space typed at a bold/italic/strike span's end lands outside
    its marks and carries the span's formats, so the next letter rejoins it (Decision 3: markers
    stay hidden). history 12/17 (left: `&amp;` x3, quoted fences, `4. ## x` as a heading),
    unicode 6/6, native_input_traces fails only on the entity trace, plain_note 2/3 (indent
    shown as text), external 2/3 (unfinished-URL model), portable 12/14 (clipboard; link
    destination spelling).
  - Wikilinks lane: no core bugs; wikilinks 3/5, wikilink_completion 3/4, tags 4/5, all
    dialect changes (lone CR is not a line end; 4-space code, raw HTML; wikilinks before links;
    a wikilink's text is its target).
- Merged: paste and clipboard (`engine/commands/clipboard/`, 138 cases in
  `tests/fixtures/engine/clipboard/` plus carried-format cases). Copy exports exact source
  (whole lines carry their markers, a cut span is closed or reopened, the first line's indent
  comes off every line). Cut is Backspace's deletion as one undo step and carries the cut
  text's formats. Paste writes the text as given (line endings take the caret line's; one
  trailing ending dropped; no escapes, entities or blank lines), lines after the first take
  the caret line's quote prefix, a pasted list takes the caret line's indent, a fence the paste
  opens is closed, code takes text verbatim, a single-cell table paste joins lines with spaces
  and writes `\|`, and a one-line paste takes carried formats (a link under Bold saves
  `**[x](u)**`). Paste runs behind the guard. Enter on a plain line now splits the marks it
  cuts (`**bo|ld**` -> `**bo**`, `**ld**`) with the one helper lists and blocks share
  (`engine/commands/marks.rs`). Old bug fixed: under the switch copy, cut and paste ran on the
  old engine's empty state. Budget: 4,000 lines pasted into 10 or 20,000 paragraphs, 110,451
  -> 62,672 parsed plus copied bytes, the same at both sizes.
- Fixed after the merges: a caret is never pinned inside hidden syntax (an edit could leave it
  inside a link's destination, where typed text did not show); the "not yet" stub went.
- The wikilinks merge put `engine/mod.rs` over the size limit: selection and movement moved
  to `engine/selection.rs`, UTF-16 conversions to `engine/utf16.rs`, verbatim.
- Rule kept, noted by the fences lane: typing after a ``` that is the note's last line goes
  into the empty code block's body (display rule 3), so `js` there writes "```\njs", not a
  language; mid-note it writes "```js".
