### Desktop editor: tables _(desktop)_

What a table is, and every edit in one, is the engine's (portable-core/tables.md,
portable-core/linedown.md "Tables"); the page draws the table facts the engine's projection
reports (each table line's role and pipes, each table's columns and alignments) and holds no
table rule of its own. → src/features/editor/desktop/tableLines.ts

- A table draws as a grid. Its lines stay one element each: a header or body row is a row of its
  cells, every row as many columns as the table's widest row, so a shorter row is drawn padded
  with empty cells that hold no text. The pipes stay in the text, in order, but are not drawn.
  → tableRowElements.ts, desktopTables.css, tableRowElements.test.ts
- The delimiter row is not drawn, not even under a selection: it takes no height and no
  press, and the browser's caret never stands in its hidden text. Keeping the caret and a placed
  selection off it is the engine's (portable-core/tables.md). The one time it shows is while
  the caret is writing it (the engine's `writes_delimiter_row`): then it draws as the text it
  is, muted, until the closing pipe, Enter or Tab finishes it and the caret is in the first
  body row's first cell. → desktopTables.css, editorTables.ts `markWrittenRow`, selection.ts,
  highlight.ts `selectedBands`, tests/desktop-editor-table-stories.mjs
- A table is as wide as the text column, and every column of it an equal share of it, whatever
  its cells hold, but never narrower than 5em (the old editor's cell minimum). A cell's text
  wraps inside its column, a word longer than the column (an address) broken inside it; a row
  is as tall as its tallest cell, the others filling that height, their text at the top. The
  width follows the window, with nothing measured from the cells. → desktopTables.css,
  tests/desktop-editor-table-wrap-stories.mjs
- In a left-aligned or unaligned column a cell's wrapped rows start where its first row's
  text does, after its leading padding; a centred or right-aligned cell's rows are centred or
  flush right. → desktopTables.css, tableRowElements.ts `drawRow`, tableRowElements.test.ts,
  tests/desktop-editor-table-wrap-stories.mjs
- Only a table whose columns at that minimum pass the text column (many columns) is wider than
  it, and scrolls sideways inside it, the page staying put: a sideways wheel or trackpad swipe
  (or Shift+wheel) over a row scrolls its table, as far as its columns pass the row, the rows
  clipped at the text column's sides. → tableLayouts.ts, tableScroll.ts `tableScrollRoom`,
  editorTables.test.ts, tests/desktop-editor-table-wrap-stories.mjs
- A moved caret or selection, and a typed character, in a cell the table's scroll hides brings
  it into the row, a line unit in from its sides; so does find's revealed match. Scrolling the
  table leaves the caret where it is, hidden while its cell is out of view. The caret, the
  selection's highlight, find's matches and a selected picture's tint move with the table and
  are clipped where its rows are. → editorTables.ts `revealCaret`, overlays.ts `caretRect`,
  tableScroll.ts, findBands.ts `findBands`, tests/desktop-editor-table-wrap-stories.mjs
- A cell's text keeps its padding spaces; an empty cell is as tall as a line. Its leading
  padding draws a quarter em a space. A delimiter cell `:--` draws its column's cells left,
  `:-:` centred, `--:` right; with no colon, left. The header row draws semibold, between a
  rule above and below it; every row has a rule under it and every column one on its right, in
  the tint a quote's bars take. A picture in a cell is no wider than its cell, at most 300px
  tall, 0.35em inside the row's rules. A table right under a code block stands the code-block gap below its
  card (code-blocks.md), except across a chunk boundary of the page's lines. → desktopTables.css,
  tableRowElements.ts `cellSegments`
- An escaped `\|` draws as a pipe in its cell's text, and a cell's inline formats, links and
  tags draw as anywhere. → tableRowElements.ts `cellLine`
- A row's text stands on line units as a paragraph's does, so the caret, the selection
  highlight and a press measure its wrapped rows as a paragraph's: the caret on each row of a
  cell's text (at a wrap, as a paragraph's), a press on the nearest character of the cell under
  it, below a short cell's text in a tall row at that cell's end. A caret the engine keeps at a
  pipe draws at the end of the cell before it (at the row's leading pipe, the start of the first
  cell). → tableRowElements.ts `pointInTableRow`, tableRowElements.test.ts,
  tests/desktop-editor-table-wrap-stories.mjs
- A caret in a cell that holds no characters (`||`, not even its padding spaces) stands where
  the cell's text starts: inside its padding, in the middle of a centred column and at the end
  of a right-aligned one, on the cell's first row, where a typed character then draws (the engine writes `|x|`, adding
  no padding). A click in such a cell puts the caret there, and Up and Down reach and leave it
  by that x. → tableRowElements.ts `emptyCellStopRect`, caret.ts `caretViewportRect`,
  tableRowElements.test.ts, tests/desktop-editor-table-control-stories.mjs
