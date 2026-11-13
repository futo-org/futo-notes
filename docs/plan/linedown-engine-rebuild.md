# Engine rebuild on the line reader: handoff brief

You are rebuilding the internals of `crates/futo-notes-editor` on the new line reader. This brief
replaces the "Parse sites", "Types", "Rows", "Writer" and "Commands" bullets of step 2 in
`docs/plan/linedown.md`. Everything else in that plan still holds, including its Decisions list.
Tracks #423. Delete this file in the commit that finishes stage 5.

The work is larger than one context window. Work one stage at a time, commit at the end of each,
and keep the status file (`docs/plan/linedown-engine-rebuild-status.md`) current so a fresh
session can resume from these two files alone.

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

Four pieces are not command families but the core still lacks them. Under the stage 2 switch
they do nothing or are refused today. They are part of stage 3:

- **Taking in a change made outside the editor** (a sync or another program changing an open
  note; `session/external.rs`, `tests/external.rs`). Today it is refused, so the save parks.
  This is data safety: do it first, before the list family. Its tests state the promise: no
  typed text and no outside change is lost, and undo still restores exact bytes.
- **Opening only the start of a large note** (`quick_open.rs`, `tests/quick_open.rs`). Today a
  note opens whole.
- **Wikilink completion, relinking and note ids** (`session/wikilink_completion.rs`,
  `session/relink.rs`, `session/note_ids.rs`). Do these with the wikilinks and tags family.
  Wikilinks also resolve their targets again; today the label stands in for the target.
- **Work counting.** `EditWork` reports only inserted bytes today. Fill in the counts the old
  engine reported, before any command family lands, so the budgets in `tests/long_regions*`
  and `tests/inline/work.rs` can be measured as each family is added.

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

1. Before anything is deleted, run each stage 3 command family on an iOS simulator with the
   `engine` switch on (`FUTO_EDITOR_ENGINE=1`, `just puppet`, as in stage 2): lists, heading
   and quote, divider, inline formatting and links, paste and clipboard, tables, fences and
   code, images, wikilinks and tags, find, and an outside change to an open note. Every stage 3
   result so far is a Rust test. Record per family what was pressed, a screenshot, and the saved
   file's bytes. A family that misbehaves is fixed before step 2.
2. Point the surface at the new engine. Remove the stage 2 switch.
3. Sort the old tests by file. A starting sort, to be confirmed by reading each file:
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
   A test of keyboard input (`native_input_traces`, replaying real iOS keyboard recordings,
   with its store and wasm copies; `composition`, `compound_composition`) is ported, never
   deleted for a dialect difference: change the note text it opens, not the recorded input.
4. Before deleting a test about saving, undo, crash recovery, external changes or merge, write
   one line in the commit body saying which new test now holds that promise.
5. Delete the old `session/` internals, `inline/`, the `pulldown-cmark` dependency,
   `vendor/pulldown-cmark` and its `[patch.crates-io]` entry. Move the comparison run's old
   reader out with it; the run's last result is on #423.
6. Then the remaining items of the plan: tags and search agree with the editor (Rust, the
   TypeScript mirror and `tests/conformance/tags.json` in one commit; `packages/editor/AGENTS.md`
   owns the procedure), and step 3's "nothing mentions setext, lazy continuation, reference
   definitions, footnotes or entities" check.

Done when `just check` passes on the branch and the iOS simulator shows the spec's examples
correctly.

### Stage 5: cleanup and iOS follow-ups

Cleanup, with no behavior change:

1. Give the line reader a way to be told that a later line closes front matter, and remove the
   workaround in `engine/line.rs` `Entry::read` that appends a made-up `---` to line 1's text.
2. Remove what the cut-over left behind: the list-field shim the old tests and the wasm list
   consumer read through (depth = indent/2+1), `#![allow(dead_code)]` in `engine/mod.rs` and
   `lines/mod.rs`, and any export in `src/lib.rs` that nothing calls.
3. Sweep the new code's comments: delete the ones that restate the code, keep the ones that
   justify a decision.
4. Update `crates/futo-notes-editor/AGENTS.md` so it describes only the engine that exists.
5. Report the final size: production lines of the new engine against the old `session/` plus
   `inline/`, counted separately from tests.

iOS follow-ups. Each is a visible change, so put the choice to the maintainer as numbered
options with a simulator screenshot of each before changing anything:

- **Tab indent width.** A column draws at 12 points and a tab is four columns, so a tab-indented
  list steps 48 points a level, double the 24 it drew before. The Indent button writes a tab, so
  every list nested in the app gets the wider step. Options: keep 12 points a column; or 6
  points a column, so a tab matches the old step and two spaces draw at 12.
- **Bullet shapes.** Every bullet is a filled dot now. The disc, ring and square by depth went
  because the phone no longer knows depth, and Swift must not work nesting out. Options: keep
  the dot; or pick the shape from something the engine already sends, such as the marker as
  typed.

Done when `just check` passes, the maintainer has answered both iOS choices and the answers are
drawn, and this file is deleted in the final commit.

## Rules that hold throughout

- Counted-work budgets in `tests/long_regions*` and `tests/inline/work.rs`: measure before and
  after. No budget goes up. No speed work beyond that.
- Files are never rewritten to fit the dialect. Reading never renumbers.
- No Markdown rule is added to Swift or Kotlin. Renderers draw what the engine sends.
- Size check at the end of stage 3: compare the new engine's production lines with the old
  `session/` plus `inline/`. If it is not well under the old size, stop and report where the
  lines went before cutting over.
- Verify with `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core` during
  stages 1 to 3, `just check` at stages 4 and 5. The comparison run is
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

The Status section lives in `docs/plan/linedown-engine-rebuild-status.md` (this file outgrew the
repo's per-file size limit). Update it at the end of every stage, and whenever you stop
mid-stage; a fresh session resumes from the two files. Delete it with this one.
