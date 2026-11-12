# Engine rebuild on the line reader: handoff brief

You are rebuilding the internals of `crates/futo-notes-editor` on the new line reader. This brief
replaces the "Parse sites", "Types", "Rows", "Writer" and "Commands" bullets of step 2 in
`docs/plan/linedown.md`. Everything else in that plan still holds, including its Decisions list.
Tracks #423. Delete this file in the commit that finishes stage 4.

The work is larger than one context window. Work one stage at a time, commit at the end of each,
and keep the Status section at the bottom current so a fresh session can resume from this file
alone.

## Where you work

- Worktree `/home/justin/Developer/futo-notes-linedown`, branch `linedown`. Do not work in the
  primary checkout. Never `git stash` here (the stash is shared by every worktree).
- Read first, in this order: the repo `AGENTS.md`, `crates/futo-notes-editor/AGENTS.md`,
  `docs/plan/linedown.md`, `docs/spec/editor/portable-core/linedown.md`,
  `docs/spec/editor/portable-core.md`.
- The line reader is `crates/futo-notes-editor/src/lines/`. It is finished and tested
  (`tests/fixtures/linedown/`, 103 cases). Build on it; change it only to fix a bug a fixture
  proves.

## State of the branch when this was written (2026-11-12, commit 372ca9d9e)

- The old engine is half-moved onto the line reader (commits `1761ffa46`, `d43d08970`,
  `db151555c`). 374 of 783 editor tests fail. They pin CommonMark results or run through the old
  command code.
- Do not repair the old engine and do not try to make those tests pass against it. It is deleted
  in stage 4.

## Decisions already made (maintainer, 2026-11-12). Do not reopen them.

1. **Build beside, then cut over.** The new engine is a new module inside the crate that nothing
   calls until stage 4. The old `session/` and `inline/` stay in place, untouched, until then.
   Code does not name the dialect: pick a plain module name such as `engine`.
2. **The note's text is the only stored text.** There is no stored display copy and nothing is
   tracked across edits. After an edit, re-read the changed lines and compute each line's display
   from that line's text and its reading: the line's text with its hidden ranges removed. A
   position converts by finding its line, then subtracting the hidden ranges before it. Keep a
   per-line length index so finding the line does not walk the note.
3. **Markers stay hidden at all times.** The editor must feel like a rich-text editor. Showing
   markers on the caret's line was tried and rejected.
4. **Every command has one shape:** it takes the lines it is pointed at and the selection, and
   returns text edits plus a new selection. It edits the lines it names and nothing else.
   Numbered-list renumbering is the one allowed exception, exactly as the plan's Decisions state.
5. **One undo mechanism:** the reverse text edits plus selection, affinity and carried formats.
   No per-command undo code.
6. **One guard for all commands.** After a command's edits, re-read the touched lines forward
   until the reader's carry settles. If a line the command did not target now reads as a
   different kind of block, or a fence or front matter opened or closed that the command did not
   intend, cancel: no edit, no history entry. This replaces every per-command check of the
   "never damages a table" sort. The guard never applies to typing: a typed character always
   lands, as typed.
7. **Nothing is escaped because of what is typed, and no HTML entity is ever written.** One small
   function decides whether a command must write a leading `\` to keep a line the block the
   command intends (removing the bullet from `- # todo` writes `\# todo`).
8. **Old tests may be deleted.** Data-safety guarantees are kept, covered by fresh tests.

## What stays the same: the surface

Callers must keep compiling against the crate's public exports in `src/lib.rs`: `EditorSession`,
`PortableSession`, the UTF-16 entry points in `coordinates.rs`, `host/`, and `wasm.rs`. Callers
are `crates/futo-notes-store` (41 files), `crates/futo-notes-ffi` (14), `apps/tauri` (2),
`crates/futo-notes-sync` (1) and the `tests/wasm-*.mjs` consumers.

Two kinds of change to the surface are approved:

- `StyleSpec::ListRow` and `ListDescription` report the line's own indent in columns and the
  marker text as typed, with no depth and no computed number (plan, "Host and FFI").
- A method that exists only to serve the old model (refused list shapes, repair planning,
  entity spelling) may be deleted instead of reimplemented. List each one in Status with one line
  on why, so the maintainer can review them.

Any other surface change: stop and ask.

## The five properties

Write these first, as property tests over random edit sequences. Seeds and case counts come from
environment variables, as `TYPING_CASES` and `TYPING_SEED` do today. Run them on generated notes
and, read-only, on the directories the comparison run already uses (`LINES_COMPARE`).

1. Opening a note and saving it without an edit changes no bytes.
2. Typing changes the note by exactly the typed bytes, at the position the caret maps to.
3. Undo restores the exact bytes and the exact selection; redo restores the edit.
4. The reading and the display after any edit equal the reading and display computed from
   scratch on the resulting text.
5. A position converted from text to display and back is unchanged, for every position that is
   not inside a hidden range. UTF-16 conversions never split a surrogate pair and never clamp.

These five replace most of the old suite. Literal before-and-after cases cover the rest.

## Stages

Each stage ends with a commit (`type(scope): summary`, body with a `Verified:` line listing the
commands run and their pass counts) and a Status update. Report exact counts, never "tests pass".

### Stage 1: the core, no commands

Text storage, the reader wired in with its incremental re-read, per-line display, position
conversion, selection and movement, plain typing, deletion, composition, undo and redo.

Two places where display is not "text minus ranges" need an explicit small rule each. Look for
others as you go and add them here:

- hidden fence lines, so the display has fewer lines than the note;
- an empty code block, which shows a caret position with no text behind it.

