# Editor — Spec

The editor is a shared WYSIWYG WebView — Milkdown on ProseMirror, the **same
`editor.html` / `packages/editor` bytes on all platforms**. A note is parsed
into a document when it opens and serialized back to Markdown when it saves; its
source markers are never on screen. This file states the behaviors a human cares
about.

## Native host boot _(iOS/Android)_

- The native shells load the bundle ONCE, pre-warmed at app start, and it shows
  nothing until it is configured: the page posts `ready`, and the shell's only
  correct reply is a single `FutoEditor.initialize(configJson)` carrying its
  whole intent — bridge version, theme, effective language, the open note's
  markdown, the note universe, the local-image base URL, whether the shell
  renders its own toolbar, and the note body's inline inset. The bundle applies
  them in ONE order it owns (layout, toolbar and theme before any text; image
  base and note universe
  before the content so images size and wikilinks resolve on the first render;
  the note text last), then posts `initialized`. _(iOS/Android)_ →
  packages/editor/src/hostBoot.ts, bridge.ts v7, EditorWebView.swift
  `sendHostConfig`, EditorWebView.kt `sendHostConfig`,
  tests/editor-embed-milkdown.spec.ts
- A shell treats `initialized` — not `ready` — as "this page is showing my
  note": it is where the shell fires its per-note ready callback and its
  auto-focus keyboard shim, and where it re-pushes anything the user or a sync
  changed while the config was in flight. _(iOS/Android)_ → EditorWebView.swift,
  EditorWebView.kt
- The note body's left inset is a per-shell VALUE the shell declares
  (iOS 14px, Android 16px — each aligning with its own native title field), not
  per-shell knowledge: only the bundle knows which CSS variable carries it.
  _(iOS/Android)_ → hostBoot.ts `contentPaddingInlinePx`,
  editor-embed/createFutoEditorApi.ts `--futo-cm-pad-inline`

- When the shell and the bundle were built against different bridge versions,
  the editor **still boots** and the bundle posts `bridgeVersionMismatch`; each
  shell logs it (Android also toasts in a debug build). A shipped app carries
  both halves in one artifact, so a mismatch only ever means a stale developer
  build — and refusing to boot would turn that into a permanently blank editor,
  the app's core surface. _(iOS/Android)_ → bridge.ts
  `BridgeVersionMismatchMessage`, hostBoot.ts, tests/editor-embed-milkdown.spec.ts
- When a WebView renderer dies (OOM / jetsam), the shell reloads the bundle and
  answers the fresh `ready` with the same config, restoring the open note with
  no more than a brief flash. The shell resets only its readiness flag: the
  config is applied unconditionally, so nothing else needs unwinding.
  _(iOS/Android)_ → EditorWebView.swift
  `webViewWebContentProcessDidTerminate`, EditorWebView.kt `rebuildWebView`

## Theming

- The editor follows the app theme. Desktop applies `data-theme` directly; the
  native shells push it over the bridge (`FutoEditor.setTheme`) whenever the
  host theme changes.
- On the native shells the embed page paints **no background of its own**:
  `html`/`body` are transparent (editor.html, overriding app.css's
  `--color-bg`), and both hosts render the web view transparent (iOS
  `isOpaque = false` + `.clear`, Android `setBackgroundColor(TRANSPARENT)`),
  so the native app background (iOS `Theme.background`, Android Compose
  surface) shows through and the editor pane matches the surrounding UI in
  both light and dark. → editor.html, EditorWebView.swift, EditorWebView.kt,
  tests/editor-embed-webview-floor.spec.ts
- Editor text stays legible on legacy Android system WebViews (Chromium < 99,
  no `@layer` support — they drop every Tailwind-layered rule, including the
  light theme tokens and the `body` text color): editor.html carries
  an unlayered inherited text-color fallback on `html`, resolving the dark
  token via the unlayered `[data-theme='dark']` variables and falling back to
  the literal light token. _(Android)_ → editor.html,
  tests/editor-embed-webview-floor.spec.ts (legacy WebView tests)
- The editor needs a System WebView engine of **Chromium 80 or newer**: the
  bundle targets ES2020, an `editor.html` `String.prototype.replaceAll` shim
  covers Chromium 80–84 (Svelte 5's runtime would otherwise throw), an
  `editor.html` `Array.prototype.at` shim covers Chromium 80–91
  (`@milkdown/transformer` calls it on every parse and every serialize), and the
  editor uses `textContent = ''` rather than `Element.replaceChildren`
  (Chromium 86) in its own DOM code so the `[[` autocomplete popup works down to
  the floor too. _(Android)_ → editor.html, wikilink/autocomplete.ts,
  vite.editor.config.ts
- The floor is a property of the **built bundle**, not of the syntax target: a
  dependency reaching for a newer built-in method parses fine and throws at
  runtime, which is how `Element.replaceChildren` (Chromium 86) once shipped
  inside a bundle declaring Chromium 80. Every post-floor built-in the bundle
  uses is either shimmed in `editor.html` — proved by deleting it and running the
  editor without it — or fails the bundle audit. _(Android)_ → editor.html,
  tests/editor-embed-webview-floor.spec.ts
- Whether an engine is supported is decided by **capability, never by a version
  number**: the page reports what it couldn't parse and whether the editor
  mounted, and the shell reads that. A WebView `versionName` is never consulted —
  a vendor provider numbers itself (Huawei WebView 12.x/15.x on a modern
  Chromium), so a version floor rejects working engines. _(Android)_ →
  editor.html, EditorEngineSupport.kt, EditorWebView.kt,
  tests/editor-embed-webview-floor.spec.ts (engine preflight tests)
- "The editor mounted" means the EDITOR ENGINE came up, reported by the bundle on
  `window.__futoEditorMounted` — not that the host API exists and not that the
  bridge `initialize` round-trip returned. Milkdown creates its editor
  asynchronously, so both of those are true while the engine is failing behind
  them: on a Chromium 83 WebView that showed a blank editor pane and no notice.
  _(Android)_ → src/editor-embed/main.ts, EditorEngineSupport.kt `ENGINE_PROBE_JS`,
  EditorWebView.kt, tests/editor-embed-webview-floor.spec.ts

- A note whose editor can't run shows the native "update Android System WebView"
  notice in place of a blank editor pane — when the engine reported a missing
  capability, never produced a mounted editor, or there is no WebView provider at
  all. The rest of the app (native list/search/settings) still works, and back
  navigation from the notice needs no editor save. _(Android)_ →
  LegacyWebViewNotice.kt, NoteEditorScreen.kt, EditorSession.kt
  `exitWithoutEditor`
- The notice names the engine the user has to act on: the Chromium major from the
  WebView's User-Agent (the one version number that means the same thing across
  providers) plus the provider package and its version. _(Android)_ →
  LegacyWebViewNotice.kt, EditorEngineSupport.kt
- iOS needs no such gate: WKWebView ships with the OS and the deployment floor is
  far above the ES2020 syntax floor, so the preflight's verdict is always empty
  there. _(iOS)_ → apps/ios/project.yml
- Minimum supported OS is **Android 9 (API 28)** — `minSdk 28`. This is an OS
  floor independent of the System WebView (which updates through the store), so a
  supported Android 9/10 device can still fall below the Chromium floor above and
  get the update-WebView notice. _(Android)_ → apps/android/app/build.gradle.kts

## WYSIWYG rendering

- The editor shows RENDERED Markdown, never its source. Markers (`*`, `#`,
  ` ``` `, `[[`, `]]`, …) are parsed into document structure on open and written
  back on save, so no caret movement reveals them: there is nothing to reveal.
  → src/features/editor/milkdown/MilkdownEditor.svelte,
  packages/editor/src/milkdown-compat/
- Opening a note and leaving it again leaves the file byte-identical. While the
  document is still exactly what loaded, the editor hands the host back the
  bytes it was given rather than its own serialization; the FIRST real edit is
  what re-spells the note, and it re-spells the whole note (ADR-0002,
  normalize-once). → milkdown/hostHandle.ts `getContent`,
  docs/adr/0002-roundtrip-normalization-accepted.md,
  tests/editor-embed-milkdown.spec.ts
- A block with no text of its own — a thematic break, a wikilink chip, the front
  matter panel — is reached by SELECTING it, which is how it can be deleted or
  replaced at all in an editor that shows no source. →
  src/features/editor/milkdown/wikilink/node.ts,
  packages/editor/src/milkdown-compat/frontmatter.ts
- An empty paragraph — a third Enter, on the empty line the second one left —
  is spelled in the file as an EXTRA
  blank line, never as HTML: `N` empty paragraphs between two blocks save as
  `N + 1` blank lines, and `N` blank lines between two blocks load as `N - 1`
  empty paragraphs, so the gap survives a reload and the second save is a fixed
  point. Blank lines before the first block are kept the same way; blank lines
  at the very end of a note are not (a trailing empty paragraph is dropped on
  save). Milkdown's own spelling, a literal `<br />` on a line of its own, is
  never written; one an older build wrote loads as the single empty paragraph it
  stood for and is re-spelled as blank lines on the note's first real edit
  (ADR-0002). An author's inline `<br>` beside text is untouched. Two lists with
  an empty paragraph between them keep different markers (`-` then `*`, `1.`
  then `1)`) so the blank line does not merge them into one list; the empty
  paragraph the schema itself puts in front of a list item whose content is a
  block (`- > quote`) is never written. →
  packages/editor/src/milkdown-compat/emptyLine.ts (load),
  packages/editor/src/markdown/serializer.ts `joinDocument`/`planDocument`,
  packages/editor/src/markdown/blocks.ts `writeItem`,
  tests/editor-embed-milkdown-compat.spec.ts
- Progressive open preserves those gaps across chunk seams: the blank run a cut
  leaves at the end of one chunk is counted by the loader and re-inserted as
  empty paragraphs in front of the next, so a note opened in chunks is the same
  document as the note opened whole. →
  src/features/editor/milkdown/progressiveLoad.ts `seamEmptyParagraphs`

## Paragraphs and lines

- Enter is a newline. Inside a paragraph, Enter puts the caret on a new line and
  writes exactly one newline to the file — no blank line, no trailing spaces, no
  backslash, no HTML. Shift+Enter is the same key everywhere but a table cell,
  and the on-screen keyboard's return key is the same key on iOS and Android. →
  src/features/editor/milkdown/paragraphLines.ts `enterInParagraph`,
  src/features/editor/milkdown/keyboardParity.ts,
  tests/editor-embed-milkdown-interactive.spec.ts
- Enter on an empty line ends the paragraph: two Enters write one blank line. A
  third Enter leaves an empty paragraph, the extra blank line above. Enter at
  the very start of a line splits the paragraph there the same way, because a
  blank line inside a paragraph is a paragraph break in the file.
- A file whose lines are separated by single newlines opens with those lines
  shown one under the other, and opening it does not rewrite it. An older
  note's `\` or two-space hard break also opens as a line break.
- Backspace at the start of a line joins it to the line above. At the start of
  a paragraph that follows another paragraph it removes ONE newline, so the two
  become lines of one paragraph again: Backspace takes back exactly one Enter.
  Delete at the end of a paragraph does the same forwards. When the paragraph
  above already ends in an empty line (an Enter at its end), the next one joins
  onto that line, so a join never leaves an empty line inside a paragraph. →
  paragraphLines.ts `joinBackwardAsLine` / `joinForwardAsLine`
- Formatting typed across an Enter stays one run: bold carried over a newline
  saves as one `**…**` spanning both lines. Undo after an Enter takes back
  exactly that newline.
- Lists, headings, blockquotes, code blocks and table cells keep their own
  Enter: a list item continues the list, a heading starts a paragraph after it,
  a quote or a code block takes the new line inside it, and a table cell moves
  down a row (Shift+Enter there is an in-cell line break). Shift+Enter in any of
  them does what Enter does.
- A block shortcut typed at the start of a line — `- `, `1. `, `> `, `# `,
  ` ``` `, `---`, `|2x3| ` (a table) — starts that block from that line alone;
  the lines above stay a paragraph. A block format from the toolbar or the `/`
  menu lands the same way, on the lines the caret or selection touches, each
  becoming its own block. → paragraphLines.ts `handleLineStartShortcut` /
  `isolateSelectedLines`, paragraphLines.preset.test.ts (the shortcut list
  checked against the presets)
- A paragraph is one block however many lines it has: the native shells'
  long-press drag moves it whole.
- A newline at the very end of a note is not written (trailing whitespace is
  not content), so a note left ending in an empty line reloads without it. →
  packages/editor/src/milkdown-compat/trailingParagraph.ts `endsInUnwrittenBlank`,
  milkdown/hostHandle.ts `holdsExactly`

## Markdown house style — what a save writes

A save writes ONE fixed spelling, stated here line by line. A dispute about a
byte is settled by these lines, not by the code. → packages/editor/src/markdown/
(the serializer), tests/conformance/markdown-house-style.json (the
hand-reviewed goldens, one or more per line below)

- Opening a note never rewrites it; the first real edit re-spells the whole
  note into this style, once (see "WYSIWYG rendering").
- The style never remembers how the file spelled something: not its list
  markers, its `_` or `*`, its `1)` numbering, its padding, or its line endings.
- Every device writes identical bytes for the same document.
- A second save is a no-op: writing a document, reading the result back, and
  writing again gives the same bytes.
- Line endings are LF.
- A non-empty file ends in exactly one newline; an empty note is an empty file.
- A save costs time in proportion to the blocks that changed, not to the
  length of the note.

### Text and escaping

- A character is escaped only when the app's own parser would otherwise read
  the line as a different document, and that is decided by parsing what would
  be written, not by a list of risky characters. So `snake_case`, `$x_1$`,
  `#tag` at the start of a line, `1.5` and `a * b` are written as typed,
  while `\# not a heading`, `1\. not a list`, `\*not italic*` and `\<div>`
  get the one backslash that keeps them text.
- When either of two delimiters could carry the escape, the opening one does.
- A character that cannot take a backslash is written as a character
  reference (`&#x20;`) where the parser would otherwise drop or reinterpret
  it: whitespace at the start of a line, and the letter or space beside
  formatting that would not otherwise open or close (`**Note:**&#x62;ar`).
- The formatting marker changes in one case only: an italic or bold run that
  starts exactly where another `*` run ends is written with `_` if, and only
  if, a parse says the two `*` runs would merge.
- Whitespace at the end of a line is not written: the parser drops it on every
  read, so writing it would only make the next save differ.
- A line break at the very end of a paragraph or heading is not written, for
  the same reason.

### Paragraphs and line breaks

- An inline line break (one Enter, or a single newline the file already had)
  is written as one `\n`.
