# Engine rebuild: stage 4 log

What the cut-over did and how it was verified. The status file is
`docs/plan/linedown-engine-rebuild-status.md`; delete this file with it.

- Step 1, simulator pass (`FUTO_EDITOR_ENGINE=1`, futo-qa-1, all 11 families, real key
  presses; report and screenshots in `~/.local/state/linedown-stage4/`, outside the repo):
  every command that reached the engine saved the fixture's bytes, except typing inside an
  image after Undo. Six misbehaviours, five fixed on `linedown-fix-ios` and re-checked on the
  simulator: the caret entered an image's hidden reference after Undo and typing corrupted it
  (iOS kept a stale `pendingEdit` after an engine-handled Backspace, so it ignored caret moves;
  the core now also types at an image's edge, `outside_images`); Indent/Outdent state went
  stale on caret moves (same cause); the cell editor stayed on the old cell after a typed `|`;
  tags were not coloured (the projection gained `tags`, the style plan a `Tag` span: question
  18); the empty line after a code block drew grey. The sixth, an outside change that parked a
  conflict copy with nothing lost, is within recovery.md's conservative-ambiguity rule.
  Not drivable on iOS: a Divider button and table row/column controls do not exist there.
- Step 2: `EditorSession` is a thin layer over `engine::Engine` (`src/session.rs`,
  `src/session/{commands,external,find,types}.rs`, `src/coordinates.rs`). The switch is gone
  (cargo feature, `FUTO_EDITOR_ENGINE`, `on_next!`, `session/next.rs`).
- Step 3, the sort: `lists`, `blocks`, `fences`, `inline`, `paragraphs`, `reinterpretation`,
  `typed_tag_source` deleted; the rest sorted test by test (each CommonMark rule named in the
  agents' reports); the 11 old shared JSON fixtures deleted (no reader left); store
  `list_actions.rs` and `seams.rs` deleted as duplicates of the FFI tests that now replay
  `tests/fixtures/engine/`. Keyboard-input tests ported, none deleted. WASM: the block and list
  consumers replay `tests/fixtures/engine/` through the compiled session and the store worker
  (`tests/wasm-fixture-replay.mjs`, 561 cases); the seam consumer is deleted.
- Step 4, promises of deleted tests about saving, undo, recovery, outside changes or merge:
  undo/redo of every command → each family's fixture run in `src/engine/tests/` (undoes and
  redoes every case) and `engine::tests::properties::the_five_properties_hold_over_random_edits`
  (property 3); saving through the store → `crates/futo-notes-ffi/tests/editor_list_actions.rs`
  (159 cases, save and reopen) and `editor_seams.rs`; outside changes →
  `src/engine/tests/external/` (unchanged by the sort); `tests/inline/work.rs`'s budget →
  `engine::tests::inline::typing_far_into_a_long_note_costs_no_more_work_than_the_old_engine`.
- Step 5: deleted old `session/` internals, `inline/`, `movement.rs`, `parallel.rs` (and
  rayon), the table scanner, `quick_open/commonmark.rs`, `rest_may_define` and
  `may_define_reference`, the comparison run (`lines/compare/`, its last result is on #423),
  pulldown-cmark, `vendor/pulldown-cmark` and its patch entry, `unicase`.
- Step 6: tags and search read code and front matter as the line reader does (Rust, the TS
  mirror and 34 new `tests/conformance/tags.json` goldens in one commit, d50fc7c9d; search's
  `extract_tags_inline` uses the tags crate). Nothing in the crate's code mentions setext,
  lazy continuation, reference definitions, footnotes or entities.
- Engine and store bugs found and fixed (old or new behavior), each with a regression case:
  deleting what lies between two same-spelled spans wrote `**ab****cd**`; editing a link's
  label across table cells deleted the table's other rows; unlinking several links did
  nothing; `|` lines outside tables were skipped by link and format commands; a correction
  during composition landed a character late when the commit hid a mark; a composition
  commit's line break broke a table row (3A); a text-service replacement while text was
  marked deleted hidden quote markers, even two lines away; a text-service run into code
  moved a `_` closer into the code; a completion ending in a space under formats wrote
  visible `**hello **`; a carried format formatted part of a word in link text; a space at a
  span's end through a host range landed inside the marks; clearing a formatted selection
  dropped the carried format; a line typed at the end of a note with no final line ending
  was never saved (the store compared modulo the final ending).
- Spec: `foreign-content.md` and `long-regions.md` rewritten; every `→` reference in
  `docs/spec/` points at existing code; links, tables, inline, input, tags, images, recovery
  lines updated with behavior.
- Verified at 71e97976c: `cargo test -p futo-notes-editor -p futo-notes-store -p
  futo-notes-ffi -p futo-notes-core --no-fail-fast` 1,035 passed, 5 failed (questions 14-17),
  3 ignored; TYPING_CASES=20000 properties seeds 1 and 424242, 5 passed, 1 ignored each;
  read-only on the vault (2,775 notes, 91,081 lines) and the ML corpus (30,995 notes,
  1,851,015 lines) all five properties hold; `node scripts/test-editor-wasm.mjs` exit 0;
  `just check` stops only at `test-rust` on those tests, and its other steps (arch-gate,
  sync-contract, conformance, license, differential, fmt, clippy, eslint, svelte-check,
  prettier, vitest, tsc, build) pass when run alone; `just test-ios-native` 81 of 81 on the
  iOS lane's five suites; a final simulator smoke of 71e97976c (not the switch: the core is
  the only engine) drew `3)`, `10)`, uneven indents, a coloured tag, code and a table, and
  saved exactly what was typed.
- After the answers (2026-11-13): 14B (`\|` in a cell's destination; `\|` in a cell's code is a
  pipe, reader fixed), 15A (long-line bound; on the Moto every key in a 50,000-character line
  3.1-3.4 ms median, at most 4.1 ms, after c1a02dd47 stopped a deletion walking the whole line),
  16A, 17B (the store saves exact bytes, 27c1534dd; sync carries them; the desktop Milkdown editor
  still ends a note it edits with `\n`), 18A; typing on an empty `>` line writes `> x` (display
  rule 6). The whole iOS unit suite was then sorted (17351eede): 486 passed, 14 failed and two
  crashes (stale test mirrors) before; 509 passed, 1 failed after.

## Gaps at the end of stage 4 (2026-11-13), for the agent that picks this up

Stage 4 is done on `linedown` (fef45d964, `just check` green). Everything below is not on
`linedown`. Each entry says what is decided, what exists, and what is left. Answers are the
maintainer's, 2026-11-13; do not reopen them. Question numbers are the status file's.

Decided, partly built on branch `linedown-answers` (worktree
`/home/justin/Developer/futo-notes-linedown-answers`, based on fef45d964, not pushed, not
reviewed, full chain not run; the agent was stopped mid-task):

- **Q5, Enter in a list numbered alike.** When the item below carries the same number as the
  caret's item (`1.` on every item), Enter writes that number again; otherwise it counts up.
  Built: 28c09c9dc. Left: review, run the chain, merge.
- **Q7, Quote is an exact toggle.** Quote keeps a heading's or list item's marker (`## T` ->
  `> ## T`, `- a` -> `> - a`) and unquote returns the original bytes. Built: f0b222c96. Left:
  review, confirm on the simulator that a heading and a list item draw inside a quote, merge.
- **Q2 and Q11, paste is cancelled only when it must be.** Copy closes a fence its text opened;
  a plain paste outside tables lands as typing does, even when it restyles lines below (no
  guard). The table-cell paste rules stay. One undo step, exact bytes back. Half-written and
  uncommitted in that worktree (`engine/commands/clipboard/{copy,mod,paste}.rs`,
  `engine/tests/clipboard/rules.rs`, `fixtures/engine/clipboard/copy-and-cut.json`): read the
  diff before trusting it. Q11's other two points stand as they are (a block pasted mid-item
  repeats the number on the tail; a block line pasted mid-text starts its own line).

