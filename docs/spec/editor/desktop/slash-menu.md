### Desktop editor: the `/` menu _(desktop)_

Typing `/` at the start of a word lists what to turn the line into or insert there. The items and
their labels are the menu's manifest (`slashItems.ts`); each item runs the
engine's command, and the page holds no block rule of its own.

- A `/` that starts a word opens the menu at the caret: the first character of its line's text
  (after any indent, after a list item's marker, and on a heading or quote line, whose markers
  are hidden) or a `/` after a space mid-line (`text /`). A `/` inside a word (`and/or`,
  `http://`, `1/2`) is a character, and so is a `/` in inline code, on a code, table or front
  matter line, or while an input method composes. Escape closes the menu and leaves the typed
  text. → src/features/editor/desktop/slashRun.ts, slashRun.test.ts
- The text from the `/` to the caret is the query: it narrows the list by the
  ranking (`filterSlashItems`: a label prefix first, then an id prefix, a label match, a keyword
  match), and a query nothing matches, or a typed space, hides the menu. The list offers Text,
  Heading 1-3, Bullet list, Numbered list, Task list, Quote, Code block, Divider, Table, Link
  and Image.
  → slashMenu.ts, slashCommands.ts `DESKTOP_SLASH_ITEMS`, slashMenu.test.ts
- The list sits under the caret, above it when there is no room below, inside the window, dressed
  as a menu. Up and Down move the highlight, wrapping; Enter or Tab pick it before any
  list or table key rule gets the key; a press on a row picks it without taking focus from the
  note. A query that changes puts the highlight back on the first row. Escape closes the menu and
  keeps the typed text, and it stays closed while that same `/` is typed on. → caretList.ts,
  slashMenu.ts `keyDown`, keys.ts `keyDown`, tests/desktop-editor-slash-stories.mjs
- Picking an item removes the typed `/query` and runs the item at the caret that leaves. Text,
  a heading level, a list, Quote, Code block, Divider and Table (a header row and two rows of
  three columns, the caret in the first header cell) are the engine's block commands
  (portable-core/block-commands.md, lists.md, fenced-code.md, tables.md: Quote on a quoted line
  takes a level off), each run with the removal as one engine command and one Undo step, so one
  Undo brings the typed query back; a command that changes nothing there leaves the query
  removed, still one step. Link opens the Link prompt at that caret (links.md) after the query
  is removed, and cancelling it leaves the query removed. → slashCommands.ts `runSlashItem`,
  engine.ts `blockCommandRemoving`
- Image opens the host's image picker (`PlatformFS.pickImages`, one image file, as the
  menu's) and the picked file takes a pasted picture's path (paste.md): it is saved into the vault
  and `![](image-…ext)` is written at the caret, its own Undo step, under a claim taken as the
  picker opens, so a file picked after another note opened lands nowhere and is deleted. A
  cancelled picker, a file that fails to save, or a host with no picker writes nothing, and the
  query stays removed (the menu's behaviour). → slashCommands.ts, imageInput.ts `pick`,
  src/features/editor/imageInsert.ts `pick`, imageInput.test.ts
- An agent reads the offered items and picks one with Puppet's `PickSlashItem {item}`, registered
  while the menu is up. The OS picker cannot be pressed, so Image takes `{"path"}`, the file it
  would return, and is refused without one. → slashMenu.ts
