### Toolbar commands

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Undo/Redo, Bold, Italic, Strikethrough, Link, Text/H1/H2/H3, Quote,
  Code block, Bullet/Ordered/Task list, Indent/Outdent (shown inside a list or
  quote), Camera, Image — horizontally scrollable, with a collapse chevron
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
  crates/futo-notes-editor/src/session/blocks/code_command.rs `code_toggle_off`,
  crates/futo-notes-editor/tests/fences/commands.rs
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
- Bold, Italic and Strikethrough light only when the selection carries that format — within one block the whole selection, across blocks every selected inline body (edge whitespace and blank lines aside), so a lit button means a tap removes it; a collapsed caret shows its carried formats. Block controls light only for the common selected block kind, with mixed blocks left unlit, except Heading and Quote, which follow the rule below. → crates/futo-notes-editor/src/session/toolbar.rs, crates/futo-notes-editor/src/session/formatting.rs `selected_toggle_formats`
- The H1/H2/H3 and Quote buttons use the same rule as their taps, so an unlit button's tap never takes the format off, and a lit button's tap takes it off, or is refused with the text unchanged when the removal cannot be written exactly (a quote beside a lazy continuation or inside a list item). Heading lights when every selected content line carries that level, at any quote depth or block kind, so a selection of mixed block kinds can light it; Quote lights when every selected prose line is quoted. Blank lines and front matter are set aside by both (a caret or a selection of only blank lines still reads them), and Quote also sets aside code and divider lines, which it never changes. Two shapes stay outside this: a heading tap whose selection ends at the first text of a list item lifts that item out of its list and drops its heading while the button is unlit, and removing an ATX heading directly above a setext underline or a `---` divider merges the two. → crates/futo-notes-editor/src/session/toolbar.rs, crates/futo-notes-editor/src/session/blocks/mod.rs `common_heading`, `all_quoted`, crates/futo-notes-editor/tests/blocks/blank_lines.rs `toolbar_lit_state_matches_what_the_tap_does`
- Inline formats and Link are dimmed when the engine disallows inline formatting; Outdent is dimmed only when no touched line has leading whitespace, Undo and Redo when their history query says they cannot run, and Indent never (lists.md). These controls stay visible. → crates/futo-notes-editor/src/session/toolbar.rs
- Heading controls offer Text, H1, H2 and H3 explicitly. Choosing a level applies
  that same level to every selected prose block; choosing it again does not cycle.
  Text returns headings to paragraphs. Enclosing quotes keep their nesting.
  Verified in the desktop WebView and Android emulator 2026-09-08. →
  packages/editor/src/toolbar.ts, src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts, tests/selection-toolbar.spec.ts
- Quote toggles: on unquoted lines it applies quote formatting, and on lines
  that are all quoted it takes one quote level off. In the desktop editor Indent and Outdent change the nearest list or quote container one level
  at a time (the Rust engine's are tab edits, portable-core/lists.md); outdenting a top-level quote returns its selected content to the
  surrounding document. Verified in the desktop WebView and Android emulator
  2026-09-08. → src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts,
  crates/futo-notes-editor/src/session/blocks/mod.rs `all_quoted`,
  crates/futo-notes-editor/tests/blocks/toggle.rs
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
- Indent/Outdent are no-ops inside a code block too in the desktop editor, including a fence indented
  under a list item — the caret is on a code line, not a list line, so the
  enclosing list is not restructured. →
  src/features/editor/milkdown/toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Bullet and task markers are written as `-` — the toolbar and the editor's
  serializer agree on one marker so an edit never churns a note's list markers.
  The one `*` a save writes is the second of two adjacent lists ("Markdown house
  style"). → packages/editor/src/markdown/,
  tests/editor-embed-milkdown-toolbar.spec.ts
- The Rust engine (iOS/Android) treats Indent and Outdent as tab edits on any line (portable-core/lists.md, decided 2026-11-09): Indent writes a tab at each touched line's start (an empty item after Enter included, nothing held as pending indentation), Outdent takes one level of leading whitespace off. This supersedes the 2026-11-06 empty-item nesting and blank-line repair and the earlier refusal of 2026-11-03 and the held-indent behavior before it (main 8d0d8eb41). The desktop editor's `changeBlockIndent` (ProseMirror `sinkListItem`) is unchanged. → crates/futo-notes-editor/tests/lists/command_eligibility.rs, crates/futo-notes-editor/tests/lists/tab.rs, src/features/editor/milkdown/blockCommands.ts `changeBlockIndent`