- A newline directly before inline HTML stays a newline.
- An empty line inside a paragraph (two line breaks in a row, as Enter at the
  end of a line with a line below it makes; a line holding only whitespace is
  empty; one holding only a link's opening `[` or closing `](…)` is not) is
  written as an empty line, never as a character reference, a backslash or a
  space. In the file an empty line is a paragraph break, so `one`, two line
  breaks, `two` is written `one\n\ntwo` and reads back as two paragraphs.
- Each further empty line in the same run is one empty paragraph between the
  two paragraphs (`one\n\n\ntwo` for three line breaks).
- Empty lines at the start of a paragraph are empty paragraphs before it.
- The line break before an empty line ends a paragraph, so it is not written,
  even an older file's hard break (`\`).
- An older file's hard break (`\` or two trailing spaces) is written as `\`
  plus a newline in a paragraph.
- A hard break in a table cell is written `<br>`.
- A heading is one line: its line breaks, a setext heading's included, are
  written as spaces.
- An empty paragraph is an extra blank line, never HTML: `N` empty paragraphs
  between two blocks are `N + 1` blank lines.
- `N` empty paragraphs before the first block are `N` blank lines at the top of
  the file.
- Empty paragraphs at the end of the note, or at the start or end of a quote,
  list item or footnote, are not written.

### Blocks

- Headings are ATX: one to six `#`, a space, the text. Never setext.
- A thematic break is `---`.
- A thematic break on the note's first line is `---` too, unless a parse
  shows `---` there would open front matter: a later line of the note would
  close it (a later `---` rule, or a `---` line in a code block). Only then is
  it `***`.
- Inside a quote, list item or footnote, a thematic break is `***` wherever a
  parse reads `---` as something else: right under a paragraph (a setext
  underline), or as the first thing in a `-` item (a list item, not a rule).
- Bold is `**text**`, italic `*text*`, bold italic `***text***`, strikethrough
  `~~text~~`.
- Marks over the same text nest strikethrough outermost, then bold, then
  italic (`~~***text***~~`).
- Two italic (or two bold) runs that touch are written as one.
- Inline code is a backtick run one longer than any run inside it (`` `a` ``,
  ``` `` a`b `` ```).
- Inline code gets one space of padding on each side when it starts or ends
  with a backtick, or starts and ends with a space.
- Fenced code uses backticks — at least three, and one more than the longest
  run of backticks that starts a line inside — then the language, the content
  exactly as held, and the closing fence.
- A fenced code block whose language contains a backtick gets a `~~~` fence
  instead.
- A blockquote prefixes each line with `> `, and a blank line inside it with
  `>`.
- Inside a quote, a list that touches another list or a quote is written
  directly above it, with no blank `>` line: the parser reads a list followed
  by a blank `>` line and then a list or a quote as loose.
- Where the parser's reading of a list inside a quote or a tight item needs a
  blank line the rules above would not write (a paragraph after a nested list
  in a tight item, the end of a quote after a loose nested list), or an HTML
  block that followed a tight item's paragraph on an unindented line, that
  layout is written — decided by parsing, and only where it keeps the list as
  tight or loose as it was.
- A front matter block is `---`, its body exactly as read (with LF line
  endings), and `---`, followed by a blank line before the body.

### Lists

- Bullets are `-`.
- Ordered items are numbered as they appear on screen: the list's start
  number, then one more per item, each followed by `.`.
- A tight list stays tight (one newline between items) and a loose list stays
  loose (a blank line between items).
- Inside an item, its blocks are separated the same way the item itself was
  read: a newline when tight, a blank line when loose.
- An item whose blocks only a blank line keeps apart is written loose, because
  no tight spelling exists for it: two paragraphs in a row (what Backspace at
  the start of a nested item leaves), or an empty paragraph between two blocks.
- An item's continuation lines are indented by the width of its own marker:
  two spaces under `- `, three under `1. `, four under `10. `. A nested list
  therefore parses back at the same depth.
- Two lists of the same kind that touch, or that only empty paragraphs
  separate, alternate markers — `-` then `*`, `1.` then `1)` — because
  CommonMark would otherwise read them as one list.
- A task item is `- [ ] text` or `- [x] text`.
- An empty task item is `- [ ]`, never a bare `-`.
- An empty item is its marker alone (`-`, `1.`).
- An item whose first block is not a paragraph writes that block on the marker
  line (`- > quote`, `- # heading`).

### Tables

- Every cell has one space either side of its content and the columns are not
  padded to a common width: `| a | b |`.
- An edit to one cell never re-spells another row.
- The delimiter row is `---` for a column with no alignment, `:--` left, `:-:`
  center, `--:` right. A column the author never aligned stays unaligned.
- A `|` inside a cell is written `\|`, in code, wikilinks, and link and image
  destinations and titles too.
- A line break inside a cell is `<br>`, at the end of the cell too: the
  parser reads `x<br>` back as `x` and a line break.
- A cell holding only line breaks is written empty: a lone `<br>` reads back
  as an empty cell.

### Links, images and the constructs the editor does not model

- A link is `[text](url)` or `[text](url "title")`.
- A link or image destination with a space, a backslash, a control character
  or unbalanced parentheses in it, or one that starts with `<`, is written
  `<url>`; balanced parentheses stay bare (`wiki/Foo_(bar)`).
- A link whose text is its own URL (`https://…`, `www.…`, an email address) is
  written bare whenever the bare text reads back as the same link, and
  otherwise as `<url>` (as `[www.…](http://www.…)` for a `www.` link, which
  has no `<…>` form).
- An image is `![alt](src)`, with `"title"` only when it has one; a save never
  adds a title.
- A wikilink is `[[target]]` with the target exactly as held.
- A footnote reference is `[^label]`.
- A footnote definition is `[^label]: text`, with continuation lines indented
  four spaces.
- Inline HTML, HTML blocks, front matter bodies and unused link reference
  definitions are written back exactly as read, with two exceptions below.
- An HTML block's indentation before its first tag is not written: it is
  layout, not HTML, and kept it would put the block in a different container
  once list indentation is the house style's.
- CR and CRLF line endings inside them are written LF.

## Localization

- The editor receives the host's effective language during initialization and
  whenever it changes. It reconfigures FUTO-authored labels and accessibility
  text without reloading the note or changing its content. →
  [localization.md](localization.md)
- Editor UI text resolves through the shared language catalog. The toolbar
  manifest carries semantic localization paths instead of English labels, and
  generated Swift and Kotlin toolbar specifications carry those paths without
  changing command identity, order, visibility, icons, or behavior. →
  [localization.md](localization.md), packages/editor/src/toolbar.ts,
  scripts/gen-toolbar-spec.ts

## Cursor

### Placement

- Tapping text places the caret at the tapped character. →
  src/features/editor/milkdown/MilkdownEditor.svelte
- Caret placement, arrow motion, word/paragraph selection on multi-tap, and
  drag-selection are the PLATFORM's own: the editor runs no pointer hit-testing
  or cursor-motion code of its own. (The CodeMirror editor did, because a
  live-preview document has hidden source a native hit test would place a caret
  inside; there is no hidden source here.)

- Pressing Enter in a continued list item scrolls the new item into view. →
  docs/learnings/ios-keyboard-editor-jump.md _(iOS)_

### Blank editor surface

- Blank space beside lines and below the final line is part of the editor: the
  editable element IS the scroller, and its gutters and its tail belong to it,
  so a press there places a caret rather than falling through to the shell. →
  src/features/editor/milkdown/milkdownEditor.css `.ProseMirror`
- The editable element fills the whole note area in BOTH axes, however little
  the note holds: it is never sized to its own content. A box sized to its
  content leaves the space it fails to reach owned by no one — the desktop
  shell's deselect zone ignores presses on a descendant — so that space would
  place no caret, take no focus, and swallow the press entirely. → src/features/
  editor/milkdown/milkdownEditor.css `.milkdown` / `.ProseMirror` _(desktop)_
- The body's first character sits under the title's first character: the
  860px editor column is 60px wider than the 740px title column on each side,
  and the body's left padding is that 60px plus the title's 20px. The ⠿ handle
  floats inside that padding. _(desktop)_ → src/features/editor/milkdown/
  milkdownEditor.css `.desktop-layout .ProseMirror`, tests/p2-regressions.spec.ts
- An empty note is therefore fully typeable: it holds one empty paragraph, and
  a press ANYWHERE in the note area places the caret in it. This is the state
  every new note starts in. → tests/p0-regressions.spec.ts "Empty-note caret",
  tests/editor-embed-milkdown.spec.ts
- The tag bar's blank space reaches the first line of the editor at the
  pointer's column: pressing it focuses the editor and places the caret at that
  x on the first line. Tag controls and the title keep their own interactions.
  → NoteWorkspace.svelte `reachFromTagBar`, milkdown/hostHandle.ts
  `placeCaretAtCoords`
- A primary press outside the desktop editor surface deselects the note without
  moving its caret and commits a pending title rename; movement during that
  press does not turn it into a text-selection drag. → NoteWorkspace.svelte
  `handleNoteBodyMouseDown` _(desktop)_

### A note the editor cannot hold

- A note whose markdown makes the parser throw is shown READ-ONLY with a visible
  "This note could not be displayed" message, never as a blank editable page. →
  src/features/editor/milkdown/documentSession.svelte.ts `loadFailed`,
  src/features/editor/milkdown/MilkdownEditor.test.ts
- For such a note the editor reports the HOST's original bytes as its content —
  the same load-echo contract as an unedited note (ADR-0002), extended to the
  case where the document is not the note at all — emits no change, and refuses
  chrome edits (tag bar, toolbar insertions). The file is never rewritten. →
  milkdown/hostHandle.ts `getContent`, `applyEdit`, `insertMarkdown`
- The next note that parses clears the state completely: editable again, no
  message, its own content reported.
- An editor instance that has never been handed a note reports "no content at
  all" (`undefined`), not an empty note. A replaced component — a dev hot
  reload today, any `{#key}`/`{#if}` around the editor tomorrow — mounts empty
  under a session that still holds the note, and `''` there is what truncated
  three real notes on 2026-09-03. The desktop shell also re-hands the open note
  to a new instance, so the reader gets it back. → milkdown/hostHandle.ts
  `getContent`, NotesShell.svelte, noteSession.svelte.ts `reattachEditor`

### Native touch and focus

- Tapping an unfocused editor places the caret at the tap and raises the
  keyboard; wrapped-line taps remain on the tapped visual row. On-text and
  off-text placement alike are the platform's own contenteditable behavior.
  _(native shells)_
- A caret the keyboard rises over is scrolled back into view as the keyboard
  lands: tap the last word of a note that fills the screen and that word ends up
  above the keyboard and its toolbar straight away, not on the first keystroke.
  ProseMirror only scrolls on its own transactions and a tap is not one, so the
  embed re-reveals the selection whenever the shell resizes the web view under a
  focused editor. On Android the editor column's `imePadding` really does resize
  the web view (a window `resize` for each frame of the keyboard animation), and
  the System WebView also scrolls the focused caret into view by itself: with the
  embed's reveal suppressed the tapped line still ended up above the toolbar.
  The embed's reveal is what iOS needs and is harmless there. Verified on the
  emulator (API 36, System WebView 133.0.6943.137) 2026-09-23. _(native
  shells)_ → src/editor-embed/main.ts `resize` listener,
  src/features/editor/milkdown/hostHandle.ts `revealSelection`

- The editor reserves a tail below the last line — `max(40vh, 280px)` of bottom
  padding on the editable — so the final line can be scrolled clear of the
  keyboard. The tail scales with the viewport, so a note that does not fill the
  screen still has nothing to scroll. →
  src/features/editor/milkdown/milkdownEditor.css `.ProseMirror` padding

- Native-shell policy comes from the host-provided `nativeShell` mode: it is
  what selects the long-press block drag over the ⠿ gutter handle, and what
  turns on the native-toolbar layout. → packages/editor/src/hostBoot.ts,
  src/features/editor/milkdown/blockDragMode.ts `resolveBlockDragMode`
- On-text double/triple-tap selection, selection handles, the loupe and the
  platform callout are all native on both shells; the editor adds nothing to
  them and takes nothing away, except while a block-drag press is live (see
  "Selection"). _(native shells)_

### Typing and IME

- The editable asks the on-screen keyboard for autocorrect and sentence
  capitalisation, and turns off red spellcheck squiggles and Apple's inline
  writing suggestions (`autocorrect="on"`, `autocapitalize="sentences"`,
  `spellcheck="false"`, `writingsuggestions="false"`). A keyboard is not an
  implementation detail of the engine: the editor first shipped with autocorrect
  off alongside the squiggle fix, and every note typed in the native shells lost
  autocorrect and predictive text until 2026-09-01. →
  src/features/editor/milkdown/editorPlugins.ts,
  tests/editor-embed-ime.spec.ts

### Selection

- Both native shells drag a block by LONG-PRESSING THE BLOCK ITSELF — there is
  no ⠿ handle anywhere in the editor on a phone, and the left gutter that would
  hold one is not reserved. Touch and hold a block for ~340ms and it lifts as a
  card-like ghost under the finger, dragging floats it with a drop-indicator
  line at the resolved top-level boundary, and release commits the move. The ⠿
  gutter handle is the DESKTOP gesture only. Verified on an Android
  device 2026-09-01 (moto g play 2023, System WebView 151) and on the iOS
  simulator. → src/features/editor/milkdown/blockDragMode.ts
  `resolveBlockDragMode`, src/features/editor/milkdown/mobileBlockDnd.ts,
  src/features/editor/milkdown/blockDragMode.test.ts
  _(native shells)_
- Editor focus arbitrates block drag against text selection on both native
  shells: a press that starts with the editor already focused (soft keyboard
  up) is left completely alone — text selection and caret placement, exactly
  as if this plugin did not exist — and a press that starts with the editor
  unfocused (keyboard down) arms and may lift a block, as above. Before this,
  every press suppressed selection rendering and armed the lift timer
  regardless of focus, so a phone's long-press-to-select-a-word was always
  read as "lift this block" instead — reported by QA on the 1.7.2-4 builds.
  Checked once, at touch-down; a press already in flight does not re-arbitrate
  mid-gesture. → src/features/editor/milkdown/mobileBlockDnd.ts
  `onPointerDown`, src/features/editor/milkdown/mobileBlockDnd.test.ts,
  tests/editor-embed-milkdown.spec.ts _(native shells)_
- The lifted ghost shows the WHOLE block from its very first frame, sits over
  the block it was lifted from (padded by the card's own breathing room, so it
  reads against the drop-indicator line, which is drawn in viewport space), and
  is capped at 40% of the screen height — only a block that genuinely exceeds
  the cap is cropped, and that crop fades out rather than cutting off. The
  card must never carry a `vh` height cap: both native hosts' web view
  resolves viewport units against a zero-height containing block, so `40vh`
  came out as `0px` and the card collapsed to its own padding. The cap is
  therefore computed in pixels from `window.innerHeight`. Verified on the pool
  emulator 2026-09-03 (Android 16, Chromium 133 WebView). (Until 2026-09-05 the
  card also had to shed the editor's offscreen-block containment rule, which
  cropped it to one unrendered line on Android; that rule is gone — see
  Performance.) →
  src/features/editor/milkdown/mobileBlockDnd.ts `createGhost`
  `GHOST_MAX_HEIGHT_FRACTION`, tests/editor-embed-milkdown.spec.ts
  _(native shells)_
- On desktop a ⠿ handle appears in the left gutter beside the block under the
  pointer — in the GUTTER, 4px left of the text column, at every nesting depth:
  a list item's own box starts at its text, so an offset from that box would
  put the handle over the bullet, and over the parent's text for a nested item
  — and dragging it with a mouse reorders blocks. Where there is no
  hover, the handle is still surfaced for the block that was just tapped or
  that the caret moved into, but dragging it needs a mouse: the handle's drag
  is @milkdown/plugin-block's HTML5 drag, which no touch or pen gesture
  starts. → src/features/editor/milkdown/blockDrag.svelte.ts,
  src/features/editor/milkdown/blockMove.ts _(desktop)_
- A dragged block lands among its own kind. A top-level block sees only the
  gaps between top-level blocks: just below a blockquote is NOT "inside the
  blockquote", however the schema would read that position. A list item sees
  the gaps between the items of its list, the items of any other list of the
  same type at any depth, and the top-level gaps — where it is wrapped in a
  fresh list of the type (and attributes) it came out of, and a list it was the
  only item of goes with it rather than staying behind empty. A top-level gap
  directly beside a list of the item's own type IS that list's end (or start):
  two adjacent lists of one type are one list in markdown, so dragging a bullet
  just below its list makes it the last bullet, and dragging it past the next
  block takes it out. → src/features/editor/milkdown/blockDragGeometry.ts
  `resolveDropTarget`, src/features/editor/milkdown/blockMove.ts `moveBlock`,
  src/features/editor/milkdown/blockDragGeometry.test.ts,
  src/features/editor/milkdown/blockMove.test.ts, tests/editor-embed-milkdown.spec.ts
- On desktop the ⠿ handle beside a list's FIRST item drags that item, like the
  handle beside every other item. @milkdown/plugin-block resolves a first child
  to its parent, so the handle it draws for a first bullet stands for the whole
  list; the drag is re-targeted at `dragstart` to the item whose box the pointer
  is in. → src/features/editor/milkdown/listItemHandleDrag.ts,
  src/features/editor/milkdown/listItemHandleDrag.test.ts,
  tests/editor-embed-milkdown.spec.ts _(desktop)_
- The desktop ⠿ handle's native drag ghost is corrected for the display's
  `devicePixelRatio`: at 1x it is the browser/webview's own drag image,
  unchanged; at any other ratio a detached, counter-scaled clone is dragged
  instead of the live block, so the ghost matches the block's CSS size
  regardless of scale factor. QA on a scaled Linux/Hyprland desktop reported
  the ghost at roughly 200% size.
- There is ONE drop slot per boundary, on both drag gestures — between
  top-level blocks, and between the items of a list for a list item. Below
  block A and above the block directly under it are the same
  place, so they are one target: one indicator line, drawn IN the gap midway
  between A's bottom edge and B's top edge (on the outer edge at the document's
  first and last boundary), and one haptic tick for reaching it however the
  pointer got there. A block's OWN two boundaries stay distinct, because those
  are different positions. Both gestures resolve that one slot with the same
  code and commit through the same move, so neither the line's position nor the
  set of places a block may land can differ between them — which is why the
  desktop ⠿ handle draws OUR indicator rather than the one
  @milkdown/kit/plugin/cursor ships (it draws a line on every block's top edge
  AND every block's bottom edge, so each gap had two). →
  src/features/editor/milkdown/blockDragGeometry.ts `resolveDropTarget`,
  src/features/editor/milkdown/blockDropIndicator.ts,
  src/features/editor/milkdown/blockDragGeometry.test.ts,
  tests/editor-embed-milkdown.spec.ts
- The dragged block's own two boundaries draw no line and tick no haptic on
  either gesture, because a drop there is a no-op: the finger holding a block
  over the gap it already sits against would otherwise show the indicator
  running through the lifted card. On the native long-press the lifted card
  is drawn OVER the indicator line, with a translucent background, so the
  line — and the dimmed source block underneath at lift — stay visible
  through the card wherever it overlaps a boundary. → src/features/editor/milkdown/blockMove.ts
  `isNoOpDrop`, src/features/editor/milkdown/mobileBlockDnd.ts,
  src/features/editor/milkdown/blockDropIndicator.ts,
  src/features/editor/milkdown/blockMove.test.ts, tests/editor-embed-milkdown.spec.ts
- A block drag is haptic three ways on both native shells: one firmer impact
  when the block lifts, a light tick each time the drop indicator lands on a
  DIFFERENT top-level boundary, and one light impact when a release commits a
  reorder. A finger travelling inside one gap ticks nothing, a hold ticks
  nothing, edge auto-scroll ticks nothing (an auto-scroll is a hold, and a tick
  per boundary swept past would be a continuous buzz), and a release back at the
  source is silent (it commits nothing). Same gesture, same three moments, same
  feel on both. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  apps/ios/Sources/Editor/EditorWebView.swift `moveHapticFeedback`,
  apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt
  `performBlockDragHaptic`,
  tests/editor-embed-milkdown.spec.ts _(native shells)_
- On Android, a finger landing on a block silences the WebView's OWN long-press
  haptic for the length of the press, so the lift is felt once rather than as
  two impacts an eighth of a second apart. Chromium's long-press recogniser
  trips around touch-down + 480ms, 128-141ms after the editor's 340ms lift. A
  long press anywhere the editor does NOT claim as a block press still gets the
  platform's normal buzz, and the editor's own three haptics are exempted rather
  than silenced with it. Measured on a device 2026-09-01. →
  apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt
  `setBlockPressActive`, packages/editor/src/bridge.ts `BlockPressMessage`
  _(native shells, Android)_
- On Android that is ALL the shell does for the drag: Chromium's visible text
  interaction never appears over a lifted block. A stationary hold, editable
  focused and unfocused, draws no word highlight, no selection handles, no
  floating Cut/Copy action mode and no magnifier — the page's own suppression
  holds, which is the difference from WebKit. So the shell ignores `blockDrag`
  entirely FOR THOSE SELECTION VISUALS. Measured on a device 2026-09-01. Focus
  is a separate story — see the next two lines. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  packages/editor/src/bridge.ts `BlockDragMessage`
  _(native shells, Android)_
- An empty paragraph cannot be lifted: a hold on it lifts nothing and buzzes
  nothing, though the press still stands the platform's own hold gestures
  down like any block press. A tester's report — holding an empty line lifted
  a blank "phantom" card while, by the next line's mechanism, the keyboard
  rose underneath it — made the two visibly collide. →
  src/features/editor/milkdown/mobileBlockDnd.ts, tests/editor-embed-milkdown.spec.ts
  _(native shells)_
- A block press that begins with the editor unfocused never focuses it or
  raises the keyboard, however long it lasts and whether or not it lifts; a
  press that begins focused leaves focus alone (a drag while typing must not
  drop the keyboard). Measured on the pool emulator 2026-09-08 (Android 16,
  System WebView 133), touch stationary with the editor unfocused: Chromium's
  OWN long-press fires at touch-down + ~500ms and dispatches, in the same
  millisecond, `selectstart` on the block, `focus` on the editable, `focusin`,
  then `contextmenu` — and the `focus` lands regardless of the page cancelling
  `selectstart`/`contextmenu`/`touchend`; none of those three levers stop it,
  on text blocks as well as empty ones. A capture-phase `focus` listener on
  the document undoes it for a press that began unfocused. →
  src/features/editor/milkdown/mobileBlockDnd.ts, packages/editor/src/bridge.ts
  `FocusMessage`, tests/editor-embed-milkdown.spec.ts _(native shells, Android)_
- A block drag holding the pointer within 64px of the editor scroller's top or
  bottom edge scrolls the note continuously — 200px/s at the zone's inner lip
  ramping to 1400px/s at the edge — so a block can be dropped at a boundary that
  was off screen when it was lifted. It runs while the pointer holds still, stops
  at the document's ends, and stops on every exit (commit, no-op release, cancel,
  editor destroy). The drop indicator is recomputed each frame from the boundary
  now under the stationary pointer. Both drag paths share it: the native shells'
  long-press drag and the desktop ⠿ gutter handle's touch drag. Verified on an
  Android device 2026-09-01 — a hold within the zone scrolls continuously and
  stops on release; a hold mid-viewport does not scroll. →
  src/features/editor/milkdown/blockDragGeometry.ts `createDragAutoScroller`,
  src/features/editor/milkdown/blockDragGeometry.test.ts,
  tests/editor-embed-milkdown.spec.ts _(native shells)_
- A finger landing on a block in the long-press block drag suspends the
  platform's DELAYED text interaction from touch-down — the magnifier loupe and
  tap-and-a-half select — for as long as the press lasts, and restores it the
  moment the press resolves, however it resolves (lift, tap, scroll, cancel). It
  is requested at touch-down and not at the lift because the platform gesture
  fires at ~655ms with the editable focused and ~700ms unfocused, against the
  340ms lift: a press that produced no lift for any reason used to hand the user
  the magnifier and a word selection with nothing suspended at all. Measured on
  the simulator 2026-09-01. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  apps/ios/Sources/Editor/EditorWebView.swift `delayedTextInteractionGestures`,
  packages/editor/src/bridge.ts `BlockPressMessage`,
  tests/editor-embed-milkdown.spec.ts _(native shells, iOS)_
- A tap still places the caret and raises the keyboard, and a double-tap still
  selects a word and shows the platform Cut/Copy/Paste callout, during and after
  that press-level suspension: only the hold-triggered recognisers stand down,
  never the tap ones. An ordinary swipe scrolls and never lifts a block.
  Verified on the simulator 2026-09-01 and on an Android device 2026-09-01. →
  apps/ios/Sources/Editor/EditorWebView.swift `delayedTextInteractionGestures`,
  apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt
  `setBlockPressActive` _(native shells)_
- While a block is airborne in that drag, the suspension escalates to the WHOLE
  platform text interaction — no magnifier over the block being moved, no
  callout, no caret dragged along behind it, and the selection preference off —
  and steps back down the moment the gesture resolves, however it resolves.
  Nothing on the page can suppress it, so the editor reports both the press and
  the drag over the bridge and the shell decides what each means. Verified on the
  simulator 2026-09-01. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  apps/ios/Sources/Editor/EditorWebView.swift `applyTextInteractionLevel`,
  packages/editor/src/bridge.ts `BlockDragMessage`
  _(native shells, iOS)_
- Moving an airborne block sideways never starts a back-swipe, and a block is
  never left lifted once the finger is up. On iOS 26+ the navigation
  controller's content pop takes a horizontal drag from anywhere on screen, so
  it used to win a sideways block move: the editor started sliding away, and the
  page never heard the touch end, which left the block stuck in its lifted state
  with no finger on it. The airborne suspension therefore also disables the
  interactive pop recognisers (the leading-edge swipe and the full-width content
  swipe) and restores them when the gesture resolves. Android needs nothing
  extra: its back gesture only starts at the screen edge, so a drag that began
  mid-screen is never taken for one, even when the lifted block is carried to
  either edge and held there. A touch the platform cancels (an injected
  `ACTION_CANCEL`, or the notification shade pulled down mid-drag) drops the
  block too. Verified on the emulator with gesture navigation (API 36, System
  WebView 133.0.6943.137) 2026-09-23, on a fresh one-block note and a
  five-block one. → apps/ios/Sources/Editor/EditorWebView.swift
  `navigationPopGestures`, src/features/editor/milkdown/mobileBlockDnd.ts
  `onPointerCancel` _(native shells)_

## Markdown elements (rendered / decorated)

- Headings h1–h6, with inline emphasis / code / wikilinks inside.
- Emphasis: bold, italic, bold-italic, strikethrough — `*` and `_` markers.
- Code: inline (single and double backtick) and fenced (triple backticks or
  triple tildes, with optional language).
- Fenced-code syntax colouring covers a curated language set (~35), each grammar
  fetched the first time a fence uses it. A fence in any other language still
  renders as a code block, just uncoloured.
  → src/features/editor/codeFenceLanguages.ts
- Links: `[text](url)`, autolinks `<url>`, and bare GFM URLs.
- Blockquotes, including nested: each level renders as an indented block with a
  muted left rule, whatever `>` characters and lazy continuations CommonMark
  read it from. No `>` marker is on screen at any depth, so no indent shifts
  when the caret enters a quote. → src/features/editor/milkdown/
  milkdownEditor.css `.ProseMirror blockquote`,
  tests/blockquote-continuation.spec.ts
- Lists: ordered, unordered, nested, and task checkboxes (checked / unchecked /
  uppercase `X`).
- List depth comes from CommonMark's parse, not from counting spaces — a whole
  list indented by one to three spaces still renders as a list, and `*  Parent.`
  (two spaces after the marker) puts its content at column 3, so a two-space
  child is too shallow to nest and renders level with its parent as a sibling.
  → packages/editor/src/milkdown-compat/, tests/editor-embed-milkdown.spec.ts
- Ambiguous list syntax follows CommonMark. A bullet followed by an ordered-list
  marker on the same line (such as `* 0. text`) is a nested ordered list; authors
  can escape the period to keep literal numbering. This does not change the
  preservation of extra blank lines or the rule that opening alone never saves.
  → packages/editor/src/milkdown-compat/index.ts,
  tests/editor-embed-milkdown-compat.spec.ts
- Nesting indentation is BOUNDED, so a deeply nested list stays readable at
  phone width: levels one to four indent 1.4em each, five to eight 0.7em, and
  from level nine the indent stops growing — at most 8.4em (143px) in total,
  which leaves ~187px of column at ANY depth on a 402px screen. Before this, a
  590-byte note holding one bullet nested 20 levels deep opened to a completely
  blank body: a `padding-left` larger than its container shrinks the content box
  instead of overflowing it, so levels 13+ computed to ZERO width, 14+ started
  past the right edge, `scrollWidth === clientWidth` left nothing to scroll to,
  and the load-time viewport parked in the empty region. Ordinary one-to-three
  level lists are unchanged; past level eight the levels stop being told apart
  by their left edge, which is the deliberate half of the trade. Measured at
  402x874. → src/features/editor/milkdown/milkdownEditor.css,
  tests/editor-embed-milkdown-deep-nesting.spec.ts

- A list item that wraps **hanging-indents** its continuation lines: wrapped
  rows start under the item's text, never back under its marker, while the
  first visual row still starts at the nesting indent. Applies to bullets,
  ordered items, and task items at every nesting depth, on every platform
  (spec decision 2026-08-14, reversing the 2026-06-10 decision that put
  wrapped rows at the left margin). The list is a real `<ul>`/`<ol>`, so the
  hang is the browser's own list layout and the marker column is exactly as
  wide as the rendered marker. →
  src/features/editor/milkdown/milkdownEditor.css,
  tests/bullet-glyphs.spec.ts
- An empty list item shows its marker. A bullet or number started from the
  toolbar appears the moment the button is tapped, not after the first
  keystroke. iOS WebKit draws no marker for an item whose only line is
  ProseMirror's trailing `<br>`, though desktop WebKit does, so that line gets a
  zero-width `::before` box to hang the marker on. It is CSS only, so nothing
  reaches the saved Markdown. Verified 2026-09-23 on desktop (macOS WKWebView,
  typing `- ` / `1. `) and on the Android emulator (API 36, System WebView
  133.0.6943.137, from the toolbar): the marker shows before any typing, the
  first character lands at the item's text edge with no gap, and the file reads
  `- X` / `1. y` with no zero-width character in it. Not yet checked on Linux
  WebKitGTK or Windows WebView2. → src/features/editor/milkdown/milkdownEditor.css
  `li > p:first-child:has(> br.ProseMirror-trailingBreak:only-child)::before`,
  tests/editor-embed-milkdown-toolbar.spec.ts "gives the empty item a
  zero-width marker anchor"
- Tables (GFM), horizontal rules, and images render as themselves. A table
  scrolls sideways inside its own box rather than widening the note; an image is
  capped at the column width and 300px tall. →
  src/features/editor/milkdown/milkdownEditor.css
- On the native shells the embed page pins `body` to the web view with
  `position: fixed` plus the four offset longhands, and `#editor` fills that body
  the same way. Both rules live unlayered in `editor.html`, never as `inset` and
  never behind `@layer`: a Chromium 80–98 Android System WebView discards every
  layered rule (so `base.css`'s identical `body` rule never arrives) and one
  below 87 also drops the `inset` shorthand, and that engine sizes the initial
  containing block to zero — so without both rules the editable never becomes a
  scroll container, and the browser scrolls the ROOT document to reveal the
  caret, sliding the note up under the shell's native title bar as the user types
  (github#33, reported on 1.7.0 / Android 10; reproduced and fixed on a
  Chromium-83 WebView 2026-08-21). → editor.html, tests/editor-embed-webview-floor.spec.ts
  "pre-inset WebView"
- The editable element is the editor's own scroll container, and it keeps the
  platform's overscroll affordance (`overscroll-behavior: contain` — iOS bounce /
  Android stretch) rather than chaining scroll out to the host web view. →
  src/features/editor/milkdown/milkdownEditor.css `.ProseMirror`
- Wikilinks `[[Title]]`.

### YAML front matter

- A note that OPENS with a `---` fence, closed by a later `---` fence, carries
  YAML front matter: the two fences and everything between them are metadata,
  not markdown. The bytes survive every edit made elsewhere in the note
  byte-for-byte — brackets, hashes, asterisks, quotes, indentation, trailing
  spaces and interior blank lines included. Front matter is the one construct
  ADR-0002's normalize-once does NOT get to re-spell: it is not markdown, so
  there is no re-spelling of it that preserves its meaning to the tools that
  read it. → packages/editor/src/milkdown-compat/frontmatter.ts,
  tests/editor-embed-milkdown-compat.spec.ts,
  tests/editor-embed-milkdown.spec.ts
- Both fences must be exactly three dashes at column 0 with nothing after them
  but whitespace. `----`, ` ---`, and a `---` with no closing fence are a
  thematic break (and, with a line above it, a setext heading) exactly as
  CommonMark says — and a `---` anywhere but the first line of the note is
  always a thematic break. A save writes a thematic break on the note's first
  line as `***` only where `---` would open front matter there, because a
  later line would close it (see "Markdown house style", which lists every
  place `***` is written).
  (`+++` TOML front matter is not recognised and round-trips as the paragraph
  CommonMark reads it as.)
- The block is RENDERED, as one inert metadata panel above the body: muted, monospace, with a left rule, and no
  caret. It cannot be typed into, clicked into, dragged, or reordered — the
  editor has no YAML model, so it shows the bytes and refuses to edit them.
  Deleting the whole note still deletes it. →
  src/features/editor/milkdown/milkdownEditor.css `.futo-frontmatter`
- A note whose ONLY content is front matter gets the empty body paragraph the
  schema requires (the document's content is `frontmatter? block+`). That
  paragraph is what gives the caret somewhere to go that is not a selection ON
  the metadata. It is a trailing empty paragraph, so a save does not write it:
  the file stays the front matter block and its newline. Opening such a note
  still changes nothing.
  → packages/editor/src/milkdown-compat/frontmatter.ts `FRONTMATTER_DOC_CONTENT`
- Progressive open never cuts a chunk boundary at a `---` fence, or anywhere
  inside the note's own front matter: each chunk is parsed as its own document,
  so a chunk that BEGAN with `---` would read a mid-note thematic break as
  front matter. → src/features/editor/milkdown/markdownChunks.ts,
  src/features/editor/milkdown/markdownChunks.test.ts

## Tags

- A `#tag` is extracted and decorated only when it is at a word boundary, does
  not start with a digit, is within the max length, and is NOT inside inline
  code or a fenced block. A tag stays PLAIN TEXT in the document — it is neither
  a node nor a mark — and is decorated with colour only, so typing inside one
  never shifts the line. → packages/editor/src/tags.ts,
  src/features/editor/milkdown/tagDecorations.ts,
  src/features/editor/milkdown/tagDecorations.test.ts
- Tags dedup case-insensitively (`#Project` + `#project` → one `#project`).
- A leading header tag block is recognized as the note's tag block — it is what
  the desktop tag bar reads and writes — and it renders as ordinary text with its
  tags decorated. It is NOT hidden: a node rendered `display: none` cannot be
  reached by caret or click, so hiding it would leave the note's tags uneditable
  on the native shells, which have no tag bar, and a Backspace at the start of
  the following paragraph would silently join an unseen block. →
  src/features/editor/milkdown/tagDecorations.ts,
  docs/plan/milkdown-transition.md "T5 outcome"

## Tag bar _(desktop)_

The tag bar is a **desktop-only surface by decision (2026-06-09)** — mobile
native shells edit tags as text in the body, which is not a gap.

- A tag bar sits between the title and the editor: one chip per current tag,
  plus a "+ Tag" affordance. → NoteTagBar.svelte
- "+ Tag" opens an inline input with autocomplete over the vault's existing
  tags (case-insensitive); a non-matching entry shows a "Create #name" option.
  Enter or comma commits.
- Committing a tag writes it into the note's **leading header tag block**
  (creating the block when absent) — the tag is note content, not metadata.
- Removing a chip removes the tag; removing the last tag removes the entire
  header block.

- An underscore INSIDE a word survives a save unescaped: `#dog_problems`,
  `snake_case_word` and `file_name.txt` are written back exactly, on every
  platform, whether the edit came from the keyboard or from the desktop tag bar
  (which commits through a full re-serialization). Only a `_` the parser would
  read as an emphasis delimiter is escaped (`\_not em_`), so `_em_` still
  round-trips as emphasis (written `*em*`) and a `_` between spaces stays bare
  (see "Markdown house style"). →
  packages/editor/src/markdown/choose.ts,
  tests/editor-embed-milkdown-parity.spec.ts, tests/tags.spec.ts

## Wikilinks — navigation & integrity

- `[[`…`]]` is a wikilink when it holds at least one character that is neither a
  line ending nor the start of `]]`; the whole inner text is the target. A `!`
  immediately in front of one (`![[Note]]`, Obsidian's embed syntax) is **plain
  text followed by a wikilink** — the `!` is claimed as text so micromark's
  image label cannot swallow the `![` and leave the link escaped. **Everywhere
  else a `!` is ordinary text and begins nothing**: at the end of a line, at the
  end of the file with no trailing newline, inside a table cell (`| a | no!! |`),
  before a space, or before another `!`. The tokenizer decides this BEFORE it
  opens its token, so no path can strand one open — a stranded `wikilink` token
  stops the enclosing paragraph or table cell from closing, which threw on parse
  and opened the WHOLE note blank on every shell (issue #112, fixed
  2026-09-03). → src/features/editor/milkdown/wikilink/syntax.ts,
  src/features/editor/milkdown/wikilink/syntax.test.ts,
  tests/editor-embed-milkdown-wikilinks.spec.ts
- Clicking/tapping a wikilink navigates to the target note (desktop:
  Cmd/Ctrl+click opens it in a new tab; middle-click opens it in a background
  tab). Rapid clicks on separate links each navigate. → NotesShell.svelte
  onopenlink, milkdown/linkTaps.ts `handleLinkClick`
- A wikilink displays the **shortest unique path suffix** (`[[Projects/Roadmap]]`
  renders as "Roadmap" while unambiguous). The native shells feed the vault
  note list into the shared editor WebView over the bridge (`setNotes`), so
  the same resolver runs there (verified Android native + iOS simulator
  2026-06-09). → wikilinks.ts, packages/editor bridge v2,
  EditorWebView.kt / EditorWebView.swift
- Typing `[[` opens autocomplete over all note ids; selecting inserts the full
  path, **closes the `]]`, and drops the caret AFTER the link** (`[[Title]]|`)
  so typing continues past the link, not inside it (a bare change dispatch left
  the caret stranded after `[[`). Works on desktop and both native shells (same
  embed; verified on emulator + simulator 2026-06-09; caret-after-`]]` verified
  emulator + simulator 2026-07-08). The completion inserts the wikilink NODE and
  puts the selection just past it. →
  src/features/editor/milkdown/wikilink/autocomplete.ts,
  src/features/editor/wikilinkSuggestions.ts
- A wikilink whose target does not resolve is still decorated, styled **broken**
  (`cm-md-link cm-md-wikilink cm-md-wikilink-broken`) — not undecorated, and
  **visually distinct from a resolved link** (muted/dimmed styling so a dead
  link is identifiable before you tap it). The
  resolver (`resolveWikilink`) treats an **ambiguous** target (a bare filename
  matching more than one note) exactly like an absent one: both return `null` and
  render broken. Tapping a broken wikilink opens an empty editor bound to the
  wikilink's target text as the title; the note file is **created on the first
  edit/save**, not eagerly at navigation time — a **deferred** create-on-missing
  path (2026-07-11 decision). The earlier "eager" wording was already false on
  shipped desktop: `read_note` returns `""` for a missing file (never throws), so
  the create-on-missing catch in `loadNote` was dead and the empty note simply
  opened via the normal read path; the file appeared only once the user edited.
  → src/features/editor/milkdown/wikilink/display.ts, wikilinks.ts
  `resolveWikilink`, createNoteLoader.ts, editor-embed/main.ts
- On the native shells, tapping a resolved wikilink navigates: the embed
  resolves the raw target against the pushed note list and posts `openNote`
  to the host, which **PUSHES a new editor onto the nav stack** — so **Back
  returns to the note you came from, not straight to the list** (a browser-like
  history of visited notes). A broken link posts nothing; a self-link (a
  wikilink to the note you are already on) is a no-op. Taps navigate via a
  dedicated `touchend` path — WebKit cancels the synthetic `click` after the
  handler's prevented `mousedown`, so a click-only handler dead-ends on iOS
  while Chromium double-fires; the touchend path covers both. A tap on a
  navigable link follows it on the **first** tap even when the editor is
  unfocused: a `touchend` that lands on a resolved wikilink or external link is
  handled by the link path rather than left to place the caret (a _broken_
  wikilink still
  focuses, so it can be edited). The editor consumes a tap on a NAVIGABLE link
  (`consumesTap`) and deliberately leaves a broken one to ProseMirror.
  Scrolling, dragging, cancelling, or holding through the block long-press
  threshold does not follow the touched link; a completed short tap follows it
  once, even if the WebView also emits a synthetic click.
  Android already follows on the first tap (verified emulator 2026-07-08). Each pushed iOS
  editor needs an explicit `.id(noteId)` identity or SwiftUI would share one
  view's @State across the chain. Because the editor WebView is a single shared
  instance, iOS re-adopts it into whichever editor is visible on push/Back
  (`EditorContainerView.onEnterWindow`), and off-screen editors never drive it;
  Android composes only the top of the stack, so one note binds the WebView at
  a time by construction. Verified emulator + simulator 2026-07-08 (A → wikilink
  → B → Back returns to A with A's content intact and the editor still
  interactive; Back again returns to the list). →
  src/features/editor/milkdown/linkTaps.ts `handleTouchEnd`
  `activateLink`, AppNavigation.kt `AppNavigator.openNote` (push),
  NoteEditorView.swift `openLinkedNote` + EditorWebView.swift `Coordinator.adopt`,
  tests/editor-embed-milkdown-wikilinks.spec.ts
- Native Back and resolved-wikilink navigation wait for every admitted editor
  mutation, await the latest tagged document, and persist-or-park a dirty
  snapshot through the Rust draft workflow before changing the navigation
  stack. A concurrent peer edit therefore keeps both versions instead of being
  overwritten. A failed commit keeps the same editor visible and dirty and
  surfaces the save failure. This includes a valid pending title whose Rust
  rename fails and, on iOS, an admitted image insertion: navigation waits for
  the insertion's editor transaction and deferred bridge callback before
  committing. Android applies this to toolbar Back, system Back, and wikilinks;
  iOS uses its custom navigation Back and wikilinks. →
  `EditorNavigationCommit.kt`, `NoteEditorScreen.kt`,
  `EditorHost.awaitCurrent`, `EditorCompletionQueue`,
  `NoteEditorView.requestNavigation`
- **Renaming or moving a note rewrites every wikilink that points at it,
  across all notes** — including folder moves (`[[Markdown demo]]` →
  `[[Archive/Markdown demo]]`) and **self-referencing links inside the renamed
  note's own body** (a note linking to itself must not be left with a silently
  broken link after its own rename). → wikilinks.ts rewrite rules,
  notes.svelte.ts `rewriteWikilinksForRename`
- The relink rules also live in the shared Rust crate
  (futo-notes-model `wikilinks::{resolve_wikilink, shortest_unique_suffix,
rewrite_wikilinks}` + `relink_note_references`), conformance-locked
  bit-for-bit against wikilinks.ts (tests/conformance/wikilinks.json). The
  native shells call the single `NoteStore.rename` or `NoteStore.moveNote`
  workflow, which moves the note and rewrites backlinks vault-wide under the
  store's workflow lock (verified on emulator + simulator 2026-06-09:
  bare-leaf and full-path links in other notes rewrote on disk).
  `[[target|alias]]` links are not rewritten — the TS rules treat the whole
  inner text as the target, and the Rust port pins that behavior. →
  futo-notes-model wikilinks.rs, futo-notes-store `LocalNoteStore::rename`,
  futo-notes-ffi `NoteStore::{rename,move_note}`

## External links

- Tapping/clicking an external link (`http(s)://`, autolinks, bare URLs) opens
  it in the system browser, never inside the editor. On the native shells a tap
  is detected via a dedicated `touchend` path (mirroring wikilinks — a
  click-only handler dead-ends on iOS WebKit) and the resolved URL
  is posted to the host via the `openUrl` bridge message (bridge v6); the host
  opens it in the system browser (iOS `UIApplication.open`, Android
  `ACTION_VIEW`), scheme-guarded to `http/https/mailto/tel`. `window.open` is a
  no-op inside a WKWebView, which is why the bridge round-trip is required.
  Android additionally enforces in `EditorWebView.kt` that only `file://` editor
  assets may load in the reused WebView; all other schemes are intercepted and
  launched with `ACTION_VIEW`. iOS enforces the same policy in
  `EditorWebView.swift`'s `decidePolicyFor` (added 2026-07-30): main-frame loads
  are allowed only for the bundled `editor.html` itself (exact standardized-path
  match — any other `file://` URL is denied, since `loadFileURL` grants read
  access to the whole bundle resources directory) and the `about:blank`
  missing-bundle fallback; `http/https/mailto/tel` navigations are cancelled and
  routed through the same scheme-guarded external open as the `openUrl` bridge
  case; every other scheme (including `javascript:`/`data:`) is denied, so a
  programmatic top-level navigation can never replace the editor. Policy is a
  pure function (`editorNavigationDecision`) unit-tested in
  `EditorNavigationDecisionTests.swift`. Verified emulator + simulator
  2026-07-08 (tapping a rendered link opens Safari / Chrome to the target; iOS
  `openUrl` case and Android `ACTION_VIEW` intent both fire).
  Scrolling from a link or holding it for a block drag does not open it;
  separate rapid mouse clicks on links each open their URL.
  → platform/openExternalUrl.ts,
  src/features/editor/milkdown/linkTaps.ts `linkAt` / `activateLink`,
  editor-embed/main.ts, packages/editor bridge v6 `openUrl`,
  EditorWebView.swift `openUrl` case, EditorWebView.kt `openExternalUrl` /
  `shouldOverrideUrlLoading` / `isInAppEditorNavigation`,
  tests/editor-embed-milkdown.spec.ts

- Only the link's own glyphs open it: the hit is the anchor element under the
  pointer, so clicking the blank space past the end of a link — including a link
  that wraps onto several visual lines — places the caret instead of opening the
  URL. → src/features/editor/milkdown/linkTaps.ts `linkAt`

- Typing a bare URL links it the moment its word ends — Space or Enter — with
  exactly the extent and href reopening the note would give
  it (GFM's autolink literal: trailing punctuation left out, `http://` added
  for `www.`), because the word is read by the editor's own markdown parser.
  A URL inside inline code or a code block stays text. The note keeps the URL
  as typed: a bare URL is saved bare, not as `<url>` or `[www.…](http://…)`,
  and editing a note leaves the bare URLs already in it bare, unless a bare
  spelling would not read back as the same link. →
  src/features/editor/milkdown/autolink.ts,
  packages/editor/src/markdown/inline.ts,
  tests/editor-embed-milkdown-parity.spec.ts

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
  own `exitTable` binding). → src/features/editor/milkdown/keyboardParity.ts
  `insertTableRowBelow` / `appendTableRowFromLastCell`,
  tests/editor-embed-milkdown-interactive.spec.ts
