### Toolbar commands

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Undo/Redo, Bold, Italic, Strikethrough, Link, Text/H1/H2/H3, Quote,
  Code block, Bullet/Ordered/Task list, Indent/Outdent (visible everywhere,
  greyed out where nothing sensible can happen), Camera, Image — horizontally scrollable, with a collapse chevron
  that blurs the editor (dropping both the keyboard and the toolbar). Verified
  emulator + simulator 2026-07-08 for the original controls (Link sat after
  Strikethrough; no dialog appears — `window.prompt` is a no-op in the native
  WebViews). → EmbedToolbar.svelte, packages/editor/src/toolbar.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Undo and Redo are the FIRST two items, ahead of every formatting control,
  and run prosemirror-history's own commands — never a hand-rolled stack.
  Each grays out and stops accepting taps exactly when its stack is empty (no
  visual-only disable): the editor reports this in `formatState`'s `disabled`
  field, on the same triggers and with the same dedupe as the active-format
  set, and all three toolbar surfaces (iOS, Android, the embed fallback) gray
  the button AND refuse the tap. Verified emulator 2026-09-11 (`enabled=false`
  on the platform semantics node, not just a dimmed icon). →
  packages/editor/src/bridge.ts `FormatStateMessage.disabled`,
  src/features/editor/milkdown/formatState.ts `computeDisabledFormats`,
  EditorToolbar.swift, EditorToolbar.kt, EmbedToolbar.svelte,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Code block converts the current paragraph(s) into a fenced code block —
  the same command the `/` menu's Code block item runs. It toggles: on lines
  already inside a code block it takes the touched lines out of the fence as
  plain text (text that would read as Markdown structure, such as `# x`, `- a`,
  `> q`, `1. x` or `---`, is kept literal), and the rows above and below keep
  their fence. Every other block button still
  leaves a code block alone (docs/spec/editor.md "A block-format command never
  touches a CODE BLOCK" below). Was missing from the manifest entirely — every
  mobile shell, not only Android — until QA-009. Verified emulator 2026-09-11. →
  packages/editor/src/toolbar.ts, src/features/editor/milkdown/toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts,
  crates/futo-notes-editor/src/engine/commands/fences/mod.rs `code_off`,
  crates/futo-notes-editor/tests/fixtures/engine/fences.json
- Link opens the SAME shared URL prompt the desktop selection toolbar and the
  `/` menu's Link item do (`linkPrompt/`), floated over the caret/selection
  inside the WebView — never a native SwiftUI/Compose dialog. The prompt stays
  fully inside the viewport (slid in from a screen edge, narrowed on a screen
  thinner than it), so its Add/Update button is never cut off. With a
  selection (or a bare caret already sitting inside an existing link — reachable
  on mobile via a selection-handle drag that resolves back to a collapsed
  caret) the field is prefilled with that link's href and updates it in place;
  emptying the field unlinks it. With a plain caret and no adjacent link,
  submitting inserts the URL as its own label and leaves it SELECTED, ready to
  be typed over — the WYSIWYG equivalent of CodeMirror's `[]()` scaffold. An
  empty URL on a plain caret, Escape, or a tap outside the prompt cancels and
  leaves the note untouched. Verified emulator 2026-09-11. →
  src/features/editor/milkdown/linkPrompt/, toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- **An open Link URL prompt belongs to the note it opened on.** It holds that
  note's document positions, and the editor is reused across notes, so opening
  a different note (or tearing the editor down) cancels it and leaves both
  notes untouched. A click outside already canceled it; a KEYBOARD note switch
  moves no focus and fires no pointer event, so without this the next submit
  wrote a link — or rewrote link marks over an unrelated range — in a note the
  user never opened the prompt on. The desktop selection toolbar's own inline
  URL field closes on the same event, for the same reason. →
  src/features/editor/milkdown/linkPrompt/ `dismissLinkPrompt`,
  milkdown/linkPrompt/noteSwitch.test.ts, milkdown/selectionToolbar/
  noteSwitch.test.ts
- Indent (desktop editor) nests a list item under its PRECEDING SIBLING item, so it has no
  effect on the first item of a list — there is nothing to nest under, and the
  note's bytes are left untouched. →
  src/features/editor/milkdown/toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- The toolbar SURFACE — items, order, grouping, accessibility labels,
  per-platform icons, visibility rules — is defined once in the
  `@futo-notes/editor` manifest, and the editing BEHAVIOR behind every button is
  defined once in `milkdown/toolbarExec.ts`. Toolbars are dumb dispatchers: no
  platform restates the item list or reimplements a command. →
  packages/editor/src/toolbar.ts, src/features/editor/milkdown/toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Every toolbar highlights the commands ACTIVE at the caret: the editor posts
  the covering manifest ids as `formatState` on every selection move and
  immediately after a toolbar tap (plus on the debounced content change), and
  each toolbar tints those buttons —
  an accent-tinted icon on a rounded accent wash inset inside the button, the
  same treatment on iOS, Android and the embed fallback. A task item reports
  Task and never also Bullet, so the two never light up together.
  → packages/editor/src/bridge.ts `FormatStateMessage`,
  src/features/editor/milkdown/formatState.ts, EditorToolbar.swift,
  EditorToolbar.kt, EmbedToolbar.svelte,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Bold, Italic and Strikethrough light only when every selected visible character other than whitespace carries that format, across lines and blocks alike, so a lit button means a tap removes it; a collapsed caret shows its carried formats. Code block and the list buttons follow the line the selection starts on; Heading and Quote follow the rule below; Text lights when none of those does, except on a level 4–6 heading, which has no control and lights none. → crates/futo-notes-editor/src/engine/surface.rs `toolbar`, crates/futo-notes-editor/src/engine/commands/inline/mod.rs `toolbar_formats`, crates/futo-notes-editor/src/host/toolbar_ids.rs
- The H1/H2/H3 and Quote buttons use the same rule as their taps, so an unlit button's tap never takes the format off and a lit button's tap takes it off (a `\` keeps text that would read as another block plain, portable-core/block-commands.md). Heading lights when every selected text, heading or list line with text carries that level (a list item counts as Text), at any quote depth; Quote lights when every selected line with text is quoted. Blank lines are set aside by both (a caret or a selection of only blank lines still reads them); both set aside code, front matter and dividers, which they never change, and Heading also sets aside table lines. → crates/futo-notes-editor/src/engine/commands/blocks/mod.rs `toolbar_heading`, `toolbar_quote`, `targets`, crates/futo-notes-editor/src/engine/tests/blocks.rs `a_lit_toolbar_button_takes_its_format_off_and_an_unlit_one_never_does`
- Inline formats and Link are dimmed when no selected line holds inline text (code, front matter, a divider or a table's delimiter row); Indent, Outdent, Undo and Redo are dimmed when their canonical eligibility or history query says they cannot run: Indent and Outdent are visible everywhere on mobile and follow the line the selection starts on. Both are dimmed on a line that is neither a list item nor code (paragraphs, headings, plain quote lines and tables); Indent is lit on every list item, a list's first item included, and in code; Outdent is lit on an item with leading whitespace, and in code when a touched code line has some (list-indent.md, fenced-code.md). These controls stay visible. → crates/futo-notes-editor/src/engine/surface.rs `toolbar`, crates/futo-notes-editor/src/engine/commands/lists/mod.rs `list_indents`, crates/futo-notes-editor/src/engine/commands/fences/keys.rs `code_indent_state`, crates/futo-notes-editor/src/engine/tests/lists.rs `the_toolbar_offers_indent_on_items_and_outdent_on_indented_items`
- Heading controls offer Text, H1, H2 and H3 explicitly. Choosing a level applies
  that same level to every selected prose block; choosing it again does not cycle.
  Text returns headings to paragraphs. Enclosing quotes keep their nesting.
  Verified in the desktop WebView and Android emulator 2026-09-08. →
  packages/editor/src/toolbar.ts, src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts, tests/selection-toolbar.spec.ts
- Quote toggles: on unquoted lines it applies quote formatting, and on lines
  that are all quoted it takes one quote level off. In the desktop editor Indent and Outdent change the nearest list or quote container one level
  at a time (on iOS and Android a quote changes level only through this button, and Indent and Outdent act on lists and code, portable-core/list-indent.md); outdenting a top-level quote returns its selected content to the
  surrounding document. Verified in the desktop WebView and Android emulator
  2026-09-08. → src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts,
  crates/futo-notes-editor/src/engine/commands/blocks/mod.rs `quote`,
  crates/futo-notes-editor/tests/fixtures/engine/blocks.json
- Bullet, Ordered and Task retain their list toggles and conversions. Converting
  between list kinds preserves nesting; Bullet/Ordered change the enclosing list,
  while Task changes the selected items. Converting a checked task to another
  list kind drops its checkbox state. → src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- A block format never lands on the empty line parked after a note's final list
  or quote, which a save does not write: a selection that reaches it (Select
  all) formats only the written lines before it, so Select all → Bullet →
  Select all → Bullet returns the note's original bytes, never a stray `-`,
  `1.`, `#` or empty fence. This holds for every list, heading, Text, Quote and
  Code block command, and for the desktop block shortcuts. With the caret on
  that line alone, the command formats it. →
  src/features/editor/milkdown/blockCommands.ts `selectionWithinWrittenContent`,
  src/features/editor/milkdown/keyboardParity.ts,
  tests/editor-embed-milkdown-toolbar-block-formats.spec.ts,
  tests/editor-embed-milkdown-interactive-code-blocks.spec.ts
- A block-format command never touches a CODE BLOCK. Its content is literal
  text, so a `>` or `#` written there would BE code rather than a prefix:
  Heading, Quote, Bullet, Ordered and Task with the caret anywhere inside a
  fenced or indented code block leave the note's bytes exactly as they are, and
  the toolbar lights nothing up — the editor reads the fence as its own `code`
  kind, which no command has a transition for. A selection that spans a fence
  formats the prose either side of it and steps over the fence rather than
  swallowing it. The desktop block shortcuts (Ctrl/Cmd+Alt+0…8,
  Ctrl/Cmd+Shift+B, Ctrl/Cmd+Alt+C) do nothing at all while the selection
  touches a code block. → src/features/editor/milkdown/blockCommands.ts,
  src/features/editor/milkdown/keyboardParity.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts,
  tests/editor-embed-milkdown-interactive.spec.ts
- The same holds inside a TABLE CELL: a GFM cell carries one line of inline
  content, which no block prefix can apply to, so a block command leaves the
  table untouched. → src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Indent/Outdent are no-ops inside a code block too in the desktop editor (on iOS and Android they put a tab on, and take one off, the code lines, portable-core/fenced-code.md), including a fence indented
  under a list item — the caret is on a code line, not a list line, so the
  enclosing list is not restructured. →
  src/features/editor/milkdown/toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Bullet and task markers are written as `-` — the toolbar and the editor's
  serializer agree on one marker so an edit never churns a note's list markers.
  The one `*` a save writes is the second of two adjacent lists ("Markdown house
  style"). → packages/editor/src/markdown/,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Indent on an EMPTY list item nests it under its previous sibling like any other item (an empty new item is the common way to start a sub-list: Enter, then Indent), as Apple Notes and Google Docs do. In the desktop editor only the first item of a list, with no sibling to nest under, is refused; the Rust engine (iOS/Android) indents a first item too, by one tab. Outdent returns the nested item one level out. The Rust engine writes only a tab and the marker (`- a\n\t- `) and reads that line as an empty nested item, as Obsidian does (portable-core/list-indent.md, 2026-11-09); nothing is held as pending indentation, so later typing, composition or an OS replace never retroactively indents the item. This supersedes the earlier refusal (2026-11-03) and the held-indent behavior before it (main 8d0d8eb41). → crates/futo-notes-editor/src/engine/commands/lists/indent.rs, crates/futo-notes-editor/tests/fixtures/engine/lists/indent.json, src/features/editor/milkdown/blockCommands.ts `changeBlockIndent` (ProseMirror `sinkListItem`; desktop's shipping editor has no emptiness check)