Done when the five properties pass and the new module has no reference to `pulldown_cmark`,
`inline/` or the old `session/`.

### Stage 2: one slice through to iOS

Put the core behind the surface on a build flag or test-only switch that never ships, far enough
that one path works end to end: open a note, type a list item, save. Carry the new indent and
marker fields through `crates/futo-notes-ffi/src/editor/host.rs`, and draw them in
`apps/ios/Sources/Editor/TextFirst/` (plan, "iOS"). Run it on an iOS simulator through
`just puppet` (load the `puppet` skill, and read `apps/ios/AGENTS.md` first). The Mac is reached
over SSH; if it is unreachable or a step needs code signing, stop and say so.

The point of this stage is to find out early whether the new shape is wrong. If it is, fix the
shape before stage 3. If the change needs a new `BRIDGE_VERSION` or changes `AppState` or the
sync payload, stop and ask.

Done when a screenshot shows `3)` drawn as `3)` and an unevenly indented list drawn at its own
indents, and the saved file holds exactly what was typed.

### Stage 3: commands, one family at a time

Order: lists (Enter, Enter at item start, indent, outdent, join, Backspace, renumbering), heading
and quote toggles, divider, inline formatting and links, paste and clipboard, tables, fences and
code, images, wikilinks and tags, find.

For each family:

1. Write a table of literal cases first: text and selection before, the command, text and
   selection after. Seed it from the plan's "Command behavior that changes" table, the plan's
   "Paused and open work" tickets (each dead ticket becomes a case), and the spec file for that
   family in `docs/spec/editor/portable-core/`. Prefer extending the shared JSON fixtures in
   `tests/fixtures/` (the `tests/wasm-*.mjs` consumers run them too).
2. Implement the commands in the one shape, behind the one guard.
3. Rewrite or delete the spec lines for that family in the same commit (the M19 rule: spec moves
   with behavior). `typed-escapes.md` is deleted.

A bug you find in old behavior is fixed in the new engine and named in the commit body. Do not
keep a "found, not fixed" list.

### Stage 4: cut over and delete

1. Point the surface at the new engine. Remove the stage 2 switch.
2. Sort the old tests by file. A starting sort, to be confirmed by reading each file:
   - **Must pass unchanged** (they do not depend on the dialect): `native_input_traces`,
     `composition`, `compound_composition`, `compose_after_break*`, `history`, `find`,
     `host_mirror`, `host_find_plan`, `unicode`, `external`, `portable`, `wikilinks`,
     `wikilink_completion`, `images`, `tags`, `link_target`, `plain_note`. If one of these fails,
     the new engine is wrong unless the failing assertion states a CommonMark result; say which.
   - **Delete and replace with the stage 3 tables:** `lists`, `blocks`, `fences`, `inline`,
     `paragraphs`, `reinterpretation`, `typed_tag_source`.
   - **Mixed, go test by test:** `clipboard`, `tables`, `cross_block_selection`, `long_regions`.
   The same sort applies to the store's `editor_session` tests (104), the FFI editor tests (66)
   and the shared list fixtures (224 cases).
3. Before deleting a test about saving, undo, crash recovery, external changes or merge, write
   one line in the commit body saying which new test now holds that promise.
4. Delete the old `session/` internals, `inline/`, the `pulldown-cmark` dependency,
   `vendor/pulldown-cmark` and its `[patch.crates-io]` entry. Move the comparison run's old
   reader out with it; the run's last result is on #423.
5. Then the remaining items of the plan: tags and search agree with the editor (Rust, the
   TypeScript mirror and `tests/conformance/tags.json` in one commit; `packages/editor/AGENTS.md`
   owns the procedure), and step 3's "nothing mentions setext, lazy continuation, reference
   definitions, footnotes or entities" check.

Done when `just check` passes on the branch and the iOS simulator shows the spec's examples
correctly.

## Rules that hold throughout

- Counted-work budgets in `tests/long_regions*` and `tests/inline/work.rs`: measure before and
  after. No budget goes up. No speed work beyond that.
- Files are never rewritten to fit the dialect. Reading never renumbers.
- No Markdown rule is added to Swift or Kotlin. Renderers draw what the engine sends.
- Size check at the end of stage 3: compare the new engine's production lines with the old
  `session/` plus `inline/`. If it is not well under the old size, stop and report where the
  lines went before cutting over.
- Verify with `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core` during
  stages 1 to 3, `just check` at stage 4. The comparison run is
  `cargo test -p futo-notes-editor --lib lines::compare -- --ignored --nocapture` with
  `LINES_COMPARE` set; it is read-only and its example output is private note text, so keep it
  out of the repo.
- Tooling friction is a papercut: `papercuts add "<what you hit>" --tag <area>`, then carry on.

## Stop and ask

- A change to `BRIDGE_VERSION`, `AppState` or the sync payload.
- A surface change other than the two approved kinds above.
- A behavior the spec does not settle. Three are already open on #423 and none blocks you: an
  indented `> text`, a backtick fence whose info text contains a backtick, and a delimiter row
  whose cell count differs from the header. Keep what the reader does today and do not write
  fixtures that pin either answer.
- Merging to main. Pushing the `linedown` branch as a backup is fine.
- Two failed approaches to the same problem: write the competing explanations and run the
  cheapest test that tells them apart before a third attempt.

## Status

Update this section at the end of every stage, and whenever you stop mid-stage.

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
- Stage 2: not started. The core has no projection yet: stage 2 builds `ProjectionSlice`
  (runs, blocks, links, wikilinks, atoms) and `StyleSpec::ListRow` from the engine's lines.
- Stage 3: not started.
- Stage 4: not started.
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
- Open questions for the maintainer: none yet.