- Shift+Enter with the caret in a table cell inserts a line break in that
  cell, rather than a no-op — the preset's own hardbreak handling silently
  rejects any break inside a table, which used to fuse whatever was typed next
  straight onto the preceding text with no separator at all (`r1a`,
  Shift+Enter, `second` saved as `r1asecond`). The break saves as a literal
  `<br>` inside the cell (GFM's own way to write a multi-line cell — a real
  newline would corrupt the row) and parses back into the same break on
  reopen. → src/features/editor/milkdown/keyboardParity.ts
  `insertLineBreakInTableCell`,
  src/features/editor/milkdown/table/tableLineBreak.ts (reading the `<br>` back),
  src/features/editor/milkdown/table/tableLineBreak.test.ts

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
- Undoing an edit that renumbered a list reverses the edit and the renumbering
  together, as one step: the renumber rides in as an `appendTransaction` that is
  not itself recorded in history. → `@milkdown/preset-commonmark`
  `syncListOrderPlugin`
- Renumbering follows an edit, so the FILE's numbering is left exactly as
  written until you type in it — a hand-numbered `1. / 1. / 1.` list stays that
  way on disk. → milkdown/hostHandle.ts `getContent`

- Text that reaches the open note from outside it — a sync pull landing while
  you read, a host push of the note on screen — replaces the document and is not
  reported back to the host as a change of yours, so a peer's version is not
  echoed straight back over theirs. → milkdown/hostHandle.ts `setContent` /
  milkdown/documentLoad.ts `applyExternal`,
  editor-embed/createFutoEditorApi.ts `applyExternalContent`