Decided, not started:

- **List levels (replaces the brief's "no depth" rule).** The same list nested with tabs, two
  spaces or four spaces draws the same. Display only: no byte changes. The carry each line
  hands the next also holds the open list's stack of ancestor indent widths (columns, a tab is
  four); a list line's `level` is the number of entries narrower than its own indent, then it
  pops entries at or above its indent and pushes itself. To pin: what ends the stack (blank
  lines inside a list do not), and how an indented plain line takes a level. The surface gains
  an integer `level` on `ListDescription`, `StyleSpec::ListRow` and `EditorStyleSpan::ListRow`
  beside `indent` and the marker text (approved). Bounds, each a work test: a key that changes
  no indent costs the same in a 20,000-item list as in 1,000; Indent or Outdent of one item
  costs its subtree. The guard compares block kind, never level. If the bounds cannot be met,
  stop and report.
- **iOS list drawing (answers the brief's two stage 5 iOS follow-ups).** 24 points a level,
  not a column; the bullet's shape from `level % 3` (disc, ring, square). Swift reads `level`
  and works out no nesting. Needs list levels first. Proof: one note with a three-level list
  written with tabs, two spaces and four spaces, drawn identically, and the saved bytes as typed.
- **Q9, a language typed after a fence** (answer 2A-1; the brief, "Decided, not yet built").

Known and not fixed:

- `just test-ios-native`: 1 failure, `TextFirstEmptyMarkerTests` "ordered-list on the empty
  last line" (an empty last list line's marker sits 0.25-0.5 pt low; `trailingRow` in
  `TextFirstLayoutFragments.swift`).
- Android has not been built against the new style surface (list rows, the `Tag` case, and
  `level` once it lands).
- The desktop Milkdown editor ends every note it edits with `\n`, so a desktop edit brings
  back the empty last line a phone shows (Q17). Accepted until desktop moves to Linedown.
- Two tags defects from Q19, to be filed as GitLab issues (not filed yet) and fixed outside
  this branch: `header_tags` starts after front matter while `extract_header_tag_block` (Rust
  and its TS mirror) starts at byte 0; tags.md says no tag in a link destination but the
  reader reads `#y` in `[a](<x #y>)` (make the reader match the spec). Reproduce each before
  filing.

Left as the lanes chose (the maintainer saw them and asked for no change): Q3, Q4, Q8, Q13,
and Q19's other points. Q10 is answered: no change.

Stage 5's cleanup list (the brief) is untouched and does not block merging to `main`.
