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
  the last body row and last column cannot be deleted) are reported as plain state. A body row
  shorter than the header lists only the cells it has. → crates/futo-notes-editor/src/session/blocks/tables.rs
- Cell replacement writes `|` as `\|`, turns line breaks into spaces, and keeps inline formats;
  a range that crosses cells or touches a pipe, or a typed backslash that would make the next
  pipe a delimiter, is refused whole. No other cell's bytes change. → crates/futo-notes-editor/src/session/blocks/tables.rs, crates/futo-notes-editor/src/inline/edit.rs
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
  crosses cells is refused. The clipboard entry routes to `paste_into_table_cell` when it returns
  a change and otherwise continues with ordinary paste. → crates/futo-notes-editor/src/session/blocks/tables.rs
- Cell edits reparse only the edited paragraph window, never the note. → crates/futo-notes-editor/tests/tables.rs
- Portable, Store and native layers expose the same operations behind the usual acceptance and
  recovery barrier; each step recovers exact bytes. → crates/futo-notes-editor/src/portable/tables.rs, crates/futo-notes-store/src/editor_session/tables.rs, crates/futo-notes-ffi/src/editor/tables.rs