- Undo only ever reverses edits made in the note on screen — never text from
  another note — and opening a note is not itself something undo can reverse:
  the host clears the stack on every open, and a progressively streamed note's
  chunk appends are not undoable. → milkdown/hostHandle.ts `resetHistory`,
  src/features/editor/milkdown/progressiveLoad.ts,
  tests/editor-embed-milkdown.spec.ts "Undo history"
- Opening a note starts its undo empty. Leaving a note and coming back does not
  restore what you could undo before.

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
  the keyboard shortcuts in [tabs.md](tabs.md) "Keyboard shortcuts". →
  `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`,
  src/features/editor/milkdown/wikilink/inputRule.ts

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

## Markdown toolbar _(native shells / editor-embed fallback)_

The shipping toolbar surface belongs to the native shells. The Tauri desktop
shell uses the floating selection toolbar described above. The standalone editor
embed retains a web toolbar as a bridge
fallback, but iOS and Android call `setNativeToolbar(true)` and render native
toolbar chrome instead. → src/editor-embed/EmbedToolbar.svelte,
EditorWebView.swift, EditorWebView.kt

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
  inside the WebView — never a native SwiftUI/Compose dialog. With a
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
  swallowing it. → src/features/editor/milkdown/blockCommands.ts,
  tests/editor-embed-milkdown-toolbar.spec.ts
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
- Native shells, toolbar chrome is NATIVE, commands are shared (bridge v3):
  the host renders its own toolbar from a GENERATED copy of the manifest and
  drives the editor over the bridge — `exec(id)` runs the shared command,
  the `cursorContext` and `formatState` messages drive Indent/Outdent visibility,
  `blur()`
  backs the dismiss chevron, and `setNativeToolbar(true)` suppresses the
  embed's web toolbar so two never show. `just toolbar-spec` regenerates the
  native specs; `just toolbar-spec-check` (part of `just check`) fails when
  one drifts from the manifest. → packages/editor/src/bridge.ts,
  scripts/gen-toolbar-spec.ts, tests/editor-embed-milkdown-toolbar.spec.ts
