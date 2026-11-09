# Tables: cells, keys, rows and columns

These are the portable replacement core's contracts. The shipping Milkdown editor keeps
its interaction contract until renderer integration; the behavior below matches it
(`../interactive-elements.md`, `../markdown-house-style.md` "Tables"). Views never spell pipes
or the delimiter row.

- A root-level GFM table is a header line, a delimiter line with the same cell count, and the
  nonblank lines after it up to a line that starts another block (quote, ATX heading, fence,
  rule, list item). Tables inside quotes, lists or fences are not recognized and stay ordinary
  text. Unescaped `|` delimits cells; `\|` stays in the cell. Alignment comes from the delimiter
  cells. → crates/futo-notes-editor/src/table.rs, crates/futo-notes-editor/tests/tables.rs
- Table inspection projects cells in the note's own display coordinates, so one selection serves
  the note and the cell view. A cell's content excludes edge padding; the focused cell and the
  structural commands that apply (header row cannot be deleted or have a row inserted above it,
  the last body row and last column cannot be deleted; deleting down to one column keeps pipes
  on every row, so a pipeless table stays a table) are reported as plain state. A body row
  shorter than the header lists only the cells it has. → crates/futo-notes-editor/src/session/blocks/tables.rs
- Every input path whose range lies inside one cell (typing, compound replacement, IME commit,
  OS replacement/autocorrect, paste) writes `|` as `\|`, turns line breaks into spaces, and keeps
  inline formats; an edit that would leave the cell or change the pipe count (a typed backslash
  before a pipe) is refused whole, so no other cell's bytes change. Only input holding `|`, `\`
  or a line break reads the table. Paragraph Enter and Shift+Enter in a cell are the table's
  Enter and Shift+Enter below (a move to the cell below is a selection-only change at the same
  revision). There is no cell-specific input entry point. → crates/futo-notes-editor/src/session/blocks/tables.rs, crates/futo-notes-editor/src/inline/edit.rs
- Clearing a cell retains its row, column, neighboring cells and carried formats. If a missing outer border would make the cleared cell's separator become a border or remove a pipeless body cell, the engine adds only the necessary border pipes in the same accepted edit and Undo step; the resulting caret remains in the cleared cell. This structural spelling does not change typed-pipe escaping or permit user input across cell boundaries. → crates/futo-notes-editor/src/session/blocks/tables/input.rs, crates/futo-notes-editor/tests/table_cell_structure.rs
- Tab and Shift+Tab select the next/previous cell's content (Tab in the last cell appends a row;
  Shift+Tab in the first cell is left to the host). Enter selects the cell below, and on the last
  row appends a row and enters the same column. Mod+Enter leaves a blank line and an empty line
  after the table with the caret on the empty one. Shift+Enter writes a literal `<br>`. A short
  body row gains its missing cells when navigation enters it. Navigation alone is a selection
  change with no history; every edit is one accepted source replacement and one Undo step.
  → crates/futo-notes-editor/src/session/blocks/tables/keys.rs
- Row and column insertion and deletion write only the affected rows' bytes, in one contiguous
  replacement, using the neighboring line ending and style; untouched cells, alignment markers and
  a missing final newline keep their exact spelling. New cells are `  ` (and `---` in the
  delimiter row); a header-only table gains its first body row below the delimiter. Alignment
  changes and row/column reordering are deferred. → crates/futo-notes-editor/src/table.rs, crates/futo-notes-editor/tests/tables.rs
- Plain-text paste inside one cell drops edge blank lines, turns inner line breaks into one space,
  keeps edge spaces and tabs, and never reaches another cell; one paste is one history action
  and a refused acceptance changes nothing. Multi-cell/grid paste is deferred; a selection that
  crosses cells is refused. `paste_markdown` tries the cell first in the engine, so every wrapper
  inherits it: a table selection pastes into the cell, a cross-cell selection is refused, and
  outside tables ordinary paste continues. → crates/futo-notes-editor/src/session/blocks/clipboard/paste.rs, crates/futo-notes-editor/tests/tables.rs
- A giant table is cut into rows at line seams like a long paragraph (long-regions.md): the inline parser has no table extension, so a `|`-led row line reads the same continued or alone. Typing, Backspace and Enter in a middle row cost the same counted work at 2,000 rows as at 100; a 200-row table of URLs (30 KB) types in about 0.14 ms per key on desktop (before: 28 ms), and a 20,000-row table in about 0.12 ms. A literal `*`, `_` or `~` run (as in `twitter.com/_name`) no longer keeps a table whole: rows cut around it, and only an edit that creates, removes or reflanks a delimiter run (one holding `*`, `_`, `~`, `\` or a line break, or beside one) reparses the whole table. Paths that need the table's layout still read the whole table: Enter, Tab or a typed `|`, `\` or line break with the caret in a cell (about 10 ms for an in-cell Enter at 20,000 rows on desktop), paste in a cell, inspection and row/column commands; a caret outside every cell of its line (past a row's closing pipe) answers from that line alone. → crates/futo-notes-editor/src/inline/row/split.rs, crates/futo-notes-editor/tests/table_rows.rs, crates/futo-notes-editor/src/inline/table_split_tests.rs
- Portable, Store and native layers expose the same operations behind the usual acceptance and
  acceptance barrier; each step restores exact bytes. → crates/futo-notes-editor/src/portable/tables.rs, crates/futo-notes-store/src/editor_session/tables.rs, crates/futo-notes-ffi/src/editor/tables.rs

