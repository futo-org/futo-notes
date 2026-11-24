### Toolbar commands

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Undo/Redo, Bold, Italic, Strikethrough, Link, Text/H1/H2/H3, Quote,
  Code block, Bullet/Ordered/Task list, Indent/Outdent (visible everywhere,
  greyed out where nothing sensible can happen), Camera, Image — horizontally scrollable, with a collapse chevron
  that blurs the editor (dropping both the keyboard and the toolbar). Verified
  emulator + simulator 2026-07-08 for the original controls (Link sat after
  Strikethrough). → packages/editor/src/toolbar.ts
- Undo and Redo are the FIRST two items, ahead of every formatting control,
  and run the editor session's own Undo and Redo — never a hand-rolled stack.
  Each grays out and stops accepting taps exactly when its stack is empty (no
  visual-only disable): the toolbar's state reports it on the same triggers as
  the active-format set, and both native toolbars gray the button AND refuse
  the tap. Verified emulator 2026-09-11 (`enabled=false` on the platform
  semantics node, not just a dimmed icon). → packages/editor/src/toolbar.ts

- Code block converts the current paragraph(s) into a fenced code block —
  the same command the `/` menu's Code block item runs. It toggles: on lines
  already inside a code block it takes the touched lines out of the fence as
  plain text (text that would read as Markdown structure, such as `# x`, `- a`,
  `> q`, `1. x` or `---`, is kept literal), and the rows above and below keep
  their fence. Every other block button still
  leaves a code block alone (docs/spec/editor.md "A block-format command never
  touches a CODE BLOCK" below). Was missing from the manifest entirely — every
  mobile shell, not only Android — until QA-009. Verified emulator 2026-09-11. →
  packages/editor/src/toolbar.ts,
  crates/futo-notes-editor/src/engine/commands/fences/mod.rs `code_off`,
  crates/futo-notes-editor/tests/fixtures/engine/fences.json
- Link opens the platform's own Link prompt (an alert on iOS, a dialog on
  Android) with a destination field and a label field holding the engine's
  starting label (`link_label`: the link's text, else the selected text, empty
  at a caret; on Android only where the engine offers one). In a link the
  destination is filled in, Update rewrites the link, and Remove takes it off
  and keeps its text; elsewhere Add writes a new link. Cancel leaves the note as
  it was. What is written is the engine's (portable-core/links.md). →
  apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Links.swift,
  apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstLinkDialog.kt
- The toolbar SURFACE — items, order, grouping, accessibility labels,
  per-platform icons, visibility rules — is defined once in the
  `@futo-notes/editor` manifest, and the editing BEHAVIOR behind every button is
  the Rust editor session's. Toolbars are dumb dispatchers: no
  platform restates the item list or reimplements a command. →
  packages/editor/src/toolbar.ts, crates/futo-notes-editor

- Every toolbar highlights the commands ACTIVE at the caret: the editor session reports
  the covering manifest ids on every selection move and after a toolbar tap, and
  each toolbar tints those buttons —
  an accent-tinted icon on a rounded accent wash inset inside the button, the
  same treatment on iOS and Android. A task item reports
  Task and never also Bullet, so the two never light up together.
  → packages/editor/src/toolbar.ts, crates/futo-notes-editor