- iOS native: the toolbar is the keyboard's `inputAccessoryView` (generated
  ToolbarSpec.swift rendered by EditorToolbar.swift), replacing the stripped
  prev/next/Done bar — the system owns docking/animation with the keyboard.
  Original controls verified end-to-end on the iOS simulator 2026-06-10 (exec
  commands mutate the doc and autosave; Indent/Outdent appear inside a list or
  quote; pickers open natively; chevron blurs). → EditorToolbar.swift,
  EditorWebView.swift `futo_overrideInputAccessoryView`
- The toolbar band behind the buttons is the EDITOR's own background colour, so
  the bar reads as the bottom edge of the note rather than a strip pasted onto
  the keyboard. Nothing between the note and the band shows a colour step, in
  light or dark. _(native shells)_
- iOS native: the accessory is a `UIInputView` (`inputViewStyle` `.default`)
  painted `Theme.background`, and the buttons float on it in Liquid Glass
  capsules (`glassEffect` on iOS 26+, `.regularMaterial` below), one for the
  scrolling formatting items and one for the dismiss chevron, with no hairline
  behind the band. The system's `.keyboard` backdrop, used until 2026-09-23, is a
  translucent material that came out a near miss of the editor colour right
  where the two meet, a difference a user saw on a device. `Theme.surface`
  (#F2F2F2/#171717) before that was a visible slab. Apple's own accessory in
  Safari matches the PAGE behind it (242,242,247 on the iOS 26.5 simulator,
  2026-08-26), not the keyboard slab (223,224,230). → EditorToolbar.swift
  `FutoKeyboardAccessory`, `ToolbarMetrics`, `futoToolbarGlass`

- Android native: the bar and both of its edge fades paint `c.surface`, and so
  does the editor screen's `Scaffold`, which is what shows through the
  transparent editor page. The note and the band are therefore one colour by
  construction: #FFFFFF in light and #1F1C19 in dark, sampled on the pixels
  either side of the bar's top edge. A 1 dp `c.border` hairline marks that edge,
  where iOS deliberately draws none. Verified on the emulator (API 36)
  2026-09-23. → EditorToolbar.kt, NoteEditorScreen.kt `Scaffold`
  `containerColor`
- Android native: the toolbar is a Compose bar (generated ToolbarSpec.kt
  rendered by EditorToolbar.kt) docked above the soft keyboard via the editor
  screen's `imePadding`, shown only while the editor is focused (bridge
  `focus` message). Original controls verified end-to-end on the emulator
  2026-06-10 (exec commands mutate the doc and autosave; Indent/Outdent
  appear inside a list or quote; pickers open natively; chevron blurs,
  dropping keyboard + toolbar). → EditorToolbar.kt, NoteEditorScreen.kt,
  EditorWebView.kt `EditorHost`
- Native shells: the `cursorContext` bridge message carries `inContainer` —
  the caret is in a list item OR a blockquote — alongside the list-only
  `onListLine`, so Indent/Outdent show on BOTH native toolbars for a caret
  sitting in an existing blockquote, not only a list line. A host that has
  never seen the field (an older bundle) falls back to `onListLine`, the
  pre-fix behavior. → packages/editor/src/bridge.ts `CursorContextMessage`,
  MilkdownEditor.svelte `emitCursorContext`, EditorToolbar.swift,
  EditorToolbar.kt
