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
  Each greys out and stops accepting taps exactly when its stack is empty (no
  visual-only disable): the editor reports this in `formatState`'s `disabled`
  field, on the same triggers and with the same dedupe as the active-format
  set, and all three toolbar surfaces (iOS, Android, the embed fallback) grey
  the button AND refuse the tap. Verified emulator 2026-09-11 (`enabled=false`
  on the platform semantics node, not just a dimmed icon). →
  packages/editor/src/bridge.ts `FormatStateMessage.disabled`,
  src/features/editor/milkdown/formatState.ts `computeDisabledFormats`,
  EditorToolbar.swift, EditorToolbar.kt, EmbedToolbar.svelte,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Code block converts the current paragraph(s) into a fenced code block —
  the same command the `/` menu's Code block item runs. One-way (there is no
  toolbar command back OUT of a code block; the block-conversion model
  already refuses both a `code` source and a `code` target for every other
  button, docs/spec/editor.md "A block-format command never touches a CODE
  BLOCK" below). Was missing from the manifest entirely — every mobile shell,
  not only Android — until QA-009. Verified emulator 2026-09-11. →
  packages/editor/src/toolbar.ts, src/features/editor/milkdown/toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
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
  notes untouched. A click outside already cancelled it; a KEYBOARD note switch
  moves no focus and fires no pointer event, so without this the next submit
  wrote a link — or rewrote link marks over an unrelated range — in a note the
  user never opened the prompt on. The desktop selection toolbar's own inline
  URL field closes on the same event, for the same reason. →
  src/features/editor/milkdown/linkPrompt/ `dismissLinkPrompt`,
  milkdown/linkPrompt/noteSwitch.test.ts, milkdown/selectionToolbar/
  noteSwitch.test.ts
- Indent nests a list item under its PRECEDING SIBLING item, so it has no
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
- Heading controls offer Text, H1, H2 and H3 explicitly. Choosing a level applies
  that same level to every selected prose block; choosing it again does not cycle.
  Text returns headings to paragraphs. Enclosing quotes keep their nesting.
  Verified in the desktop WebView and Android emulator 2026-09-08. →
  packages/editor/src/toolbar.ts, src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts, tests/selection-toolbar.spec.ts
- Quote applies quote formatting; pressing it inside a quote does not change its
  depth. Indent and Outdent change the nearest list or quote container one level
  at a time; outdenting a top-level quote returns its selected content to the
  surrounding document. Verified in the desktop WebView and Android emulator
  2026-09-08. → src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Bullet, Ordered and Task retain their list toggles and conversions. Converting
  between list kinds preserves nesting; Bullet/Ordered change the enclosing list,
  while Task changes the selected items. Converting a checked task to another
  list kind drops its checkbox state. → src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
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
- Indent/Outdent are no-ops inside a code block too, including a fence indented
  under a list item — the caret is on a code line, not a list line, so the
  enclosing list is not restructured. →
  src/features/editor/milkdown/toolbarExec.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
- Bullet and task markers are written as `-` — the toolbar and the editor's
  serializer agree on one marker so an edit never churns a note's list markers.
  The one `*` a save writes is the second of two adjacent lists ("Markdown house
  style"). → packages/editor/src/markdown/,
  tests/editor-embed-milkdown-toolbar.spec.ts
