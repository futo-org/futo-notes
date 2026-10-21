## Markdown elements (rendered / decorated)

- Headings h1–h6, with inline emphasis / code / wikilinks inside.
- Emphasis: bold, italic, bold-italic, strikethrough — `*` and `_` markers.
- Code: inline (single and double backtick) and fenced (triple backticks or
  triple tildes, with optional language).
- Fenced-code syntax coloring covers a curated language set (~35), each grammar
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
  Chromium-83 WebView 2026-08-21). → editor.html, tests/editor-embed-webview-floor-css.spec.ts
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
  (`+++` TOML front matter is not recognized and round-trips as the paragraph
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
