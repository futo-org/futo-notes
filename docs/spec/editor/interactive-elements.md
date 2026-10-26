## Interactive elements

- Tapping a task checkbox toggles it and autosaves — no cursor placement
  needed. The box is a real `<input type="checkbox">` in a 28px tap target, and
  the tap does not disturb focus, so the keyboard stays up on a phone. →
  src/features/editor/milkdown/taskCheckbox.ts,
  tests/editor-embed-milkdown-interactive.spec.ts
- In a bullet list the checkbox takes the hidden bullet's marker column, so a
  task item's text starts where a bullet item's text does (within the few
  pixels the 28px tap target is wider than a 1.4em marker column), and the
  checkbox stays inside the list's own box, clear of the editor gutter and the
  20pt iOS back-swipe strip. An ordered task item
  keeps its number and carries the checkbox after it. →
  src/features/editor/milkdown/milkdownEditor.css `li[data-checked]`,
  tests/editor-embed-milkdown-parity.spec.ts
- Table cells are individually editable in place; Tab/Shift+Tab move between
  cells (Tab in the last cell appends a row); Enter moves the caret down to
  the same column of the row below, selecting that cell's whole content
  (matching Tab's own "typing replaces" convention) — only on the LAST row,
  where there is no row below, does Enter append a new one and move into it.
  Mod+Enter exits the table into a new paragraph after it (the gfm preset's
  own `exitTable` binding). → src/features/editor/milkdown/keyboardParityTable.ts
  `insertTableRowBelow` / `appendTableRowFromLastCell`,
  tests/editor-embed-milkdown-interactive.spec.ts
- Shift+Enter with the caret in a table cell inserts a line break in that
  cell, rather than a no-op — the preset's own hardbreak handling silently
  rejects any break inside a table, which used to fuse whatever was typed next
  straight onto the preceding text with no separator at all (`r1a`,
  Shift+Enter, `second` saved as `r1asecond`). The break saves as a literal
  `<br>` inside the cell (GFM's own way to write a multi-line cell — a real
  newline would corrupt the row) and parses back into the same break on
  reopen. → src/features/editor/milkdown/keyboardParityTable.ts
  `insertLineBreakInTableCell`,
  src/features/editor/milkdown/table/tableLineBreak.ts (reading the `<br>` back),
  src/features/editor/milkdown/table/tableLineBreak.test.ts
- A table pasted with the caret in a table cell overwrites the cells from
  there, spreadsheet-style, one pasted row per row; the empty row the editor
  shows under a header-only table is not pasted, so it never blanks out the row
  under the one the header lands on. → src/features/editor/milkdown/table/tablePaste.ts,
  tests/editor-embed-milkdown-interactive-tables.spec.ts
- Plain text pasted into a table cell stays in that cell: its line breaks
  become spaces, so no word spills into the next cell, and a space or tab at
  either end of the paste is kept (`r1a` + a pasted ` world` saves `r1a world`).
  A cell holds no blocks, so a paste that reads as one (` # h`, ` - a`, ` > q`)
  goes in as the characters copied: `r1a` + ` # h` saves `r1a # h`.
  → src/features/editor/milkdown/plainTextPaste.ts `flattenedForCell`,
  tests/editor-embed-milkdown-interactive-tables.spec.ts

- Hovering a column shows a small grip above it; hovering a row shows one at
  its left edge. Clicking a grip selects that row/column (visibly, as a cell
  selection) and opens a 3-item menu: Insert before, Insert after, Delete.
  Deleting the header row, or deleting a table's last remaining row or
  column, is DISABLED in the menu (with a reason) rather than a silent no-op
  or a whole-table delete — the table can never become malformed and never
  disappears out from under the user. Every insert/delete keeps column
  alignment correct for the columns that survive. Tapping a grip on touch
  does the same as clicking it. → src/features/editor/milkdown/table/tableGrips.ts,
  src/features/editor/milkdown/table/tableCommands.ts,
  tests/editor-embed-milkdown-table-grips.spec.ts,
  src/features/editor/milkdown/table/tableCommands.roundtrip.test.ts

- Pressing Enter in a list item continues the list (inherits nesting, auto
  numbers ordered items, renumbers on edit); Tab/Shift+Tab nest and un-nest an
  item; Backspace at the start of the first item lifts it out of its list. →
  `@milkdown/preset-commonmark` list-item keymap,
  tests/editor-embed-milkdown-interactive.spec.ts
- Splitting a task item always starts the new item UNCHECKED: pressing Enter at the end of
  `- [x] done` gives `- [ ]`, never a second `- [x]`. The item you are leaving keeps its own
  state. → src/features/editor/milkdown/keyboardParity.ts `splitCheckedTaskItem`,
  tests/editor-embed-milkdown-interactive.spec.ts
- Enter in the middle of a checked task item's text leaves the first half checked and starts
  the rest as a new, unchecked item.
- Enter at the very start of a task item's text moves the text down with the caret: the new,
  unchecked item is the empty one left above it, and the item keeps its text and its state.
- Enter over a selection inside a task item's text removes the selection first and then acts
  where it started: a selection from the very start of the text, even one covering all of it,
  splits like the caret at the start (the done task keeps its check).
- Undoing an edit that renumbered a list reverses the edit and the renumbering
  together, as one step: the renumber rides in as an `appendTransaction` that is
  not itself recorded in history. → `@milkdown/preset-commonmark`
  `syncListOrderPlugin`
- Renumbering follows an edit, so the FILE's numbering is left exactly as
  written until you type in it — a hand-numbered `1. / 1. / 1.` list stays that
  way on disk. → milkdown/hostHandleContent.ts `getContent`

- Text that reaches the open note from outside it — a sync pull landing while
  you read, a host push of the note on screen — replaces the document and is not
  reported back to the host as a change of yours, so a peer's version is not
  echoed straight back over theirs. → milkdown/hostHandleNote.ts `setContent` /
  milkdown/documentLoad.ts `applyExternal`,
  editor-embed/createFutoEditorApi.ts `applyExternalContent`

- Undo only ever reverses edits made in the note on screen — never text from
  another note — and opening a note is not itself something undo can reverse:
  the host clears the stack on every open, and a progressively streamed note's
  chunk appends are not undoable. → milkdown/hostHandleView.ts `resetHistory`,
  src/features/editor/milkdown/progressiveLoad.ts,
  tests/editor-embed-milkdown.spec.ts "Undo history"
- Opening a note starts its undo empty. Leaving a note and coming back does not
  restore what you could undo before.
- Redo with nothing left to redo changes nothing; Redo never undoes, whatever the Caps Lock
  state. → milkdown/keyboardParity.ts `handleCapsLockedChord`,
  tests/editor-embed-milkdown-undo.spec.ts
- A shortcut held with Shift never runs the same shortcut without Shift, whatever the Caps
  Lock state: Ctrl/Cmd+Shift+B where a quote cannot go (a table cell) never turns on bold, and
  Ctrl/Cmd+Shift+I or Ctrl/Cmd+Alt+Shift+X, which are not shortcuts, never turn on italic or
  strikethrough. → milkdown/keyboardParity.ts `handleCapsLockedChord`,
  tests/editor-embed-milkdown-interactive.spec.ts
- A Shift shortcut the editor does not use is left to the browser or the OS, whatever the
  Caps Lock state: Ctrl/Cmd+Shift+V still pastes as plain text with Caps Lock on. →
  tests/editor-embed-milkdown-undo.spec.ts, tests/editor-embed-milkdown-interactive.spec.ts

- A change that arrives from OUTSIDE the editor — a note open, a sync adopt, a
  host content push — is applied outside the undo history, so no Ctrl-Z can
  revive the version it superseded and hand that to autosave. The user's own
  earlier edits stay on the stack, rebased over the adopted document. →
  milkdown/documentLoad.ts `loadParsedDocument`,
  editor-embed/createFutoEditorApi.ts `applyExternalContent`,
  tests/editor-embed-milkdown.spec.ts

- Formatting is reachable by typing Markdown: `# `…`###### `, `- `/`+ `/`* `,
  `1. `, `> `, ` ```lang `, `---`, `**bold**`, `*em*`/`_em_`, `` `code` ``,
  `~~strike~~`, `![alt](file)`, and `[[target]]` all convert as you type. So are
  the keyboard shortcuts in [tabs.md](../tabs.md) "Keyboard shortcuts". →
  `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`,
  packages/editor/src/milkdown-compat/inputRules.ts,
  src/features/editor/milkdown/wikilink/inputRule.ts

- ` ```lang ` takes any language word a fence can open with — anything but a
  space or a backtick, so ` ```c++ `, ` ```C# ` and ` ```JavaScript ` open a fence
  in that language. → packages/editor/src/milkdown-compat/inputRules.ts,
  tests/editor-embed-milkdown-interactive-code-blocks.spec.ts

- Seven or more `#` and a space are not a heading: the line stays text, as a
  file reads it. → packages/editor/src/milkdown-compat/inputRules.ts,
  tests/editor-embed-milkdown-interactive-typed-escapes.spec.ts

- A typed `*`, `_` or `~` run converts only where its opener can open by
  CommonMark's flanking rule, as a file reads it: text padded with whitespace
  inside its delimiters (`2 * 3 * 4`, `** not bold **`, `~~ a ~~`) stays text,
  and so does an opener after a letter and before punctuation (`a*"b"*`) or an
  `_` between letters of any script (`café_b_`). A closer converts only the
  opener it matches, as a file reads it: `a **x__ b` and ``` ``x` y ``` stay
  text; when an earlier opener on the line cannot open, a later one still
  does (`café_a_ _b_` makes `b` italic). A delimiter typed inside a URL
  (`https://x.test/*a*`) is a character of the URL, as a file reads it, and
  converts nothing. →
  packages/editor/src/milkdown-compat/inputRules.ts `flanking`,
  tests/editor-embed-milkdown-interactive-typed-escapes.spec.ts

- A delimiter escaped with a backslash, opening or closing (`\*not italic*`,
  `*foo\*`, `` \`a` ``), converts nothing; the line is saved so it reopens
  as the same line, backslash included. Inside a code span a backslash is
  text, so `` `a\` `` still becomes code. →
  packages/editor/src/milkdown-compat/inputRules.ts,
  tests/editor-embed-milkdown-interactive-typed-escapes.spec.ts

- _(desktop)_ Selecting text raises a floating toolbar just above the
  selection — Text/H1/H2/H3, Quote, Bold, Italic, Strikethrough, Code, Link,
  plus Indent/Outdent inside lists and quotes — placed by the same
  floating-ui positioning the `/` menu and the ⠿ handle use. It shows for a
  non-empty TEXT selection that holds something to format, and not for a caret,
  a node selection (an image, a wikilink chip, a block picked up by the ⠿
  handle), a whitespace-only selection, or any selection inside a fenced code
  block, where nothing is markup. A button keeps the selection and the bar, so a
  format can be toggled straight back off; the buttons light up for the formats
  active on the selection. The bar hides when the note loses focus (a click into
  the sidebar or the title) and during an IME composition. The formatting
  buttons run the same shared commands the native toolbars dispatch. Indent/
  Outdent are no exception: a bare caret (no selection) raises no bar even
  inside a list item or blockquote — a caret-only popup showing just those two
  buttons was tried and pulled (user, 2026-09-15: it was intrusive, popping up
  next to the caret while typing — a deliberate product decision, not a gap to
  reopen). `Mod+]`/`Mod+[` indent/outdent the enclosing list or quote by
  keyboard from a bare caret instead, independent of the Tab decision above
  (Tab is still not an indent key outside a code block). →
  src/features/editor/milkdown/selectionToolbar/, milkdown/toolbarExec.ts,
  milkdown/keyboardParity.ts `handleIndentShortcut`,
  tests/selection-toolbar.spec.ts
- _(desktop)_ Link opens a URL field inside the bar. Enter (or Add) applies the
  link over the selection and returns focus to the note; Escape leaves the note
  as it was. On a selection inside an existing link the field is prefilled with
  its address, Enter updates the WHOLE link (never splitting it at the selection
  edges), and emptying the field unlinks it — the selection and the bar stay
  put, so an unlink can follow a URL change. → selectionToolbar/index.ts
  `applyLink`, selectionToolbar/target.ts `linkRunAt`
- _(desktop)_ Editing the note while the URL field is open (the user clicked
  back into the text) closes the field without applying anything: it belonged
  to a selection that may no longer exist. → selectionToolbar/index.ts
  `refresh`, tests/selection-toolbar.spec.ts
- _(desktop)_ Typing `/` as the first character of a line opens a filterable
  menu: Text, Heading 1-3, Bullet list, Numbered list, Task list, Quote, Code
  block, Divider, Table, Link, Image. Typing narrows it (label prefix beats a
  keyword match); an unmatched query hides the menu rather than showing it
  empty; arrow keys move the highlight and Enter/Tab or a click picks the
  highlighted row; Escape closes it and leaves the typed text alone for as
  long as that same `/` run is being typed. A line is a block's first line or
  any line after a newline in a paragraph, and the picked item lands on that
  line alone (see "Paragraphs and lines"). A `/` that is not the first
  character on the line, or one inside a fenced code block, is just a
  character. → milkdown/slash/
- _(desktop)_ Picking any `/` menu item deletes the typed `/query` and applies
  the item as ONE step: no picked item — a plain format (Heading, Quote, a
  list) or one that restructures the block (Code block, Divider, Table) alike
  — ever leaves the typed characters inside or beside the block it built, and
  one Undo takes the whole pick back. → milkdown/commandRunner.ts
  `combineDeleteAndCommand`, milkdown/slash/index.ts `commit`
- Inserting a divider — the `/` menu's Divider item, or typing
  `---`/`___ `/`*** ` on its own line — always ends the SAME way: the rule,
  followed immediately by one empty paragraph, with the caret in it, ready to
  keep typing. No leading or trailing blank line beyond that one paragraph,
  and no NodeSelection left sitting on the rule itself — a NodeSelection on a
  block atom is what a browser's native "scroll selection into view" reacts
  to, and it used to visibly nudge the viewport for `---` typed mid-note. Both
  entry points are normalized by the same plugin, not two code paths. →
  milkdown/dividerCaret.ts
- _(desktop)_ The `/` menu's Link item opens the SAME URL prompt the
  selection toolbar's Link button does (`linkPrompt/`). It always fires on a
  plain caret (the typed `/link` run is gone before the prompt opens), so
  submitting a URL inserts it as a new run of text using the URL itself as the
  label, and leaves that text SELECTED so a real label can be typed straight
  over it. An empty URL, Escape, or a click outside the prompt cancels it and
  leaves the document exactly as the `/link` deletion left it. →
  milkdown/linkPrompt/, milkdown/slash/exec.ts