- Android native: dismissing the soft keyboard by the system back
  gesture/button (not just the chevron) also blurs the editor — the caret
  and selection handle must not linger on screen with no keyboard (#24).
  The app-root `ClearFocusOnImeDismiss` ([app.md](app.md) "Soft keyboard")
  drops native-field focus, and its root install also blurs the editor over
  the bridge on the same IME visible→hidden transition — the editor's DOM
  caret survives a view-level clearFocus. (iOS can't hit this: keyboard and
  first-responder caret are coupled.) → MainActivity.kt,
  ui/components/ImeDismiss.kt, EditorImeDismissBlurTest.kt
- Dismissing the keyboard ends the editing session on the page, not only the
  keyboard: no caret, no highlighted text range, no cell selection, no
  selection handles, and no table row/column grips left where a tap put them.
  A bare DOM blur kept all of those. A selection survives a blur, and so do its
  decorations and handles. The grips come from the emulated mouse events a tap
  sends, and a tap never sends the `mouseleave` that would hide them. So the
  bridge `blur()` collapses the selection to its head, hides the grips, then
  blurs and clears the DOM selection. Every native dismissal goes through it:
  the chevron on both shells and Android's back-gesture dismissal. Desktop never
  calls it. On Android both dismissal paths clear a double-tapped word range
  (handles and callout included), the grips a tap showed, and the cell selection
  a grip menu leaves behind; tapping back in edits normally and brings the grips
  back. A touch drag across cells makes no cell selection on Android (Chromium
  sends a touch drag no mouse drag), so the grip menu is the touch route to one.
  Verified on the emulator (API 36, System WebView 133.0.6943.137) 2026-09-23.
  _(native shells)_ → src/features/editor/milkdown/hostHandle.ts
  `blur`, src/features/editor/milkdown/table/tableGrips.ts `hideTableGrips`,
  tests/editor-embed-milkdown.spec.ts "blur() drops a highlighted range",
  tests/editor-embed-milkdown-table-grips.spec.ts "the bridge blur ends the
  table editing session"
- **Toolbar docking + height (both native shells).** The bar is exactly
  **44 pt** tall on iOS / **44 dp** on Android, its 36 pt/dp icons centered
  with ~4 pt top/bottom, and it sits **FLUSH against the top of the on-screen
  keyboard**: there is NO empty band between the toolbar icons and the
  keyboard's first row. Verified on the iOS simulator with the soft keyboard
  up 2026-06-18.
  - iOS is fragile here: as a keyboard `inputAccessoryView` hosted in a
    `UIHostingController`, the default behavior feeds the keyboard window's
    bottom safe-area (home-indicator, ~34 pt) inset into the hosted SwiftUI
    content, which pushes the icons up and opens a dead band below them. The
    flush dock is held by `ToolbarMetrics.barHeight` (single source for the
    44 pt across the SwiftUI frame, the container frame, and
    `intrinsicContentSize`) plus `UIHostingController.safeAreaRegions = []`.
    Do not remove the `safeAreaRegions` line, and re-check the simulator with
    the keyboard up after touching the accessory. This gap regressed in
    7c43a8e (web `visualViewport`-docked toolbar → native bar) and was
    re-closed 2026-06-18. → EditorToolbar.swift `ToolbarMetrics`,
    `EditorToolbarAccessory`
  - Android docks flush by construction: the 44 dp Compose bar is held above
    the keyboard by the screen's `imePadding`, so the inset tracks the
    keyboard with no gap. → EditorToolbar.kt, NoteEditorScreen.kt
- **Scroll affordance — "snapped peek" (both native shells).** When the items
  overflow, the trailing edge does NOT cut cleanly (which read as "nothing more
  here"): the bar measures the laid-out button positions + the viewport width
  and adds a trailing inset that clips whichever icon sits at the edge to ~55%,
  so a partial icon always peeks past the edge — the deterministic, same-on-
  every-width/density signal that the bar scrolls. A soft ~10 pt edge fade
  softens the clipped icon (and the leading edge once scrolled). Verified on the
  iOS simulator (iPhone 17 Pro 402 pt + Pro Max 440 pt) and the Android emulator
  2026-06-30 — a different edge icon is clipped per width, always to ~half. iOS
  measures the outer slot independently of scroll offset; Android from
  `onGloballyPositioned` (`positionInWindow`) + a measure-tick. → EditorToolbar.swift
  `computeSnap`, EditorToolbar.kt `computeToolbarSnapPx`
- _(iOS)_ Scrolling or bouncing at either toolbar edge never changes its viewport
  width; the peek inset follows only the outer slot, button layout, and display
  scale. Edge fades animate independently, preserving native scroll bounce. →
  EditorToolbar.swift, EditorToolbarLayoutTests.swift
- Camera inserts a photo from the device camera or photo library; Image opens
  a file picker. Both save the image into the vault and insert `![](file)`.
  On the native shells the toolbar's Camera/Image buttons reach the host
  picker (web toolbar posts `pickImage`; the native iOS/Android toolbars
  invoke it directly), which presents the native picker (Photo Picker / camera intent
  on Android; PHPicker on iOS, camera falling back to the library on the
  simulator), saves the bytes into the vault root under a generated
  space-free name, and calls `insertImage` back into the embed.

## Find in note

Find-in-note locates text inside the OPEN note — match highlighting plus
next/previous stepping — as opposed to cross-note search ([search.md](search.md)),
which retrieves whole notes from the vault index. The two surfaces are
independent: this one is opened by its own affordance and seeded only from the
editor's own selection or the previous query, and cross-note search is
unchanged by it.

- **One engine, thin platform bars.** All find behavior — matching, highlight
  decorations, current-match tracking, next/previous stepping with wrap, and
  count arithmetic and count wording — lives in the shared
  editor bundle. Desktop renders that engine's full-width bottom panel.
  iOS and Android render native SwiftUI/Compose bars because the web panel is
  not native-quality mobile chrome; those bars only forward
  query/open/step/close actions and render the bundle's
  `{query, current, total, label}` report verbatim. They never scan text,
  compute a count, or decide a wrap. Matching is a run scan over the ProseMirror
  document: every maximal run of ADJACENT text, so a query spanning a mark
  boundary (`**bo**ld`) matches while one spanning a paragraph boundary cannot.
  Highlighting is a ProseMirror `DecorationSet` covering the whole document — it
  maps through a transaction instead of being rebuilt, so a keystroke costs a map
  and never a scan. → src/features/editor/milkdown/find/
- Native chrome drives the engine through the bridge-v8 `openFind`,
  `setFindQuery`, `stepFind`, and `closeFind` methods and receives `findMatches`
  reports. Find is NOT an `exec` command or a button in the scrollable formatting
  toolbar: that toolbar stays formatting-only, so the toolbar manifest
  (packages/editor/src/toolbar.ts) and its generated native specs are untouched.
  The overflow menu is the only mobile entry point.
- _(desktop)_ Ctrl/Cmd+F opens the find bar for the active tab's note, query
  field autofocused — pre-filled with the editor's selection when one exists,
  otherwise with the previous query, selected either way. Ctrl/Cmd+F with the
  bar already open refocuses and selects the query. A Home tab has no
  document, so it does nothing there. The accelerator is recorded in tabs.md's
  shortcut list. → registerNotesShellShortcuts.ts
- _(iOS/Android)_ "Find in note" is an entry in the editor screen's existing
  overflow menu (Android's ⋮ DropdownMenu, iOS's ellipsis-circle Menu), so it
  is reachable while reading with the keyboard down. The item shows the native
  bar and calls the shared engine's `openFind` bridge method. →
  NoteEditorScreen.kt actions, NoteEditorView.swift toolbar Menu
- The desktop bar spans the bottom of the editor, like Firefox's find bar. On
  iOS and Android it spans the bottom of the editor viewport, immediately above
  the virtual keyboard while the query field is focused. The bar shows: the
  query field, a live match count ("3 of 17"; "0" at zero), next and previous
  buttons, and a completion control. Android uses a single flat, divided bar in
  the platform browser style: query, count, previous, next, then close; its count
  turns red and its step buttons disable at zero matches; the desktop bar does
  the same. iOS uses a leading
  checkmark to close, a search capsule with its count inline, and a separate
  previous/next capsule; desktop keeps its compact full-width panel.
- Matching is **case-insensitive literal substring** — no case toggle, no
  whole-word, no regex in v1 (the simplest behavior meeting #26; toggles can
  join the same bar later without breaking anything here). Literal means find
  has none of cross-note search's retrieval semantics: no fuzzy, no
  prefix/mid-typing rule, no all-words preference — `cat` finds `concatenate`,
  and `Aug ` (trailing space) finds only `Aug` followed by a space.
- **Matching runs over the editor's document text.** Results never depend on
  cursor position or on what is scrolled into view, and every match is a real
  range the selection (and any future replace) operates on.
- A line break inside a paragraph reads as a space, so a match runs across it
  exactly as across a soft wrap: `man yes` finds `hey man` / `yes` on two lines.
  A match never runs across two blocks. → find/findMatches.ts `docTextSegments`,
  tests/editor-embed-milkdown-find.spec.ts

- Find searches the note **body** only. The title is the filename — a native
  field on the native shells, not part of the document text — and titles are
  cross-note search's job (search.md indexes them).
- Every match is highlighted; the current match is visually distinct from the
  rest and is scrolled into view when stepped to.
- A find bar that overlays the editor viewport keeps the scrolled-to current
  match clear of the strip it covers — so "scrolled into view" means visibly on
  screen, never under the bar. One engine rule, two ways of learning the
  height: _(iOS)_ the bar overlays the WebView's bottom edge and declares its
  rendered height to the engine; _(desktop)_ the bar is docked over the bottom
  of the editor's own scrolling pane, so the engine measures that panel itself
  and the shell declares nothing; _(Android)_ the bar is a layout sibling above
  the WebView, so the viewport is never covered and no inset is declared.
  → setFindOverlayInset, findPlugin.ts `revealMatch`, NoteEditorView.swift,
  NoteEditorScreen.kt
- Revealing a match inside hidden markdown moves it after the scroll: the
  source appears, the line reflows, and the match can land back under the bar.
  The engine re-measures the current match once that relayout settles and
  re-reveals it, so a match ends up visible wherever the reflow put it.
  → find/findPlugin.ts `revealMatch`
- _(desktop)_ the selection toolbar does not show for find's own selections:
  it stays down while the bar is open, and for the selection find leaves
  behind after Escape; the next selection the user makes shows it normally.
  → find/findPlugin.ts `findSuppressesSelectionToolbar`,
  selectionToolbar/target.ts
- **Stepping to the next occurrence** is the core interaction, and it is
  reachable three ways while the bar is open: the next/previous buttons in the
  bar (the mobile path — they work with the keyboard down), Enter / Shift+Enter
  while the query field is focused, and _(desktop)_ Ctrl/Cmd+G /
  Ctrl/Cmd+Shift+G, which step next/previous no matter where focus sits **while
  the bar is open** — so after clicking into the editor body you can keep
  jumping through occurrences and typing at the one you wanted. (Escape closes
  the bar, and a closed bar makes both accelerators no-ops; see below.) Each step moves the selection
  to that match, makes it the current match, and scrolls it into view.
  Stepping wraps past either end (the count shows the wrapped position; there
  is no separate wrap indicator), and with zero matches every step is a no-op.
  Ctrl/Cmd+G with the bar closed does nothing — it never reopens find. Both G
  accelerators are recorded in tabs.md's shortcut list. →
  registerNotesShellShortcuts.ts
- Editing while the bar is open keeps it open: matches, highlights, and the
  count recompute against the new text. Apart from the two stepping
  accelerators above, find claims no keys in the note body — Enter,
  Shift+Enter and Escape belong to find only while the query field is focused,
  so typing in the body behaves exactly as it does without find.
  Recomputation never adds to keystroke latency (M5): a keystroke only MAPS the
  matches and decorations it already has through its own transaction, the rescan
  runs one animation frame later, and the count may therefore lag an edit by a
  frame.
- Find state is per open note view: the query and current match survive while
  the note stays on screen — including device rotation on the native shells
  (Android saves the bar's query/visibility and the retained WebView keeps the
  engine state; the OS may drop the soft keyboard) — and closing the bar,
  switching desktop tabs, or leaving the note clears active highlights. A
  closed bar may remember its previous query for the next open on the same note;
  no find state crosses a note boundary or persists in `.app-config.json`.
- _(desktop)_ Escape closes the bar and returns focus to the editor with the
  selection left on the current match.
- _(Android)_ System Back with the bar open dismisses the bar, not the screen:
  that Back is consumed by find. → NoteEditorScreen.kt `findBackAction`

- _(Android)_ Closing the bar takes the soft keyboard down with it whenever the
  bar's own query field owned the keyboard, so the next Back leaves the note.
  The field is a native `EditText`, and Android leaves the IME shown when the
  view serving it is removed: a keyboard left bound to the departed field
  swallows the next Back instead (measured before the fix: `mInputShown=true`
  with the bare `AndroidComposeView` served, and leaving the note took a second
  Back). Dismissal does NOT hand focus back to the editor body — the WebView
  stays unfocused until the user taps into it. When the body owns the keyboard
  instead (the user tapped into the note while the bar was open) it stays up,
  and standard Android applies: a Back drops the keyboard before a Back leaves
  the note. → NoteEditorScreen.kt `dismissFind`
- _(iOS)_ the X closes the bar; the editor's exit chrome (back chevron / edge
  swipe) exits the note as usual, taking the bar with the screen.
- _(iOS/Android)_ Closing the find bar clears every match highlight and restores
  the editor selection and viewport from before find opened.
- _(iOS/Android)_ the soft keyboard can never cover the bar: it is docked
  immediately above the keyboard by the shell's keyboard-safe layout.
  While the native find query field is focused the WebView is unfocused, so the
  formatting toolbar does not show — that toolbar is editor-body-focus chrome
  (## Markdown toolbar), and the two bars never stack.
- **Hand-off from cross-note search is out of scope.** Opening a note from a
  search result (desktop popup, Android SearchScreen, iOS inline list search)
  opens the note exactly as it does today: at its normal position, with no
  find bar and no seeded query. Seeding find from a retrieval query would need
  the query carried to the note-open path on all three platforms — on the
  native shells that is a hostBoot/bridge change (stop-and-ask, root AGENTS.md
  §11.6) — and retrieval semantics are broader than literal find (fuzzy,
  prefix, all-words), so a retrieval hit does not imply a literal occurrence to
  land on. Nothing here forecloses it; the find surface is self-contained and a
  seed can be added later.
- Replace is **out of scope** for this surface: #26 asks for finding, the
  engineering default is the simplest implementation that meets the current
  requirement, and replacing inside markup the live preview hides invites
  invisible markdown corruption without dedicated UX. The shared
  `@codemirror/search` core supports layering replace onto the same bar later
  if it is ever asked for.

## Images

- Pasting an image into the editor (desktop) saves it to the notes directory
  and inserts `![](filename)`; supported types follow
  `@futo-notes/editor` `IMAGE_EXTENSIONS`, conformance-locked to the canonical
  Rust vault rule. Native Swift/Kotlin pickers receive that Rust list through
  generated UniFFI bindings. Both clipboard shapes work: a raw
  bitmap (OS screenshot-to-clipboard) and a browser **Copy Image** (which the
  source app puts on the clipboard as an `<img>` `text/html` fragment plus a
  bitmap). When the paste event exposes an image file its bytes are saved by
  `fs_save_image`; otherwise the bitmap is read from the OS clipboard via the
  `fs_paste_clipboard_image` Tauri command. This native fallback is required on
  Linux/Wayland, where WebKitGTK hides the clipboard image from the JS paste
  event — a screenshot arrives with empty `items`, and a Copy Image arrives as
  a lone `text/html` item — so the gate is "no image file found and no
  `text/plain` to paste" (plain/rich-text pastes are left untouched).
  Verified on Linux (WebKitGTK) and Windows (WebView2), both image types,
  2026-06-22. → imagePaste.ts `handlePasteEvent` / `looksLikeImagePaste` /
  `pasteFromNativeClipboard`;
  `apps/tauri/src-tauri/src/image_commands.rs` `fs_save_image` /
  `fs_paste_clipboard_image`
- Images render inline via the Tauri asset protocol, with a
  `readFile`→blob-URL fallback when the asset protocol can't actually decode an
  `<img>` (macOS WKWebView / Linux WebKitGTK answer the request but paint a
  blank white box; the gate is a real image-decode probe, not a HEAD probe).
  → `src/lib/platform/tauri/images.ts` `getImageUrl` / `canDecodeImageUrl`.
  _(Tauri)_
- The native shells render local images inline through a host-registered
  image base URL (`setImageBaseUrl`): iOS serves the vault root through a
  `futo-asset://` WKURLSchemeHandler (path-traversal- and image-extension-
  guarded); Android serves `file://<vault root>/` directly. Insert path is
  the toolbar Camera/Image flow above; picked images save into the vault and
  render inline (verified end-to-end on emulator + simulator 2026-06-09).
  → EditorImages.swift `FutoAssetSchemeHandler`, ImagePicker.kt,
  packages/editor/src/hostBoot.ts `setImageBaseUrl`,
  src/features/images/vaultImageSrc.ts, tests/editor-embed-milkdown.spec.ts
- Inline image rendering depends on the referenced file existing in the vault.
  That file is delivered across devices by sync — the image binary syncs
  alongside its note, so `![](image-…)` resolves on every device, not just the
  one that created it. → [sync.md](sync.md) "Embedded images sync with their
  notes"
- The native shells ALSO support clipboard image paste. The native WebView has
  no `saveImageBytes` (that's a Tauri-desktop FS method), so the embed reads the
  pasted image bytes and hands them to the host via the `saveImageData` bridge
  message (base64 + extension); the host decodes and saves them into the vault
  through the SAME path as the Camera/Image picker, then calls
  `insertImage(filename)` — so a pasted image is indistinguishable from a picked
  one (`![](image-…ext)`, stored as a vault blob, no inline base64). Verified
  end-to-end on the Android emulator 2026-06-22. When the WebView hides the
  bitmap from the JS paste event (no File — WKWebView/WebKitGTK), the embed
  instead posts the payload-less `pasteClipboardImage` message (bridge contract
  v5) and the host reads the image off the native clipboard. Android ALSO takes
  this fallback for a THIRD clipboard shape (QA #006, 2026-09-11): copying an
  image out of Photos/Files/Gallery/Drive (or a browser's "Copy image") puts a
  `content://` URI on Android's clipboard as `text/plain`, not a `File` —
  `classifyImagePaste` recognizes that scheme and claims it as a hidden bitmap,
  and `EditorWebView.kt` reads the URI off the real `ClipboardManager` and
  copies it into the vault through the SAME `saveImageIntoVault` the picker
  uses. Verified end-to-end on a real Android emulator (API 36, 2026-09-11):
  copied a PNG via Chrome's "Copy image", pasted into a note, and the vault
  gained a byte-identical `image-…png` with `![](…)` inserted at the caret. →
  src/features/editor/imagePasteSink.ts, bridge.ts `SaveImageDataMessage` /
  `PasteClipboardImageMessage` (contract v5), EditorWebView.kt + ImagePicker.kt
  `saveImageDataIntoVault` / `clipboardImageUri` / `saveImageIntoVault`
  (Android), EditorWebView.swift `saveImageData` +
  `clipboardImageData` + EditorImages.swift `VaultImages.save` (iOS),
  fs_paste_clipboard_image (Tauri), tests/editor-embed-milkdown.spec.ts
- A vault image is a ProseMirror node whose rendered
  `<img src>` is resolved for display only; the node's own `src` — what gets
  serialized — stays the bare vault reference the note holds. Opening a note
  with an image therefore leaves the file byte-identical, and an edit elsewhere
  in the note still writes `![](image-…ext)`, never the shell's `futo-asset://`
  or `asset://` URL. → milkdown/vaultImageView.ts, features/images/
  vaultImageSrc.ts, tests/editor-embed-milkdown.spec.ts
- A vault image whose URL cannot be resolved yet renders as nothing rather than
  a broken-image glyph, and resolves itself as soon as the URL arrives — the
  host may call `setImageBaseUrl` after `setContent`, and a per-file resolution
  is asynchronous, neither of which is accompanied by a document change.
  → milkdown/vaultImageView.ts, features/images/vaultImageSrc.ts
  `onVaultImageSrcChange`
- The two hosts resolve a vault image two different ways, and the editor
  asks per image RENDERED rather than scanning the document, so a large note
  only pays for the images someone looks at (M5). The native shells serve the
  whole vault off one host-registered base URL and need nothing per file
  _(native shells)_; Tauri desktop has no base URL and resolves each file
  through `PlatformFS.getImageUrl`, which the editor installs at mount as the
  per-file resolver _(desktop)_. A file that will not resolve — it has not
  synced in yet — is retried by a later render rather than remembered as
  failed. → features/images/vaultImageUrlResolver.ts, features/images/
  vaultImageSrc.ts `requestVaultImageUrl`
- **Desktop has three ways to add an image, and all three end in the same
  place**: the bytes land in the vault root under a generated space-free name
  and `![](image-…ext)` goes into the note at the caret. _(desktop)_
  1. **Paste** — the clipboard path above.
  2. **`/image`** — the `/` block menu's Image item opens the OS file picker
     (`PlatformFS.pickImage`), copies the chosen file into the vault
     (`saveImage` → `fs_save_image`) and inserts the reference. The pick is
     asynchronous while the menu's exec map is not, so the typed `/image` run is
     deleted immediately and the reference lands whenever the file is chosen.
     The item is offered on every host the menu is (desktop only); where there
     is no picker it is inert rather than hidden, and inserts nothing.
  3. **Drag and drop** — dropping image files from the OS onto the editor
     inserts them at the drop point, or at the caret when the point resolves to
     no text position. Several images at once are inserted in the order dropped,
     and one that fails to save does not abort the rest.
     → src/features/editor/imageInsert.ts, milkdown/slash/items.ts + exec.ts,
     src/lib/platform/tauri/images.ts `pickImage`, tests/image-drop.spec.ts,
     tests/slash-menu.spec.ts
- **A file drop reaches the app as an ordinary HTML5 `drop`, but the SHAPE it
  carries is engine-dependent.** All three desktop build configs (macOS,
  Windows, and Linux since QA #017, 2026-09-11) set `dragDropEnabled: false`,
  which stops wry installing a native drop target, so the drop arrives in the
  page and ProseMirror's `handleDrop` prop reads it directly. Linux used to
  leave the flag at its default, reasoning that the same native layer was
  needed to leave the sidebar's internal drags alone; that GTK relay's own
  external file-URI handling turned out to never fire the `drag-drop` signal
  at all on a native-Wayland compositor (confirmed Hyprland/wlroots — matches
  upstream tauri-apps/tauri#11282, tauri-apps/wry#1256), so a file dragged in
  from a file manager silently did nothing in a packaged build — invisible
  from `just tauri-dev`, which has always forced the flag off. Chromium
  (macOS/Windows) populates `dataTransfer.files` with the bytes already read.
  WebKitGTK (Linux) does NOT populate `files` for an OS file drop at all, and
  a real capture off a packaged Fedora/Hyprland build (2026-09-15) showed its
  payload is NOT where RFC 2483 says it should be either: WebKitGTK
  ADVERTISES `text/uri-list` in `dataTransfer.types`, but `getData` on it
  always returns an empty string — the dropped path lives only in the
  sibling `text/html` flavour, as an `<a>` element whose TEXT CONTENT is the
  `file://` URI, with no `href` attribute at all. Internal sidebar/tab
  dragging is untouched either way (pure in-page HTML5 DnD that wry's signal
  handlers never intercepted, and never advertises `text/uri-list`). Tauri's
  own drag-drop event (`PlatformFS.onFileDrop`, paths only, no bytes) stays
  wired as a defensive fallback for a distro/compositor combination that
  still runs wry's native layer, but nothing is currently expected to deliver
  that shape.
  _(desktop)_ → apps/tauri/src-tauri/tauri.linux.conf.json,
  src/lib/platform/tauri/fileDrop.ts,
  src/lib/platform/dragDropConfig.test.ts,
  src/features/editor/imageInsert.ts `filePathsFromDrop`,
  milkdown/MilkdownEditor.svelte `dropHandler`

- **A drop carrying files, or one advertising `text/uri-list` with none, is
  always claimed, image or not.** The browser's default for an unclaimed file
  drop is to navigate the webview to that file, which would tear the running
  app down mid-edit — so a dropped `.md`, PDF or archive is swallowed and
  ignored rather than inserted, and never becomes an `![](…)`. A drop
  carrying neither shape is left entirely alone, which is what the editor's
  own block drag rides on: it sets `text/html` + `text/plain`, never
  `text/uri-list`. _(desktop)_
  → src/features/editor/imageInsert.ts `dropCarriesFiles` / `imageFilesIn` /
  `filePathsFromDrop` / `imagePathsIn`, tests/image-drop.spec.ts
- Which dropped or picked files count as images is `isImageFilename` — the same
  `IMAGE_EXTENSIONS` list paste uses, conformance-locked to the canonical Rust
  vault rule, never a second list. A file's own extension decides the name it is
  stored under, falling back to its MIME type when it carries no image
  extension. → packages/editor/src/images.ts,
  src/features/editor/imageInsert.ts `imageExtensionFor`

  Verified on the real Linux desktop app (Fedora 44, WebKitGTK, dev build,
  2026-09-03): a pasted PNG landed in the vault as a valid 1×1 PNG with
  `![](image-…png)` in the note; the `/` menu offered 12 items and `/image`
  filtered to Image; `fs_save_image` copied a real path in and refused a `.md`
  at the Rust layer; and a `tauri://drag-drop` carrying an image path inserted
  it at the drop point, while the same event carrying a `.md`, or carrying an
  image dropped outside the editor's box, left the note untouched. Not yet
  exercised by a genuine human OS drag on any platform, nor the native file
  chooser opening (`dialog:allow-open` is granted and the command reaches
  argument parsing, so the permission half is proven).

- Clipboard image paste claims the paste through
  ProseMirror's `handlePaste` and captures it through the sink for the host it
  is running in: the `saveImageData` / `pasteClipboardImage` bridge messages on
  the native shells (the host writes the file and calls `insertImage` back), or
  `PlatformFS` on Tauri desktop. `classifyImagePaste` decides which pastes count
  as an image, and a claimed image paste never also lands as pasted content. A
  paste carrying plain text is left to the editor. →
  src/features/editor/imagePasteSink.ts, imagePaste.ts `classifyImagePaste`,
  tests/editor-embed-milkdown.spec.ts
- An image destination containing a space needs its CommonMark spelling
  (`![](<my photo.png>)`); the bare `![](my photo.png)`
  is not an image in CommonMark and renders as text. Every filename the app
  itself generates is space-free, so this only reaches notes written elsewhere.
  → `image_commands::write_image`, tests/editor-embed-milkdown.spec.ts

  Verified on a real Android device (moto g play 2023, WebView 140) and the iOS
  26.5 simulator, 2026-08-28: a vault-relative image renders and decodes, and
  opening the note leaves it byte-identical on disk. Android also verified
  end-to-end for paste — the host wrote the file and `insertImage` put
  `![](image-…png)` in the note.

- iOS clipboard image paste is covered at the bundle seam and, for the shared
  decision and bridge sink, end-to-end against the real Android host.

- **A delayed image completion belongs to the note it was started on** — the
  same rule as the native attachment generation below, stated once for the
  shared editor, which is a SINGLE component reused across every note. Drop,
  `/image` pick and clipboard paste each claim the live document BEFORE their
  first `await`; one claim covers a whole multi-image batch. When the editor
  has adopted another note (or been torn down) by the time the bytes land,
  nothing is inserted anywhere — never into the note now on screen — and the
  image file that insertion just created is deleted from the vault, so an
  abandoned drop leaves no blob nothing points at. Silent: there is no
  message, because the note the user is looking at is correct and untouched.
  _(desktop)_ → src/features/editor/imageInsertTarget.ts, imageInsert.ts,
  imagePasteSink.ts, milkdown/documentSession.svelte.ts `documentIdentity`,
  milkdown/imageInsertIdentity.test.ts
- A delayed native picker/clipboard completion belongs to the editor attachment
  generation that started it. Detaching, deleting, or adopting another note
  invalidates the completion, so it cannot insert Markdown into a different
  note. Android holds both the editor mutation permit and vault gate through
  confirmed WebView insertion, and cancellation cannot leave a queued main-
  thread insertion behind; iOS checks the adopted WebView generation before
  and after inserting, increments that generation on detach, queues every image
  completion, and drains the queue through the editor's next animation frame
  before a navigation commit. It removes a just-saved image when its attachment
  became stale before insertion. →
  `EditorAttachmentGate.kt`, `EditorWebView.insertImageAndWait`,
  `EditorHost.detach`, `EditorCompletionQueue`, `VaultImages.remove`

## Code / fence isolation

- Wikilinks and tags inside inline code or fenced blocks are NOT decorated and
  NOT extracted. → src/features/editor/milkdown/tagDecorations.ts,
  src/features/editor/milkdown/wikilink/inputRule.ts,
  tests/editor-embed-milkdown.spec.ts

## Performance

- Typing is sacred (M5): per-keystroke editor work must not scale with document
  size. The budget is a **16 ms p95 synchronous keystroke at every note size**,
  and it is enforced two ways — the desktop performance floor in the editor
  gauntlet, and the same stories against the real native Android app on the
  low-end reference phone. → tests/editor-gauntlet/performanceFloor.ts
  `PERFORMANCE_BUDGET`, tests/editor-gauntlet/milkdown-performance-floor.spec.ts,
  tests/android-editor-perf.mjs, `just gauntlet-milkdown-perf`,
  `just test-android-perf`
- Opening a note is budgeted at **under 1 s at the sizes real notes reach**, and
  above them cost must scale LINEARLY — no cliff. The floor holds a fixture's
  per-unit open cost to within 2.5x of its smaller reference, which catches a
  scaling wall rather than policing constant factors. →
  tests/editor-gauntlet/performanceFloor.ts
- The debounced `change` notification and `getContent()` serialize the note per
  top-level block, cached on ProseMirror node identity, so a settled edit costs
  the blocks it touched rather than the whole note; the bytes are identical to
  the serializer writing the whole document, which is also what `getMarkdown()`
  and a copy's plain text use (`just chunk-census --serialize`). A document
  whose cache is still cold primes it in idle slices and reports the change
  once primed, instead of serializing the whole note on the main thread. →
  packages/editor/src/markdown/cache.ts,
  milkdown/serializationLoop.ts `createDocumentSerializer`/`readSerialized`
- A note of 400 lines or more is opened PROGRESSIVELY: the first ~80 lines are
  parsed and mounted synchronously so the first viewport is interactive, and the
  rest stream in idle slices. Chunk boundaries are only ever taken where a chunk
  parses to the same document the whole note would (never inside front matter,
  never at a `---`), and a chunk that parses to nothing aborts the whole thing
  back to a single whole-document parse. → milkdown/markdownChunks.ts,
  milkdown/progressiveLoad.ts, `just chunk-census`,
  docs/evidence/milkdown-chunk-census.md
- A chunk may also begin without a preceding blank line, at a column-0 ATX
  heading, fence opener, blockquote start, or list item CommonMark lets
  interrupt a paragraph — so a note with no blank line anywhere can still
  open progressively. → milkdown/markdownChunks.ts

  The desktop window can still be closed during that freeze (RC-37): the close
  is JS-mediated (`startNativeShell.ts` `onCloseRequested`), so before
  2026-09-30 a close request made 8 s into a 100,000-line block was ignored
  for 70 s (until the parse ended). `close_deadline.rs` now arms on the first
  `CloseRequested`; if the app is still alive 5 s later (the JS handler's own
  3 s flush race plus 2 s margin) AND the page reports nothing unsaved, Rust
  waits for any in-flight vault write (the process-wide `vault_mutation_guard`,
  at most 5 s more) and exits without the JS thread. A note open is not an unsaved
  edit (a note switch awaits the outgoing save before the next note is read, and
  the page cannot be typed into while it parses), so the open case is exactly
  what the deadline cuts. A page that does hold an unsaved edit is not cut at the
  deadline, however long its JS thread stalls (an 8 s task, a 2.5 MB paste): the
  page tells Rust on every clean/dirty transition, reports at once from the
  editor's own transaction dispatch (any document-changing transaction, so
  keymap commands, toolbar and checkbox clicks count as well as typing; sidebar
  clicks do not) and on `beforeinput`, `paste`, `cut` and `drop` (before the
  stalling work begins, since the save queue only learns of an edit after the
  editor's own 200 ms debounce), and Rust waits for the JS handler. That wait
  ends early when the page that set the flag is gone (WebKitGTK's
  `web-process-terminated`, or a new page load; WKWebView and WebView2 are not
  hooked) and is capped at 60 s from the first close request, because a window
  must always be closable: a stall longer than that with an unsaved edit (a
  ~5 MB paste on WebKitGTK takes ~80 s) loses it, with one log line. Measured: exit 5.4 s after the request with the
  giant note's bytes unchanged; 8 s busy loop, 2.5 MB paste and 2.5 MB replace
  each exit when the stall ends with the edit on disk; a responsive page with an
  unsaved edit still drains it through the JS handler and exits in 0.1 s. The
  JS handler also no longer abandons a write that is still running after its 3 s
  race (up to 15 s), which on a slow disk used to lose the edit and leave a
  `.sf-tmp-*` file. The freeze itself remains the gap. →
  apps/tauri/src-tauri/src/close_deadline.rs, closeDeadlineDirty.ts,
  startNativeShell.ts, tests/desktop-close-deadline.mjs

- While the tail is still streaming, content cannot leave the editor as a
  PREFIX: `change` is suppressed. A native `flush` returns the host's
  original bytes when untouched, or settles the tail before reporting an edit.
  Desktop component reads use the same complete-document serialization. A pinned
  `role="status"` bar reads "Loading the rest of this note…" while it runs, and
  the streamed appends are not undoable. → milkdown/hostHandle.ts `flush`, `getContent`,
  milkdown/progressiveLoad.ts, tests/editor-embed-milkdown.spec.ts
- Every top-level block is rendered eagerly; the editor applies no
  `content-visibility` containment. A Chromium-only containment rule ran from
  #106 until 2026-09-05 and was retired after measuring it against eager
  rendering on the low-end Android reference phone: with off-screen blocks
  skipped, the FIRST focus of a note stalled quadratically (3 s at 500 blocks,
  12 s at 1,000, 48 s at 2,000 — a real tap into a 4,000-line note froze the
  app), focused typing was no faster, and open time was the same. Eager first
  focus is 176 / 202 / 379 / 810 ms at 500 / 1,000 / 2,000 / 5,000 blocks. The
  rule also painted holes on Apple WebKit, so all three engines now render
  alike. → milkdownEditor.css (the comment where the rule was),
  docs/plan/milkdown-transition.md §5 "Containment retired",
  tests/editor-embed-milkdown.spec.ts
- The FIRST focus of an opened note — the tap that starts typing — is budgeted
  at **under 1 s at real-note sizes** on the reference phone and measured for
  every fixture, blurred again before the keystroke loop so the keystroke unit
  stays the desktop gauntlet's. → tests/lib/editorDevicePerf.mjs
  `DEVICE_BUDGET.firstFocusMs`, tests/lib/editorDevicePerfSnippets.mjs,
  tests/android-editor-perf.mjs
- Decoration repaints are bounded to the textblocks a transaction changed, never
  the document: tag decorations and fenced-code highlighting re-derive only
  the blocks that moved, and a task checkbox edit rebuilds only the affected
  item even inside a long nested list. A fence over 20,000 characters is left uncoloured
  rather than paying for it. → milkdown/blockDecorations.ts,
  milkdown/tagDecorations.ts, milkdown/codeHighlight.ts
- Per-keystroke work does not scale with the number of links on screen times the
  vault. Rendering a wikilink needs the whole note-id list twice — once to resolve
  the target, once for the shortest unique display suffix — so both go through one
  index (`getWikilinkIndex`), never per link; `[[` completion shares it. The
  index is rebuilt whole whenever the note list changes, which a save
  mid-typing does, so the keystroke after an autosave pays one pass over the whole
  vault — tens of ms at 8,000 ids and over 100 ms at 50,000 in a Node
  microbenchmark of the build alone, never measured in a shipped engine, so treat
  those as a floor: a very large vault pays a real hitch there, and profiling it
  against these numbers will mislead. → wikilinks.ts, notes.svelte.ts
- One large insertion (a paste) costs time proportional to the pasted size, not
  its square. `tests/paste-perf.spec.ts` compares the same paste at 1,250 and
  5,000 items and bounds the RATIO rather than a duration, because a busy machine
  inflates both sizes alike but only a quadratic inflates the ratio. Measure a
  paste with a real paste event: CDP `Input.insertText`
  (`page.keyboard.insertText`) splits a multi-line insertion into quadratically
  many browser editing operations and is quadratic even against a bare
  `contenteditable` carrying no application code, so it measures the harness, not
  the editor (M21). → tests/paste-perf.spec.ts

## Saving & rename

- Every edit the user makes reaches the host once the document settles (~200 ms
  debounce), and clearing the whole note is one of them: select-all-delete is
  reported as a change to the empty document, however soon after the note was
  opened. The editor knows an edit happened because it saw the TRANSACTION,
  never by comparing the settled document against a remembered one — a cleared
  note is byte-identical to the pristine empty document every editor starts
  from, so any such comparison reads the user's deletion as "nothing changed"
  and drops it. → src/features/editor/milkdown/documentChanges.ts,
  src/features/editor/milkdown/serializationLoop.ts `reportDocumentChange`,
  src/features/editor/milkdown/MilkdownEditor.test.ts,
  tests/note-never-emptied.spec.ts
- A note that has content is never written back empty on the strength of an
  editor's word alone (CRITICAL). An empty document is only saved as a deletion
  when the editor REPORTED the emptying as a change; an editor that went blank
  on its own — a parse that threw, a replaced component — has notified nobody,
  and its `''` is refused. A rename typed alongside such a blank editor still
  lands, carrying the body the session last knew. → src/features/notes/
  noteSessionChanges.ts `editorLostTheNote`, createNotePersistence.ts,
  src/features/notes/noteSession.test.ts, tests/note-never-emptied.spec.ts
- Opening a note never adopts an EMPTY editor serialization as the save
  baseline for a note that read non-empty from disk. The editor's own
  serialization is otherwise the baseline, because Milkdown normalizes syntax
  on parse — but an empty one is a failed load, not a normalization, and
  adopting it declares the note empty for every later save. → src/features/
  notes/createNoteLoader.ts
- A failed desktop disk save blocks switching notes, going Home, and closing the
  outgoing tab. The outgoing draft stays open and dirty, its tab is restored,
  and a visible save-failure message permits retry. A converged or durably
  parked draft permits navigation. While the vault is locked (settings.md) no
  save can succeed, so a failed save does not hold the user: leaving the note
  discards its unsaved text. _(desktop)_ → `noteSaveQueue.ts`,
  `createNotePersistence.ts`, `createTabNoteTransition.ts`,
  `noteSession.svelte.ts` `flushBeforeLeaving`
- Editor rename and move send the body, saved baseline, and destination through
  one Rust workflow. A peer-changed source remains untouched; the local draft
  becomes a conflict copy at the requested destination, and the editor follows
  the engine's final id and title. Collision handling and backlink changes stay
  under the same vault guard. → `LocalNoteStore::save_draft_as`, `move_draft`

- Body edits autosave on a debounce (~400 ms). The save re-reads the current
  note id at fire time, so a save landing **after** a rename writes to the
  renamed note, not a stale id. → NoteEditorScreen.kt / NoteEditorView.swift
  `scheduleSave`
- Native saves return an explicit committed/failed outcome. A failed write does
  not advance the editor's saved snapshot, so the draft remains dirty and a
  visible message tells the user it is still pending. Rename and move stop
  before changing the note's identity when their required body flush fails;
  conflict adoption likewise waits until the local conflict copy is durable.
  A dirty native editor that leaves the screen retains its final draft registration
  until the asynchronous leave flush writes or parks it successfully. A later
  successful ordinary save clears only the exact retained revision it observed,
  so it cannot accidentally discard a newer retained edit. Identity mutations
  advance a store-owned draft generation before suspending: delete first commits
  every dirty editor snapshot and aborts visibly when that write fails, then
  discards the old identity's live and retained drafts only after the delete
  commits; rename/move retarget retained drafts to the authoritative final id.
  Failed identity mutations reopen a fresh generation. A queued or failed leave
  flush from the old generation therefore cannot resurrect a deleted note or
  create an old-id ghost after rename/move. Android keeps the editor Back handler
  installed while a navigation commit is pending, consuming repeated Back presses
  instead of letting the parent route pop early; after awaiting its current mailbox it
  also commits a valid visible title immediately rather than waiting for the
  rename debounce. The iOS move awaits the final posted editor document
  after destination selection, persists or parks it through the draft workflow,
  and moves the parked conflict identity when that is where the local draft was
  committed. _(iOS, Android)_ → `NotesStore.write`,
  NoteEditorScreen.kt / NoteEditorView.swift,
  NativeMutationOutcomeTest / NativeMutationOutcomeTests
- Android title edits debounce into a rename; iOS commits via the rename dialog.
  Both use the baseline-aware save-and-rename workflow after pending saves are
  cancelled/drained. Only an actual durable result advances the saved body
  snapshot; a no-op title never marks a dirty body saved.
  → NoteEditorScreen.kt / NoteEditorView.swift
- Leaving the editor flushes a pending save only if the content changed. The
  engine then decides whether the note is written, recreated, or parked.
- A confirmed local delete is the final editor mutation for that note. Android
  serializes body saves, title flush/rename, conflict adoption, the complete
  flush-and-move transaction (including its final id update), and delete through
  one editor session (see "Editor exits"). iOS cancellation chains own the
  actual committed move—not only presentation of its picker—and delete awaits
  the complete save/rename/adoption/move chain before removing the final id.
  Once closing starts, iOS blurs the WebView, quarantines late bridge changes,
  and never flushes that closing view on disappear. Its centered delete card is a
  transparent cover, and presenting that cover is explicitly excluded from the
  editor's navigation-disappear cleanup. A committed delete discards the
  quarantine; a failed delete restores and autosaves it, so the note is neither
  recreated after success nor stripped of a late edit after failure. An
  in-flight conflict flush, move, title debounce, or queued bridge callback
  therefore cannot recreate or rename a note after its delete commits. _(iOS,
  Android)_ → `EditorSession` (EditorSession.kt / EditorSession.swift),
  `EditorDraftCoordinator`, NoteEditorScreen.kt, NoteEditorView.swift,
  NativeMutationOutcomeTests
- Backgrounding the app makes a **best-effort** flush of the open editor's
  pending edit at the first leave-foreground signal, so an edit caught inside the
  autosave debounce is usually persisted before the OS jetsams the process. The
  flush is fire-and-forget, so an immediate process death can still beat the
  write — true on both native shells. → Android MainActivity `onPause` →
  `NotesStore.flushPendingEditor`; iOS FutoNotesApp scenePhase
  `.inactive`/`.background` → `NotesStore.flushPendingEditor`
- A native leave/background flush and the desktop editor's debounced body save
  go through the engine's ONE draft-saving verb (persist-or-park, ADR-0001):
  `flush_draft(id, base, content)` resolves every surprise itself under the
  store gate plus the process-wide vault mutation guard shared with sync, and
  returns one flush disposition plus the mutation to apply — **wrote** (the
  note still held `base`; content a live pull adopted since the editor's last read is never
  clobbered by a stale flush), **converged** (disk already equals the draft —
  explicit, no rewrite, no mtime bump; shells never read disk to compare),
  **recreated** (peer deleted; the edit wins at the ORIGINAL id — the same home
  the editor's resume autosave rewrites, so survive + jetsam converge with no
  duplicate copy; the install is no-replace on every filesystem — atomic where
  one offers the primitive, an exclusive create plus copy where none does (see
  app.md) — so a live-sync write that recreates the id outside the engine's
  serialization in the flush window is not clobbered — the draft is parked
  instead), or **parked** as a conflict
  copy (peer changed; both versions survive, the copy id reported). A dirty
  draft is never silently dropped; a clean editor never flushes, so a genuinely
  abandoned note is never resurrected. Conflict copies are named by the
  engine's one conflict-naming rule ("<title> (conflict YYYY-MM-DD)", counter
  suffix on a same-day collision), and parking is idempotent — a crash-window
  double-park mints ONE copy. On desktop, a parked disposition adds the
  conflict copy's returned mutation to the note projection, leaves the draft
  baseline uncommitted, then re-reads and adopts the diverged original from
  disk through `reconcileOpenNote`; the copy appears in the list with no toast.
  On desktop, only a same-id body save uses `flush_draft`; a rename persists
  the title and body through the store's single save workflow, never as a
  separately committed flush followed by a move. _(desktop, iOS, Android)_ →
  `futo_notes_store::LocalNoteStore::flush_draft` via FFI `flush_draft`;
  desktop `notes.svelte.ts updateNote` through
  `createNotePersistence`/`noteSession.svelte.ts`; native
  `NotesStore.flushDraft`/`flushAsync`; conflict naming
  `futo_notes_core::conflict_names`. Guarded by the flush_draft unit tests in
  crates/futo-notes-store/src/tests.rs (all four dispositions, converged/park
  boundary, recreate-vs-reappeared window, park idempotency, recreate-arm
  mutation positioning, store-vs-sync serialization), desktop
  `notes.contract.test.ts` / `createNotePersistence.test.ts` /
  `createExternalChangeCoordinator.test.ts`, the FFI note_contract test, and
  apps/ios/Tests/Notes/Editor/FlushDraftVerbTests.swift and Android's
  `EditorLifecycleFlushTest`. Earlier behavior verified on iOS 2026-07-13
  (sim); iOS verb wiring verified via `just test-ios-native` 2026-07-21 and
  Android verb/adoption wiring via `just test-android-native` 2026-07-23.
- A durable native autosave flush **always advances the open editor's saved
  baseline to the bytes that landed**. Rescheduling the debounce on the next
  keystroke may cancel the task, but it must never skip that post-flush record;
  only an editor identity that has already moved elsewhere may veto it. A
  parked disposition follows the returned copy and advances its baseline in
  the same step, so the next save cannot re-park against the original note.
  iOS makes this liveness-free decision in `settledFlush`; Android holds the
  flush-and-record span in `withContext(NonCancellable)`. _(iOS, Android)_ →
  NoteEditorView.swift / NotesStore.swift `settledFlush`, EditorSession.kt
  `NonCancellable`; guarded by `SettledFlushTests`,
  `EditorSessionTests.cancelledSaveStillResumes`, and Android
  `EditorSessionTest`.
- The open editor's unsaved-draft register is **derived** from the editor's live
  state (note id, buffer, saved content, loaded) rather than hand-synced, so it
  goes clean the instant a save completes or a remote is adopted (no stale draft
  clobbers the adopted content). It is owner-scoped so a screen leaving during a
  push/pop transition can't drop the incoming screen's draft. Android registers
  one derivation closure the flush pulls synchronously; iOS publishes the derived
  value both synchronously in the WebView change callback (so the register is
  current the instant before a background flush reads it) and reactively via
  `.onChange` for the clear-on-save / clear-on-adopt transitions — SwiftUI
  `@State` can't be pulled from an escaping closure the way Compose snapshot state
  can. _(iOS, Android)_ → NoteEditorScreen.kt / NoteEditorView.swift →
  `NotesStore.setDraftProvider`/`publishDraft` + `claimDraftOwnership`. Verified
  on iOS 2026-07-13 (sim: edit → immediate background before the debounce
  persisted; rename with a pending body edit preserved the edit under the new id
  with no ghost). NOTE: a simulator can't reproduce OS jetsam, so this validates
  the surviving-process flush path, not an actual jetsam-during-background kill.
- An empty title shows the placeholder "Untitled"; the title field strips
  newlines.
- A title that differs from the saved title only by leading or trailing
  whitespace leaves the session clean and skips the write. Only the saved-title
  comparison is normalized; the visible editor title keeps its whitespace.
- A duplicate title blocks the save and shows the inline warning text
  "A note with this name already exists".
- The editor chrome shows **no word count** (or any other document
  statistic) — just the title and the document (spec decision 2026-06-10;
  Android native previously rendered an "N words" line under the title, no
  other platform ever did). → NoteEditorScreen.kt
- On Tauri the same contract holds via the shared shell: the title is a
  textarea above the tag bar; edits debounce into a file rename and rewrite
  backlinks (see "Wikilinks — navigation & integrity"). Verified on Android
  Tauri 2026-06-09.
  - Title-only edits use an aggressive ~10 s debounce (body edits keep ~500 ms)
    so a rename round-trip never fires mid-typing and clobbers in-flight
    keystrokes.
  - That debounce is a **backstop, not the commit path**: **the title field
    losing focus commits the pending rename**, wherever focus goes — the body,
    another note, or inert chrome — so the list picks up the new name when the
    user is done naming rather than only as a side effect of the next body edit.
  - Enter commits too (it moves focus to the body).
  - A title left unchanged writes nothing.
  - The commit is **deferred until the pointer gesture that blurred the field is
    over**. `blur` fires on pointer-DOWN, and a rename re-sorts the list (the
    note jumps to the top on mtime): commit during the press and the row under
    the cursor changes before the click is delivered, so a click aimed at
    another note opens the wrong one — and the click, whose press and release
    now hit different rows, reaches no row at all.
  - A drag holds the commit past the drop, until `dragend`. The drop handler
    acts on the note id captured at `dragstart`, so a rename landing mid-drag
    would leave it moving a file that no longer exists and the move would be
    lost. A gesture that ends without a click or a drag drains on a short
    fallback instead.

  → `noteSession.svelte.ts` `debouncedSave`,
  `createNoteTitleController.svelte.ts` `handleBlur`,
  `$shared/dom/pointerGesture.ts` `runWhenPointerIdle`;
  tests/p2-regressions.spec.ts, src/shared/dom/pointerGesture.test.ts

## Editor exits — every way an open note ends _(iOS/Android)_

While a note is open both native shells run asynchronous workflows against ONE
note identity — the debounced body save, the debounced title rename, live-sync
adoption of an on-disk change, plus a fourth per shell (iOS the folder move,
Android an image insertion) — and the user can leave at any moment: Back, the
system back gesture / leading-edge swipe, a resolved wikilink, Move, Delete.
Every exit is one case of a single verb that runs **admission → latch → cancel →
drain → commit → the exit's own effect**. The guarantee the ordering exists to
keep: no async completion may land against a stale note identity (a save holding
the pre-rename id recreates a ghost note; a rename landing after a delete
resurrects the file).

Each shell owns its own implementation, in its own idiom — Android one mutex
where taking the lock IS the drain, iOS per-workflow cancellation chains awaited
in a declared order. The engine owns what a save MEANS (persist-or-park,
ADR-0001) and is reached only through injected effects; the shells own only when
that work runs and in what order, because every step being ordered is a
host-runtime handle (a Compose coroutine, a Swift `Task`, a WebView round-trip, a
navigation that has to stay vetoable). This section is the shared statement of
that ordering — the two implementations are held together by it plus each shell's
ordering tests, not by shared code. → EditorSession.kt, EditorSession.swift,
EditorSessionTest.kt, EditorSessionTests.swift

- Every latch an exit sets lands **before the first suspension**: the destructive
  latch, the one-exit-at-a-time admission, and the interaction lock are all set
  in the same turn as the user's tap, so the exit verb is deliberately neither a
  `suspend fun` (Android — `rememberCoroutineScope` dispatches on the next frame)
  nor `async` (iOS). A keystroke, a second Back, or a queued save arriving after
  the tap is therefore already fenced. _(iOS/Android)_ → EditorSession.kt `end`,
  EditorSession.swift `end(_:effects:)`
- A destructive exit's cancels land **before** the drain: delete cancels the
  queued debounces synchronously (iOS all four workflows, Android inside the same
  pre-suspension step as the latch), so the drain only ever waits for work that
  was already in flight, and anything queued behind the latch touches nothing at
  all — Android's `runWork` returns null, an iOS scheduled workflow sees
  `isActive == false`. The debounced body save is the one exception, neutralised
  as the first step of the commit rather than at admission (cancel, then await
  it): a save already running has to finish and be projected before the exit
  awaits its current mailbox, or the next commit races the write it supersedes. _(iOS/Android)_
- While an existing note's disk read is pending, the visible placeholder has no note identity. It never seeds that note's mailbox. Starting a new open invalidates the previous clean snapshot; reconciliation waits for `documentLoaded` for the real note. Quick capture already owns the engine-created empty body and accepts edits immediately. _(native shells)_ → NoteEditorView.swift, NoteEditorScreen.kt, EditorMailbox.swift `prepareLoad`, EditorMailbox.kt `prepareLoad`
- Every document report carries its vault-relative note id and a page-monotonic generation. A shell routes reports into the named note's mailbox even after another view attaches. _(native shells)_ → packages/editor/src/bridge.ts, EditorMailbox.kt, EditorMailbox.swift
- A reportable user transaction advances the generation synchronously. The first transaction after a load or delivered change posts `edited`; subsequent transactions in that unreported run do not post another watermark. _(native shells)_ → milkdown/serializationLoop.ts `documentEdited`
- A mailbox is current when its newest change generation is at least its edited watermark. Current exits use those bytes without WebView interaction; a behind exit asks for one flush and waits up to 6 seconds. A token-tagged failure or deadline while still behind refuses a user exit, releases its latches, and permits retry. _(native shells)_ → EditorMailbox.kt `awaitCurrent`, EditorMailbox.swift `awaitCurrent`
- A renderer-death OS signal lets every exit proceed on the mailbox's latest bytes. A never-loaded, never-edited note leaves using the shell's disk copy with nothing to save. Silence alone never declares a renderer dead. _(native shells)_
- The body an exit commits is the newest tagged change held by its mailbox after the flush wait. A destructive exit still folds in newer quarantined changes before completing. _(native shells)_ → EditorSession.kt, EditorSession.swift
- A failed body flush or pending rename refuses a user exit and releases every latch it set. A failed delete leaves the editor usable. _(native shells)_
- iOS system Back and edge swipe commit after the pop. They wait once when behind and proceed on the mailbox's latest bytes even if the wait fails; a later delivered change is handed to retained persistence. The parent may re-adopt first: loading it flushes the child's outgoing edit with the child's identity before loading the parent. _(iOS)_ → NoteEditorView.swift `finishLeave`, EditorMailboxTests.swift, docs/qa/wikilink-pop-large-edited-note.md
- Streaming withholds content changes to protect against saving a prefix, but never withholds the synchronous `edited` signal. A flush settles an edited tail before reporting the complete document; a clean streamed flush echoes the host's full original bytes. A note switch reports an outgoing pending edit synchronously before replacing its identity. _(native shells)_ → milkdown/hostHandle.ts `flush`, `setContent`, milkdown/documentLoad.ts `finishProgressiveLoad`
- Blur, hidden visibility and pagehide flush the embedded editor immediately. Backgrounding explicitly waits for posted changes (2 seconds on Android, 6 seconds within iOS background time) and then flushes the draft register, including the mailbox's latest available bytes after a failed wait. A durable write advances the baseline before a later write. _(native shells)_ → BackgroundEditorFlush.swift, NotesStore.kt, EditorSession.kt
- Renaming, moving or following a parked identity awaits the outgoing mailbox, then calls `retarget(fromId, toId)`: the editor relabels its live document and reports it through `change` under the new id, preserving caret, scroll, undo history and any keystroke after the flush. The shell does not re-push its copy, and a retarget naming another note is ignored. Ordinary edits do not invalidate asynchronous image insertion or selection-link editing. _(native shells)_ → milkdown/hostHandle.ts `retarget`, EditorMailbox.kt `retarget`, EditorMailbox.swift `retarget`, NoteEditorView.swift `retargetNoteId`, NoteEditorScreen.kt `retargetNoteId`
- A late iOS departure draft is published and retained until a durable write or park succeeds; a failed late write remains eligible for background retry. Only the newest bound view for a shared note id receives a change; covered views do not acquire another stale-base draft. _(iOS)_ → NotesStore.swift `flushRetainedEditor`, EditorMailbox.swift `change`
- A native host releases unused clean mailbox bodies after detachment or document handoff. Pending flush waiters, active bindings and retained unreported drafts keep their entries until settled. _(native shells)_ → EditorMailbox.swift `prune`, EditorMailbox.kt `prune`
- Debug native apps load the query-gated editor test hooks for device harnesses, including document replacement. Release URLs do not enable those hooks. _(native shells)_ → EditorWebView.swift `loadEditor`, EditorWebView.kt, src/editor-embed/main.ts
- A rename or move invalidates an earlier clean snapshot for its target id. A self-link relink waits for `documentLoaded` under the new identity before offering a conditional replacement; an unanswered load never invents a generation. _(native shells)_ → EditorMailbox.swift `awaitLoaded`, EditorMailbox.kt `awaitLoaded`, NoteEditorView.swift `settleRelink`, NoteEditorScreen.kt `settleRelink`
- External updates and relinks are conditional on the exact note id and generation held by the editor, with no unreported edit. Refusal keeps the draft; acknowledgment advances the shell baseline. Relinks rebase and retry at most three times. _(native shells)_ → milkdown/hostHandle.ts `applyExternalContent`, EditorWebView.swift, EditorWebView.kt
- A **committed** delete's latch is one-way for that session: no pending
  workflow, queued bridge callback, title debounce, or in-flight adoption can
  touch the note afterwards. _(iOS/Android)_
- Only one navigation exit runs at a time. A second Back while the first is
  still draining is dropped, and a refused exit may be retried. _(iOS/Android)_
- The exit's own effect cannot interleave with a tracked workflow. Same
  guarantee, three mechanisms: Android runs move and delete inside the drain
  lock; iOS's move exits register their task as the move workflow, so a later
  exit draining that workflow waits for them; iOS navigation and delete instead
  rely on admission plus a post-drain re-check (a delete that latched while the
  drain ran abandons the exit rather than committing into it). _(iOS/Android)_
- Editor change events are fenced before the initial off-main read lands (an
  empty `setContent` echo must never be saved back over the note) and once a
  destructive exit has latched. Android additionally fences them while the vault
  is migrating to another storage root. _(iOS/Android)_ → EditorSession.kt
  `acceptsEditorChange`, EditorSession.swift `disposition(loaded:)`
- A peer delete adopted by live sync is its own ending: the file is already gone,
  so there is nothing to drain and nothing to commit, and the session only has to
  ensure no pending workflow resurrects it. _(iOS)_ → EditorSession.swift
  `closeForExternalDelete`
- An exit with no editor attached drains nothing and commits nothing against an
  unknown body — it just leaves. Only the legacy-WebView notice (github#8) is in
  that state deliberately: it renders no editor at all and its Back must still
  work. Any other detached state means the editor is mid-attach, and the exit is
  dropped. _(Android)_ → EditorSession.kt `exitWithoutEditor`,
  EditorAttachmentGate.kt

Two **permitted** divergences — each shell keeps its own sequence; the shared
invariant above is what both must satisfy:

- Navigation commit order: Android commits the body, then the title; iOS commits
  the title (the rename), then the body. Both commit both before the file moves,
  so neither can strand a body at a dead id. _(iOS/Android)_
- Move-picker timing: iOS drains before presenting the destination picker (its
  own `prepareMove` exit); Android presents immediately and drains in `onPick`.
  Both complete the drain before the move commits. _(iOS/Android)_

Two divergences are **not** permitted — each is one shell failing the invariant,
left open because closing it is a behavior change, not a refactor:

- On a parked-conflict flush the editor follows the parked id, so it never stays
  pointed at an id whose disk content is now the peer's version.
- An editor change that arrives after a destructive exit has latched is
  quarantined and folded into the final commit, never dropped: a committed delete
  discards it, a failed delete restores it.

## Android — IME

- Backspace on an empty note must not crash the WebView renderer. _(Android)_
  - _History (resolved):_ Chromium 147's empty-editable surrounding-text path
    tripped a `CHECK()` (`SIGTRAP`) when FUTO Keyboard queried it on backspace.
    This was **fixed upstream by a FUTO Keyboard update**, so the in-app IME
    shield is no longer required. → docs/learnings/ime-shield-workaround.md
  - The in-app IME shield has been **removed** from the shared editor
    (`imeShieldPlugin` / `imeShield.ts`) and the `just verify-ime-shield` guard
    is gone. The native Compose app never carried it and is fine without it.
    (The `FutoImeConnection` / `EditorImeShield` Kotlin classes only ever lived
    in the gitignored generated Tauri-Android tree, which is no longer generated,
    and the `WRY_RUSTWEBVIEW_CLASS_EXTENSION` override that injected them is gone
    from `apps/tauri/src-tauri/.cargo/config.toml`.)
- Typing must be free of IME/caret glitches on every WebView the editor runs in.
  _(Android)_