- Up and Down from a cell move through its own wrapped rows first, then go to the row above or
  below, though a taller cell beside it holds its row open, and land on the own text of that
  row's cell in the caret's column, passing over the delimiter row. Home and End (Cmd+Left and
  Cmd+Right) go to the row's first cell's start and last cell's end, wherever the table is
  scrolled and however its cells wrap. → hitTest.ts `verticalStop`, `rowEdge`, tableRowElements.ts `tableCellTextBox`,
  `tableCellTextBoxAt`, tableScroll.ts `tableRowEdge`, tests/desktop-editor-table-stories.mjs
- A selection inside one cell is highlighted as text, kept to that cell's column. →
  highlight.ts `selectedBands`, tableRowElements.ts `tableRowHighlight`,
  tests/desktop-editor-table-stories.mjs
- A selection that crosses cells, or runs into a table from outside it, highlights every cell
  it touches over the cell's whole box, its row's full height, empty cells and padding
  included. Touching is reading order: on the row the selection starts in, the cells from the
  one holding its start (a cell's edges count as in it) to the end of the row, its fillers
  included; on the row it ends in, the cells up to the one holding its end; rows wholly
  inside, every cell and filler. A drag from the first cell to the last highlights the whole
  table. → highlight.ts `selectedBands`, tableRowElements.ts `tableRowHighlight`,
  highlight.test.ts, tests/desktop-editor-table-stories.mjs
- The cells' highlight follows the table's sideways scroll, clipped to what the row shows;
  the delimiter row draws none. → tableRowElements.ts `tableRowHighlight`, highlight.test.ts
- An edit in one row redraws that row, and every row of its table only when the edit changes
  the table's column count or alignments, which the change's table entry gives the rows it did
  not describe; an edit outside a table redraws none of its rows. → lineModel.ts `fitTables`,
  tableLines.ts `fitTableLines`, applyViewChanges.test.ts
- Tab, Shift+Tab, Enter and Shift+Enter in a cell, Backspace and Delete at a cell's edge, a
  paste or a link in a cell, and typing a `|` or a line break are the engine's table rules,
  reached through the editor's ordinary keys and input: Shift+Enter, as Enter, selects the
  cell below. → keys.ts, input.ts, editorTables.test.ts
- Backspace, Delete, cut or typing over a selection that covers every cell (the first header
  cell to the last cell) removes the table whole, one Undo step, as the engine rules; any other
  selection across cells deletes as plain text. → portable-core/tables.md,
  tests/desktop-editor-table-stories.mjs
- Mod+Enter in a cell puts the caret on an empty line after the table: the line after it when
  that one is empty, else a new one. → leaveTable.ts, leaveTable.test.ts,
  tests/desktop-editor-table-stories.mjs

#### Row and column grips

- With the pointer over a cell of a table in a note that can be edited, a small grip shows left
  of that cell's row, centred on it, and one above its column, centred on it over the table's
  header; the caret may be anywhere and the editor need not have focus. A filler a short row is
  drawn with shows none. → tableHover.ts, editorTables.ts, tableGrips.ts, TableGrips.svelte,
  editorTables.test.ts, tests/desktop-editor-table-control-stories.mjs
- The grips move no text, scroll with the table (the column's grip hides while its column is
  scrolled out of the row), and no caret or selection reaches them. → tableGrips.ts
- The pointer crosses the gap between a row or the header and its grip, and rests on the grip,
  without the grips going: a grip's hit area reaches over the gap, the row's over its whole
  height (a tall row's grip stands at its middle). → desktopTables.css, tableGrips.ts,
  tests/desktop-editor-table-wrap-stories.mjs
- The grips go when the pointer leaves the table and its grips, and until it next moves over a
  cell after an edit (typing included), a press dragging in the text, a composition, a scroll
  of the pane or of the table sideways, or the note becoming read-only. → tableHover.ts,
  editorTables.ts
- None show while the editor holds a selection (not a caret) reaching into the table: the
  selection toolbar may be where the column's grip goes. → editorTables.ts `selectsInTable`
- An open grip menu pins its cell: the pointer crossing the rows the menu drops over moves no
  grip, and the menu's command runs on that cell. → tableHover.ts `pin`, TableGrips.svelte
- Each grip opens the app's dropdown menu: Insert before, Insert after, Delete (in the danger
  colour), the engine's row commands (insert above, below, delete) or column commands (insert
  left, right, delete) on that cell, one Undo step each; what the engine disallows there (the
  header row deleted or a row put above it, the last body row or the only column deleted) is
  shown disabled. Opening one moves no focus and no selection; after a command the editor has
  focus. → TableGrips.svelte, engine.ts `tableCommand`, `inspectTable`, editorTables.test.ts,
  tests/desktop-editor-table-control-stories.mjs
- After a command the caret is where the engine puts it, wherever it was before: at the start
  of the hovered cell when that cell survives; after deleting its row, at the start of the cell
  below (above, for the last row); after deleting its column, in the cell to its right (left,
  for the last column). → portable-core/tables.md, editorTables.test.ts

> **Gap:** the grips have no keyboard path: they are reached and used with the mouse only, on
> hover, as in the old (Milkdown) editor, whose menu Escape closed.