- Bold, Italic and Strikethrough light only when every selected visible character other than whitespace carries that format, across lines and blocks alike, so a lit button means a tap removes it; a collapsed caret shows its carried formats. Code block and the list buttons follow the line the selection starts on; Heading and Quote follow the rule below; Text lights when none of those does, except on a level 4–6 heading, which has no control and lights none. → crates/futo-notes-editor/src/engine/surface.rs `toolbar`, crates/futo-notes-editor/src/engine/commands/inline/mod.rs `toolbar_formats`, crates/futo-notes-editor/src/host/toolbar_ids.rs
- The H1/H2/H3 and Quote buttons use the same rule as their taps, so an unlit button's tap never takes the format off and a lit button's tap takes it off (a `\` keeps text that would read as another block plain, portable-core/block-commands.md). Heading lights when every selected text, heading or list line with text carries that level (a list item counts as Text), at any quote depth; Quote lights when every selected line with text is quoted. Blank lines are set aside by both (a caret or a selection of only blank lines still reads them); both set aside code, front matter and dividers, which they never change, and Heading also sets aside table lines. → crates/futo-notes-editor/src/engine/commands/blocks/mod.rs `toolbar_heading`, `toolbar_quote`, `targets`, crates/futo-notes-editor/src/engine/tests/blocks.rs `a_lit_toolbar_button_takes_its_format_off_and_an_unlit_one_never_does`
- Inline formats and Link are dimmed when no selected line holds inline text (code, front matter, a divider or a table's delimiter row); Indent, Outdent, Undo and Redo are dimmed when their canonical eligibility or history query says they cannot run: Indent and Outdent are visible everywhere on mobile and follow the line the selection starts on. Both are dimmed on a line that is neither a list item nor code (paragraphs, headings, plain quote lines and tables); Indent is lit on every list item, a list's first item included, and in code; Outdent is lit on an item with leading whitespace, and in code when a touched code line has some (list-indent.md, fenced-code.md). These controls stay visible. → crates/futo-notes-editor/src/engine/surface.rs `toolbar`, crates/futo-notes-editor/src/engine/commands/lists/mod.rs `list_indents`, crates/futo-notes-editor/src/engine/commands/fences/keys.rs `code_indent_state`, crates/futo-notes-editor/src/engine/tests/lists.rs `the_toolbar_offers_indent_on_items_and_outdent_on_indented_items`
- Heading controls offer H1, H2 and H3; the manifest's Text item is hidden on
  both native toolbars. Choosing a level applies that same level to every
  selected prose block; choosing the lit level again returns them to paragraphs
  (mobile/toolbar.md). Enclosing quotes keep their nesting. →
  packages/editor/src/toolbar.ts,
  apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Toolbar.swift `hiddenToolbarItems`,
  apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstToolbar.kt
- Quote toggles: on unquoted lines it applies quote formatting, and on lines
  that are all quoted it takes one quote level off; a quote changes level only
  through this button, and Indent and Outdent act on lists and code
  (portable-core/list-indent.md). Taking the last level off a top-level quote
  returns its selected lines to the surrounding document. →
  crates/futo-notes-editor/src/engine/commands/blocks/mod.rs `quote`,
  crates/futo-notes-editor/tests/fixtures/engine/blocks.json
- Bullet, Ordered and Task retain their list toggles and conversions. Converting
  between list kinds preserves nesting; Bullet/Ordered change the enclosing list,
  while Task changes the selected items. Converting a checked task to another
  list kind drops its checkbox state. → crates/futo-notes-editor/src/engine/commands/blocks/mod.rs
- A block-format command never touches a CODE BLOCK. Its content is literal
  text, so a `>` or `#` written there would BE code rather than a prefix:
  Heading, Quote, Bullet, Ordered and Task with the caret anywhere inside a
  fenced or indented code block leave the note's bytes exactly as they are, and
  the toolbar lights nothing up — the editor reads the fence as its own `code`
  kind, which no command has a transition for. A selection that spans a fence
  formats the prose either side of it and steps over the fence rather than
  swallowing it. The desktop block shortcuts (Ctrl/Cmd+Alt+0…8,
  Ctrl/Cmd+Shift+B) run the same commands, so they leave code lines alone too
  (desktop/toolbar.md). → crates/futo-notes-editor/src/engine/commands/blocks/mod.rs,
  tests/desktop-editor-toolbar-stories.mjs
- The same holds inside a TABLE CELL: a GFM cell carries one line of inline
  content, which no block prefix can apply to, so a block command leaves the
  table untouched. → crates/futo-notes-editor/src/engine/commands/blocks/mod.rs
- Inside a code block Indent and Outdent put a tab on, and take one off, the
  code lines (portable-core/fenced-code.md; desktop's Tab and Shift+Tab do the
  same with two spaces), including a fence indented under a list item — the
  caret is on a code line, not a list line, so the enclosing list is not
  restructured. → crates/futo-notes-editor/src/engine/commands/fences/keys.rs
- Bullet and task markers are written as `-`, so an edit never churns a note's list markers. →
  crates/futo-notes-editor/src/engine/commands/blocks/mod.rs

- Indent on an EMPTY list item nests it under its previous sibling like any other item (an empty new item is the common way to start a sub-list: Enter, then Indent), as Apple Notes and Google Docs do. The Rust engine indents a first item too, by one tab. Outdent returns the nested item one level out. The Rust engine writes only a tab and the marker (`- a\n\t- `) and reads that line as an empty nested item, as Obsidian does (portable-core/list-indent.md, 2026-11-09); nothing is held as pending indentation, so later typing, composition or an OS replace never retroactively indents the item. This supersedes the earlier refusal (2026-11-03) and the held-indent behavior before it (main 8d0d8eb41). → crates/futo-notes-editor/src/engine/commands/lists/indent.rs, crates/futo-notes-editor/tests/fixtures/engine/lists/indent.json
