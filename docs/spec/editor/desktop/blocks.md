### Desktop editor: lists, tasks, quotes and dividers _(desktop)_

What a line is comes from the engine's block description of it (list item, quote depth,
divider, code line); the editor draws it and forwards every key, and holds no list or quote
rule of its own. A list item's marker is text: the engine's one marker unit
(portable-core/lists.md) is a real element in the line holding that unit's character, so the
page's text, its selection and the engine's are one; the element draws the marker, and the
character itself never shows. Fenced code blocks are [code-blocks.md](code-blocks.md).

- A list item's line is indented by its own left padding, 1.4em a level, half that from the
  fifth level and no more after the eighth, so its wrapped rows line up with its text and every
  row stays one line unit. Its marker draws in that indent, right-aligned against the text: a
  dot for a bullet, an ordered item's marker as typed (`3)` draws `3)`, and nothing is
  renumbered for display) and a checkbox for a task. A marker wider than the indent (`10.`,
  `100.`) starts at its level's left edge and moves that item's text right by exactly what it
  lacks (its measured width, markerWidth.ts), wrapped rows included: no marker draws left of
  the text column, and none is set in from it. An item's level is the engine's display level, not its source
  whitespace, so lists nested with tabs, two spaces or four draw alike. An indented plain line
  under a list is its own line (portable-core/linedown.md): no marker, its text at the indent of
  the level it borrows, which lines it up with the text of the item it sits under. →
  src/features/editor/desktop/lineElements.ts `drawLine`, atomElements.ts, desktopEditor.css,
  tests/desktop-editor-block-stories.mjs
- The marker unit's element is drawn out of the text's flow, so the item's text starts where it
  would without it; its box is the marker as drawn (the number, the dot's square, the
  checkbox): the unit's character has no width on any system (the editor's face for it), so it
  adds nothing to the box. The caret stops only before it, drawn at its box's left edge, and after it, at
  the item's text start; Left from the text start stops before the marker, then goes to the
  line above's end, and Right steps back over it. The row's start (Cmd+Left, Home), deleting
  to it (Cmd+Backspace) and Up and Down keep to the item's text: they never stop before the
  marker. → lineElements.ts `pointInLine`, keys.ts `besideAtom`, hitTest.ts `offsetAt`,
  src/styles/desktop-fonts.css `Atom Character`, tests/desktop-editor-marker-stories.mjs
- To the pointer a number or a bullet is one character of its line: a click on its box places
  the caret on the nearer side (its left half before it, its right half at the item's text
  start) and selects nothing, and a click just left of it places the caret before it; a press
  on it and a drag selects from the side pressed; a double click selects the marker alone (its
  own word); a triple click anywhere on the item's line selects the whole line, marker
  included, as on a plain line. A drag across it takes it whole. → hitTest.ts `atomHit`,
  pointer.ts `unitAt`, tests/desktop-editor-marker-stories.mjs
- A selected marker is highlighted from its box's left edge to the item's text start, as its
  unit holds the space after the marker too; a selection running across it is one band with
  no gap. → highlight.ts, tests/desktop-editor-marker-stories.mjs
- The unit acts as its text (portable-core/lists.md): typing over a selected unit replaces the
  marker (`5. ` over `10. ` renumbers the item), Backspace after it and Delete before it take
  it off, typing before it makes the line plain text, and a copy of it is its Markdown. →
  tests/desktop-editor-marker-stories.mjs
- A quote draws a 3px bar in the border colour per quote level, before any list indent, and
  its text in the muted colour. The bar and a divider's rule are a tint of the text colour, not
  an opaque fill, so a selection's highlight shows through them. → desktopEditor.css
- A divider is the engine's atom: its line's text is one character, in an atom element as a
  marker's is, drawn as a 1px rule in the border colour across the row. The caret stops only
  before and after it; a click on its row, any click count, selects it whole, and a drag or
  Shift+arrow across it takes it whole; a selected divider is highlighted across its row.
  Backspace after it and Delete before it delete it at once. →
  src/features/editor/desktop/hitTest.ts `atomHit`, highlight.ts,
  tests/desktop-editor-block-stories.mjs
- A task's marker unit is its checkbox: a `role="checkbox"` element named "Done", checked as
  the engine reads the item, in a 28px slot before the text. Its box and tick are placed by
  the slot, never by the width of the marker's own character, which differs by font and
  system. A click on it toggles the task
  through the engine, one Undo step, and leaves the caret, the selection, the focus and the
  scroll where they are; it never selects it. A double click toggles it once: only a click's
  first press toggles. The pointer over it is the arrow. A press left
  of it places the caret before it, and one between it and the text at the text's start. →
  pointer.ts `down`, atomElements.ts `drawAtoms`, tests/desktop-editor-block-stories.mjs
- Enter, Backspace, Delete, Tab and Shift+Tab in a list or a quote are the engine's
  (portable-core/lists.md, block-commands.md): Enter continues the item or the quote, on an
  empty item lifts it a level or leaves the list, and on an empty quoted line leaves the quote,
  writing no blank line where the list or quote ends; Tab and Shift+Tab indent and outdent an
  item and leave the caret on its text, and on a line that is no list item change nothing and
  insert no tab (portable-core/list-indent.md); Backspace at an item's text start takes its
  marker off and the line stays. Typed line starts (`- `, `1. `, `> `, `- [ ] `) make a list
  or a quote as the engine defines them; typed into an empty item they are its text
  (portable-core/list-shortcuts.md). → src/features/editor/desktop/input.ts, keys.ts,
  tests/desktop-editor-block-stories.mjs
- Mod+Alt+8 makes the caret's or the selection's lines a bullet list, Mod+Alt+7 an ordered
  list and Mod+Shift+B a quote, through the engine's block commands; there is no task-list
  shortcut. → keys.ts `formatShortcut`, formatting.ts `block`
- A copy of list lines carries their Markdown markers, and pasted Markdown lists become lists
  (the engine's clipboard rules). → input.ts `copy`, tests/desktop-editor-block-stories.mjs
- An edit redraws only the lines whose block or text changed: an Enter in the middle of an
  ordered list rewrites the numbers below it, not their text, and typing in a long list or a
  long quote costs what typing in a paragraph does. → lineElements.ts `drawLine`, `redraw`
- Puppet's `doc` names each line's kind as drawn: `quote` per quote level, then `bullet`,
  an ordered item's marker as typed (`3.`, `3)`), `task ☐` or `task ☑` on an item, then
  `heading1`…, `divider`, `code` (`code js` with its block's language, on every line of the
  block), `paragraph` or `gap`, with a line's display level below the first as
  `indent`. Its `text` leaves an item's marker unit out (the kind names it) while its offsets
  count it: an item's `at` is before the marker. `elements` lists each task's checkbox, so a
  real `click` toggles it. → src/app/puppet/puppetTextEditor.ts `docTextOf`

> **Gap:** _(desktop)_ A block cannot be dragged to a new place: the desktop editor has no ⠿
> gutter handle and no block drag. Native mobile blocks move by [block drag](../mobile/block-drag.md). →
> src/features/editor/desktop/ (no block-drag module)
