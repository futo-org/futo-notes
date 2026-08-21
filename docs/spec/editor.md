# Editor — Spec

The editor is a shared CodeMirror 6 WebView — the **same `editor.html` /
`packages/editor` bytes on all platforms**. It renders Obsidian-style live
preview. Fine-grained decoration/cursor cases live in `markdown-spec/cases/`;
this file states the behaviors a human cares about.

## Native host boot _(iOS/Android)_

- The native shells load the bundle ONCE, pre-warmed at app start, and it shows
  nothing until it is configured: the page posts `ready`, and the shell's only
  correct reply is a single `FutoEditor.initialize(configJson)` carrying its
  whole intent — bridge version, theme, the open note's markdown, the note
  universe, the local-image base URL, whether the shell renders its own toolbar,
  and the note body's inline inset. The bundle applies them in ONE order it
  owns (layout, toolbar and theme before any text; image base and note universe
  before the content so images size and wikilinks resolve on the first render;
  the note text last), then posts `initialized`. _(iOS/Android)_ →
  packages/editor/src/hostBoot.ts, bridge.ts v7, EditorWebView.swift
  `sendHostConfig`, EditorWebView.kt `sendHostConfig`,
  tests/editor-embed-bridge.spec.ts
- A shell treats `initialized` — not `ready` — as "this page is showing my
  note": it is where the shell fires its per-note ready callback and its
  auto-focus keyboard shim, and where it re-pushes anything the user or a sync
  changed while the config was in flight. _(iOS/Android)_ → EditorWebView.swift,
  EditorWebView.kt
- The note body's left inset is a per-shell VALUE the shell declares
  (iOS 14px, Android 16px — each aligning with its own native title field, on
  top of the embed's own 6px `.cm-line` inset), not per-shell knowledge: only
  the bundle knows which CSS variable carries it. _(iOS/Android)_ →
  hostBoot.ts `contentPaddingInlinePx`, editor-native-layout.css
- When the shell and the bundle were built against different bridge versions,
  the editor **still boots** and the bundle posts `bridgeVersionMismatch`; each
  shell logs it (Android also toasts in a debug build). A shipped app carries
  both halves in one artifact, so a mismatch only ever means a stale developer
  build — and refusing to boot would turn that into a permanently blank editor,
  the app's core surface. _(iOS/Android)_ → bridge.ts
  `BridgeVersionMismatchMessage`, hostBoot.ts, tests/editor-embed-bridge.spec.ts
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
  tests/editor-embed-bridge.spec.ts
- Editor text stays legible on legacy Android system WebViews (Chromium < 99,
  no `@layer` support — they drop every Tailwind-layered rule, including the
  light theme tokens and the `body`/`.cm-editor` colors): editor.html carries
  an unlayered inherited text-color fallback on `html`, resolving the dark
  token via the unlayered `[data-theme='dark']` variables and falling back to
  the literal light token. _(Android)_ → editor.html,
  tests/editor-embed-bridge.spec.ts (legacy WebView tests)
- The editor needs a System WebView engine of **Chromium 80 or newer**: the
  bundle targets ES2020, an `editor.html` `String.prototype.replaceAll` shim
  covers Chromium 80–84 (Svelte 5's runtime would otherwise throw), and the
  editor uses `textContent = ''` rather than `Element.replaceChildren` (Chromium 86) in its own DOM code so tables and the slash menu work down to the floor
  too. _(Android)_ → editor.html, slashMenuRenderer.ts, tableEditorWidget.ts,
  vite.editor.config.ts
- Whether an engine is supported is decided by **capability, never by a version
  number**: the page reports what it couldn't parse and whether the editor
  mounted, and the shell reads that. A WebView `versionName` is never consulted —
  a vendor provider numbers itself (Huawei WebView 12.x/15.x on a modern
  Chromium), so a version floor rejects working engines. _(Android)_ →
  editor.html, EditorEngineSupport.kt, EditorWebView.kt,
  tests/editor-embed-bridge.spec.ts (engine preflight tests)
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

## Live preview

- Markdown markers (`*`, `#`, ` ``` `, `[[`, `]]`, …) are hidden on lines that
  don't contain the cursor, and revealed when the cursor enters that line. →
  markdown-spec/cases/10-cursor-reveal
- A blurred editor reveals nothing — all markers stay hidden.
- Reveal is per-line: moving the cursor onto a line reveals its markers; moving
  off re-hides them.
- **Markers whose hidden span would cover a line break stay visible instead.**
  Malformed-but-parsed inline markdown can straddle a newline — `[](\n)` is one
  link node, `![](\n)` one image node — and CodeMirror forbids a view plugin
  from replacing a line break, so hiding those markers threw
  `RangeError: Decorations that replace line breaks may not be specified via
  plugins` mid-render and the editor kept showing the previously opened note.
  Opening such a note threw, and so did typing or pasting the same text and then
  moving the caret off it. Both paths now render the syntax rather than hiding
  it; a link whose *text* wraps across lines (`[a\nb](c)`) still hides normally.
  → live-preview/decorationSet.ts `replacementCrossesLineBreak`,
  live-preview/inlineDecorations.ts `decorateLink`,
  liveMarkdownTransform.decorations.test.ts,
  markdown-spec/cases/13-adversarial/broken-syntax.yaml
- Reveal survives opening a note. Opening one swaps the editor's whole state, and
  state that is seeded from focus EVENTS (the interactive-table field: `create()`
  cannot see the view, so a fresh state believes it is unfocused) is re-synced from
  the live view as part of the swap. A focused editor whose restored caret lands
  inside a table therefore shows the table's markdown source, not the unfocused
  table widget. → swapEditorState.ts, table/interactiveTableEditor.ts,
  tests/table-focus-after-note-switch.spec.ts
- Reveal state belongs to one editor: pressing or dragging in one open editor
  never freezes or suppresses markdown reveal in another. →
  interactions/editorPointerInteractions.ts, live-preview/selectionReveal.ts

## Cursor

### Placement

- Tapping text places the caret at the tapped character. → MarkdownEditor.svelte
- Tapping past a visual row's rendered text lands at that row's end; at a wrap
  boundary the caret stays on the tapped row. → interactions/pointerHitTest.ts
  `rowEndSelectionAt` `cursorOnTappedRow`, interactions/pointerHitTest.test.ts,
  tests/editor-ux.spec.ts
- When hidden trailing syntax such as a wikilink's `]]` or a closing code fence
  extends past the rendered row, off-text placement uses the logical line end
  rather than entering the hidden markup. → interactions/pointerHitTest.ts
  `lineHitBesidePoint`, tests/editor-ux.spec.ts, tests/wikilinks.spec.ts
- Arrow up/down moves by visual row on wrapped lines and skips block widgets. →
  markdown-spec/cases/10-cursor-reveal
- Pressing Enter in a continued list item scrolls the new item into view. →
  docs/learnings/ios-keyboard-editor-jump.md _(iOS)_

### Blank editor surface

- Blank space beside lines and below the final line is part of the editor;
  desktop press, drag, double-click, modified-click, and right-click beside a
  line behave as they do on its text. → src/styles/app-shell.css
  `.editor-container .cm-line`, tests/editor-ux.spec.ts
- A tap beside a line lands at its nearest end: left space selects the line
  start and right space selects the line end.
- A tap less than two line-heights below the text uses the pointer's column on
  the final visual row; a tap two or more line-heights below lands at the end of
  the note. → interactions/pointerHitTest.ts `positionBelowText`
  `ROWS_BELOW_TEXT`, tests/editor-ux.spec.ts, tests/editor-embed-bridge.spec.ts
- Modified presses (Shift/Alt/Cmd/Ctrl) retain the platform's selection
  behavior. → interactions/editorPointerInteractions.test.ts
- An off-text double-tap selects the word at the resolved position: the word
  under the pointer's column near the text or the final word two or more rows
  below it. On iOS, a third tap selects that logical paragraph; Android leaves
  triple-tap selection to Blink. → interactions/editorPointerInteractions.ts,
  interactions/editorPointerInteractions.test.ts,
  tests/editor-embed-bridge.spec.ts _(native shells)_
- The tag bar's blank space reaches the first visible editor line at the
  pointer's column, never a hidden header tag block; tag controls and the title
  keep their own interactions. → NoteWorkspace.svelte `reachFromTagBar`
- A primary press outside the desktop editor surface deselects the note without
  moving its caret and commits a pending title rename; movement during that
  press does not turn it into a text-selection drag. → NoteWorkspace.svelte
  `handleNoteBodyMouseDown`, tests/editor-ux.spec.ts _(desktop)_
- A desktop press in a note containing only hidden tag markup is refused rather
  than entering the markup. Native shells keep a platform caret so the note
  remains typeable, but it never lands inside a tag. →
  interactions/editorPointerInteractions.ts `guardHiddenOnlyNote`,
  tests/editor-embed-bridge.spec.ts _(desktop; native diverges)_
  > **Gap:** the native shells have no deselect zone. Their editor interaction
  > surface is the whole WebView below the title, so a tap outside the text
  > column reaches into the note at any distance instead of dropping focus.
  > _(native shells)_

### Native touch and focus

- Tapping an unfocused editor places the caret at the tap and raises the
  keyboard; wrapped-line taps remain on the tapped visual row. →
  interactions/editorPointerInteractions.ts, MarkdownEditor.svelte
- Off-text placement has one owner and never visibly jumps: desktop and Android
  resolve it on `mousedown`; iOS resolves it only after a single-touch gesture
  qualifies as a tap on `touchend`. → interactions/editorPointerInteractions.ts
  `desktopOffTextSelection` `handleMouseDown` `handleTouchEnd`
- Android preserves the native tap and keyboard path. It uses the compatibility
  mouse event for off-text placement because CodeMirror suppresses mouse-selection
  hooks immediately after touch, then corrects on-text single taps that Blink
  places incorrectly. → interactions/editorPointerInteractions.ts
  `handleMouseDown` `handleClick` _(Android)_
- The iOS blank tail is scrollable and outside `contenteditable`, preventing
  WebKit from replacing the resolved caret. Moved, cancelled, and multitouch
  gestures remain scrolling; the tail works after short and long notes so the
  final line can clear the keyboard. → editor.html
  `[data-ios-off-text-surface]`, tests/editor-embed-bridge.spec.ts _(iOS)_
- The first iOS tap focuses with `preventScroll` before setting the caret,
  including in the blank tail, so keyboard presentation does not scroll-jump
  the editor. → docs/learnings/ios-keyboard-editor-jump.md,
  interactions/editorPointerInteractions.ts `handleTouchEnd` _(iOS)_
- Native-shell policy comes from the host-provided `nativeShell` mode; iOS
  platform detection selects the iOS versus non-iOS pointer profile. →
  createMarkdownEditorRuntime.ts
- Focused on-text placement remains native on iOS. Android corrects every
  on-text single tap, including empty or widget lines that Blink maps to
  position zero. → interactions/editorPointerInteractions.ts `handleClick`
  _(native shells)_
- On-text double/triple-tap selection remains native on both shells; off-text
  multi-taps use the resolved word/paragraph rules above. _(native shells)_

### Selection

- Native shells keep platform selection, handles, loupe, and callout except for
  seeding the off-text double-tap range and the iOS paragraph range above.
  Verified on Android and iOS devices 2026-07-10. →
  interactions/editorPointerInteractions.ts _(native shells)_
- Desktop drag-selection across a rendered Markdown element expands through its
  hidden source markers so copy/delete preserve valid Markdown. →
  interactions/selectionSnap.ts _(desktop)_

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
- Blockquotes including nested; the `>` marker is dimmed when the cursor is on
  the line.
  > **Gap:** a blockquote's lazy-continuation line — one CommonMark keeps
  > inside the quote even though it carries no `>` of its own — gets no quote
  > decoration at all, because `decorateBlockQuote` skips every line whose own
  > text has nest level 0. It renders flush left with neither indent nor
  > stripe nor the quote's muted italic styling, ~29px left of the depth-1
  > quoted line above it (15px indent + one 14.4px gutter).
  > → src/features/editor/live-preview/blockDecorations.ts `decorateBlockQuote`
- Every `>` marker occupies a constant-width gutter, whatever characters it was
  written with and at whatever nesting depth: `> text` and `>text` put their
  content at the same x, and revealing the marker under the caret never shifts
  the line's content sideways. → src/styles/markdown-blocks.css
  `--md-quote-marker-gutter`, tests/blockquote-gutter.spec.ts
- Nested one, two, or three deep, a quote line is indented 15px per level and
  paints one 2px stripe at the left edge of each of those steps — at 0px, 15px
  and 30px from the line's left edge, so the innermost stripe sits one step
  left of the content rather than against it. The marker gutters follow the
  whole indent, so each extra level moves content right by the same constant
  amount. → src/styles/markdown-blocks.css `.cm-md-quote-level-2`/`-3`,
  tests/blockquote-gutter.spec.ts
  > **Gap:** blockquotes nested four or more deep have no per-level rule, so
  > they fall back to the depth-1 15px indent and a single stripe — a depth-4
  > line's content renders ~15.6px LEFT of a depth-3 line's (45px + 3 gutters
  > against 15px + 4 gutters; measured in chromium at the default 18px editor
  > font, where the 0.8em gutter is 14.4px). Only the indent is affected:
  > gutter width and reveal stability hold at every depth. Closing it takes a
  > rule in BOTH src/styles/markdown-blocks.css and src/styles/app-shell.css —
  > the `.editor-container`-scoped padding there outranks a bare
  > `.cm-md-quote-level-N` rule.
- Lists: ordered, unordered, nested, and task checkboxes (checked / unchecked /
  uppercase `X`).
- A list item's leading indent never suppresses its marker: a whole list
  indented by one to three spaces still renders bullets, not raw `*`. Depth
  comes from the parse tree, not from counting spaces — `*  Parent.` (two
  spaces after the marker) puts its content at column 3, so a two-space child
  is too shallow to nest and CommonMark renders it level with its parent as a
  sibling. → live-preview/listDecorations.ts `listIndentLevel` /
  `parseListMarker`, markdown-spec/cases/06-lists/unordered.yaml
- Tapping/clicking a bullet or number marker places the caret at the marker
  (revealing the dimmed `-`/`N.` source — the same state as arrowing onto
  it); a marker tap must never be a no-op. The markers are
  contenteditable=false widget spans, so the browser can't place a caret in
  them and CM's default `ignoreEvent() === true` would swallow the tap —
  both marker widgets return `false` (same contract as the HR widget).
  Checkbox and image widgets intentionally keep `true` + their own handlers
  (toggle / place-at-line-end). → live-preview/listDecorations.ts
  BulletWidget/NumberWidget, liveMarkdownTransform.decorations.test.ts
- A list item that wraps **hanging-indents** its continuation lines: wrapped
  rows start under the item's text, never back under its marker, while the
  first visual row still starts at the nesting indent. Applies to bullets,
  ordered items, and task items at every nesting depth, on every platform
  (spec decision 2026-08-14, reversing the 2026-06-10 decision that put
  wrapped rows at the left margin). The indent rides on `margin-left` plus a
  negative first-line-only `text-indent`, never on `padding-left` — `.cm-line`
  padding is owned per context (desktop, native embed, blockquotes). →
  live-preview/listDecorations.ts `cm-md-list-line` decorations,
  tests/markdown-rendering.spec.ts
- A list item's marker column is exactly as wide as its rendered marker, so
  the hang lands on the item's text: the bullet and number widgets are pinned
  to that width, the marker replacement covers the marker AND its trailing
  space, and a nested item's leading source indentation is hidden along with
  the marker (visual depth comes from the line's margin). A caret anywhere in
  that hidden run reveals the raw source, the same as a caret on the marker.
  Leading indentation is only hidden when it reaches the line start, so a list
  inside a blockquote leaves the `> ` alone. →
  live-preview/listDecorations.ts `markerGutter` / `hiddenMarkerStart`
- Tables (GFM), horizontal rules, and images — rendered as block widgets.
  Each replace widget's `estimatedHeight` must equal its real rendered
  footprint, and the widget's rendered height must be settled rather than
  open-ended — otherwise CM6 re-sizes the off-screen gap when the element scrolls
  back into view and jerks the scroll position on iOS momentum scrolling.
  Reserving that footprint as a `min-height` floor satisfies this as long as the
  content itself has a definite height and any later change re-measures (see the
  image-widget rules below); a pinned `height` is not required, and for
  width-constrained content it is actively wrong. → docs/learnings/hr-scroll-jank.md
- Image widgets re-measure on load. On the native shells an embedded image's
  bytes arrive asynchronously (fetched through the native scheme handler after
  the widget's first paint), so its real height is unknown when CM6 first
  measures it. The widget calls `view.requestMeasure()` from the `<img>`
  `onload` handler so CM6 recomputes its height map once the image resolves —
  otherwise the image renders cut off at the placeholder height on first load
  until an unrelated transaction (e.g. tapping it) forces a re-layout.
  _(iOS/Android native)_ → live-preview/images.ts
- Image widgets also re-measure on every width change, and reserve their
  footprint as a `min-height` floor rather than a pinned `height`. An image is
  width-constrained (`max-width: 100%`), so a wider editor makes it taller, and
  the wrapper is `overflow: hidden` — a height pinned at load time silently
  clipped the bottom of the image with no recovery path (reproduced on iOS 26.5
  by rotating to landscape, 2026-07-24; the zero-size WebView prewarm reaches the
  same state). A `ResizeObserver` on the `<img>` re-commits the floor, refreshes
  the shared size cache, and calls `view.requestMeasure()`; a zero-height
  measurement taken before the host has laid out is ignored so it cannot poison
  the cache. → live-preview/images.ts `ImageWidget`
- On the native shells the embed page pins `body` to the web view with
  `position: fixed` plus the four offset longhands, and `#editor` fills that body
  the same way. Both rules live unlayered in `editor.html`, never as `inset` and
  never behind `@layer`: a Chromium 80–98 Android System WebView discards every
  layered rule (so `base.css`'s identical `body` rule never arrives) and one
  below 87 also drops the `inset` shorthand, and that engine sizes the initial
  containing block to zero — so without both rules `.cm-scroller` never becomes a
  scroll container and CodeMirror scrolls the ROOT document to reveal the cursor,
  sliding the note up under the shell's native title bar as the user types
  (github#33, reported on 1.7.0 / Android 10; reproduced and fixed on a
  Chromium-83 WebView 2026-08-21). → editor.html, tests/editor-embed-bridge.spec.ts
  "pre-inset WebView"
- On the native shells (iOS **and** Android — CM6 owns its own scroller), the
  editor warms CM6's height map on note load (and after font load / width change)
  by measuring every line's real height up front. Off-screen wrapped lines are
  otherwise estimated too short; the first scroll past them triggers a `scrollTop`
  anchor correction that cancels native touch momentum — the note "jumps forward
  and stops, no bounce" (measured up to 1436px on Android). Native overscroll
  affordance (`overscroll-behavior: contain` — iOS bounce / Android stretch) must
  be preserved. → src/features/editor/heightMapWarm.ts, docs/learnings/hr-scroll-jank.md
- Wikilinks `[[Title]]`.

## Tags

- A `#tag` is extracted and decorated only when it is at a word boundary, does
  not start with a digit, is within the max length, and is NOT inside inline
  code or a fenced block. → markdown-spec/cases/09-tags, 13-adversarial
- Tags dedup case-insensitively (`#Project` + `#project` → one `#project`).
- A leading header tag block is recognized and hidden when the cursor is away.

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

## Wikilinks — navigation & integrity

- Clicking/tapping a wikilink navigates to the target note (desktop:
  Cmd/Ctrl+click opens it in a new tab). → NotesShell.svelte onopenlink
- A wikilink displays the **shortest unique path suffix** (`[[Projects/Roadmap]]`
  renders as "Roadmap" while unambiguous). The native shells feed the vault
  note list into the shared editor WebView over the bridge (`setNotes`), so
  the same resolver runs there (verified Android native + iOS simulator
  2026-06-09). → wikilinks.ts, packages/editor bridge v2,
  EditorWebView.kt / EditorWebView.swift
- Typing `[[` opens autocomplete over all note ids; selecting inserts the full
  path, **closes the `]]`, and drops the caret AFTER the link** (`[[Title]]|`)
  so typing continues past the link, not inside it (a bare change dispatch left
  the caret stranded after `[[`). Works on Tauri and both native shells (same
  embed; verified on emulator + simulator 2026-06-09; caret-after-`]]` verified
  emulator + simulator 2026-07-08). → wikilinkAutocomplete.ts `makeApply`
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
  → liveMarkdownTransform.ts, wikilinks.ts `resolveWikilink`,
  createNoteLoader.ts, editor-embed/main.ts
  > **Gap:** the **native** shells (iOS/Android) no-op a broken wikilink tap —
  > the editor embed posts `openNote` only for a _resolved_ link, so a broken
  > tap neither opens nor (on first edit) creates the target note the way
  > desktop does. _(native shells)_ → editor-embed/main.ts
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
  unfocused: on iOS `editorPointerInteractions` yields taps that
  land on a resolved wikilink or external link so the link handler acts on them,
  instead of consuming the tap to place the caret (a _broken_ wikilink still
  focuses, so it can be edited). Android has no such interceptor, so it already
  follows on the first tap (verified emulator 2026-07-08). Each pushed iOS
  editor needs an explicit `.id(noteId)` identity or SwiftUI would share one
  view's @State across the chain. Because the editor WebView is a single shared
  instance, iOS re-adopts it into whichever editor is visible on push/Back
  (`EditorContainerView.onEnterWindow`), and off-screen editors never drive it;
  Android composes only the top of the stack, so one note binds the WebView at
  a time by construction. Verified emulator + simulator 2026-07-08 (A → wikilink
  → B → Back returns to A with A's content intact and the editor still
  interactive; Back again returns to the list). →
  interactions/editorPointerInteractions.ts, MarkdownEditor.svelte,
  AppNavigation.kt `AppNavigator.openNote` (push),
  NoteEditorView.swift `openLinkedNote` + EditorWebView.swift `Coordinator.adopt`,
  tests/editor-embed-bridge.spec.ts
- Native Back and resolved-wikilink navigation wait for every admitted editor
  mutation, capture the latest live CM6 body, and persist-or-park a dirty
  snapshot through the Rust draft workflow before changing the navigation
  stack. A concurrent peer edit therefore keeps both versions instead of being
  overwritten. A failed commit keeps the same editor visible and dirty and
  surfaces the save failure. This includes a valid pending title whose Rust
  rename fails and, on iOS, an admitted image insertion: navigation waits for
  the insertion's CodeMirror transaction and deferred bridge callback before
  capturing. Android applies this to toolbar Back, system Back, and wikilinks;
  iOS uses its custom navigation Back and wikilinks. →
  `EditorNavigationCommit.kt`, `NoteEditorScreen.kt`,
  `EditorHost.captureCurrentContent`, `EditorCompletionQueue`,
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
  is detected via a dedicated `touchend` path in `editorPointerInteractions` (mirroring
  wikilinks — a click-only handler dead-ends on iOS WebKit) and the resolved URL
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
  → platform/openExternalUrl.ts, interactions/editorPointerInteractions.ts (`activateLink`),
  editor-embed/main.ts, packages/editor bridge v6 `openUrl`,
  EditorWebView.swift `openUrl` case, EditorWebView.kt `openExternalUrl` /
  `shouldOverrideUrlLoading` / `isInAppEditorNavigation`,
  tests/editor-embed-bridge.spec.ts
- Only the link's own glyphs open it: the hit test runs per visual-line fragment
  (`getClientRects()`), so clicking the blank space past the end of a link —
  including a link that wraps onto several visual lines, whose union bounding box
  spans that blank space — places the caret instead of opening the URL.
  → interactions/pointerHitTest.ts `findExternalLinkElementAtPoint`,
  tests/p1-regressions.spec.ts

## Interactive elements

- Tapping a task checkbox toggles `[ ]`/`[x]` in the source and autosaves —
  no cursor placement needed.
- Table cells are individually editable in place; Tab/Shift+Tab move between
  cells; Enter inserts a new row below the current one (so on the last row it
  appends); structure is revalidated on each edit. A cell context menu (desktop right-click) inserts/deletes rows/columns.
  → table/interactiveTableEditor.ts, table/tableEditorWidget.ts,
  table/tableOperations.ts
- Pressing Enter in a list item continues the list (inherits nesting, auto
  numbers ordered items, renumbers on edit); Backspace at item start dedents;
  Backspace in an empty item deletes it. → listContinuation.ts
- Undoing an edit that renumbered a list reverses the edit and the renumbering
  together, as one step. → orderedListRenumber.ts, listContinuation.test.ts
- Renumbering follows an edit, so merely opening a note leaves its numbering exactly as
  written — a hand-numbered `1. / 1. / 1.` list stays that way until you type in it.
  → orderedListRenumber.ts

  > **Gap:** on the **native** shells (iOS/Android) opening a note delivers its text as an
  > edit — a load, not an adopt — so a lazily-numbered note renumbers on screen straight
  > away. Nothing is posted back to the host, so the file on disk keeps its own numbering
  > until the next real keystroke, when the renumbered text is saved. _(native shells)_ →
  > editor-embed/createFutoEditorApi.ts `applyContent`

- Text that reaches the open note from outside it — a sync pull landing while you read,
  a host push of the note on screen — is adopted exactly as sent: renumbering and every
  other editing rule that rewrites what you type are skipped, so a peer's `1. / 1. / 1.`
  list is neither rewritten on screen nor saved and pushed back over theirs.
  → editorContentSync.ts `EXTERNAL_CONTENT_OPTS`, editorContentSync.test.ts
- Undo only ever reverses edits made in the note on screen — never text from another
  note — and opening a note is not itself something undo can reverse.
  → noteHistory.ts, tests/undo-history.spec.ts
- Each note keeps its own undo and redo while the app is running: leave a note, come
  back, and its undo still works, however quickly you switch. Only the notes visited
  most recently keep theirs; older ones, and every note after a restart, start empty.
  → noteHistory.ts, tests/undo-history.spec.ts

  > **Gap:** on the **native** shells (iOS/Android), leaving a note and returning to it
  > starts its undo empty, because the shells do not tell the editor which note they
  > are handing it. On **Android** only, opening a note that holds exactly the text
  > already on screen sends the editor nothing at all, so the previous note's undo
  > survives into it — one undo there can paste the other note's text in, and it is
  > then saved. Two empty notes in a row is the case users hit; iOS re-pushes on every
  > open, so it is unaffected. _(native shells)_ →
  > editor-embed/createFutoEditorApi.ts `setContent`, EditorWebView.kt
  > `lastPushedContent`

- A note that was edited elsewhere while you were away comes back without its undo
  history rather than with one that would restore text from before the change.
  → noteHistory.ts
- A change that arrives from outside the editor — a sync adopt, a host content push —
  is not something undo can reverse. Undo takes back your own keystrokes and stops at
  the incoming text, so it can never revive the version the change superseded and hand
  it to the autosave. → editorContentSync.ts `EXTERNAL_CONTENT_OPTS`,
  editorContentSync.test.ts
- Deleting a note discards its undo history. Renaming or moving a note keeps it, and
  renaming any other note leaves the open note's undo alone. → noteHistory.ts
- A desktop single-line selection raises a floating Bold, Italic, Strikethrough, Code, and Link
  toolbar; Link wraps the selection into a `[text](url)` scaffold with the caret in the URL slot
  and opens no dialog (shared `toggleLink` behavior, the same as the native toolbar). It hides for
  empty/multi-line selections and inside tables/code. Settings, search, and folder-dialog overlays
  always cover it. → selectionToolbar.ts, editorUX/linkCommand.ts,
  editor-selection-toolbar.css, tests/editor-ux.spec.ts
- Typing `/` at the start of an empty block opens a block-command menu
  (headings, lists, tasks, quote, code, table, HR). Arrow keys move the
  highlight; a menu item activates on BOTH mouse click and Enter — the item
  must commit on the press (`mousedown`), because WebKit cancels the `click`
  that follows the menu's focus-guard `preventDefault`ed mousedown (same
  dead-end as the wikilink `touchend` note above). → editorUX/slashMenu.ts
  _(desktop)_

## Markdown toolbar _(native shells / editor-embed fallback)_

The shipping toolbar surface belongs to the native shells. The Tauri desktop
shell never switches to a mobile layout or renders a mobile toolbar based on
viewport width. The standalone editor embed retains a web toolbar as a bridge
fallback, but iOS and Android call `setNativeToolbar(true)` and render native
toolbar chrome instead. → src/editor-embed/EmbedToolbar.svelte,
EditorWebView.swift, EditorWebView.kt

- When the editor body is focused, a formatting toolbar docks above the soft
  keyboard: Bold, Italic, Strikethrough, Link, Heading, Quote, Bullet/Ordered/Task
  list, Indent/Outdent (shown when the cursor is on a list line), Camera,
  Image — horizontally scrollable, with a collapse chevron that blurs the
  editor (dropping both the keyboard and the toolbar). Link wraps the selection
  as `[selected](url)` (or inserts an empty `[]()` scaffold) with the caret in
  the URL slot — it does NOT prompt, since `window.prompt` is a no-op in the
  native WebViews. Verified emulator + simulator 2026-07-08 (Link sits after
  Strikethrough; no-selection inserts `[]()`, a selection wraps to `[sel]()`
  with the caret in the URL slot; no dialog appears). → EmbedToolbar.svelte,
  markdownToolbar.ts `TOOLBAR_EXEC` `link`, editorUX/linkCommand.ts `toggleLink`,
  tests/editor-embed-bridge.spec.ts
- The toolbar SURFACE — items, order, grouping, accessibility labels,
  per-platform icons, visibility rules — is defined once in the
  `@futo-notes/editor` manifest, and the editing BEHAVIOR behind every
  button is defined once in markdownToolbar.ts (`TOOLBAR_EXEC`). Toolbars
  are dumb dispatchers: no platform restates the item list or reimplements
  a command. → packages/editor/src/toolbar.ts, src/features/editor/markdownToolbar.ts,
  tests/editor-embed-bridge.spec.ts
- A block-format command classifies each selected line as plain, bullet,
  ordered, task, heading, or quote, then emits exactly one block prefix after
  the line's existing indentation. Tapping Bullet, Ordered, Task, or Quote on
  the same kind removes it; tapping a different kind converts the whole prefix
  while preserving the line's text. Converting a checked task drops its
  checkbox state along with the task prefix. →
  src/features/editor/toolbar/blockFormatting.ts,
  src/features/editor/toolbar/blockFormatting.test.ts,
  tests/editor-embed-bridge.spec.ts
- Heading follows its own per-line cycle: a non-heading becomes h1, then h1 →
  h2 → h3 → plain. A multi-line selection applies that transition separately
  to each line, like the other block-format commands. →
  src/features/editor/toolbar/blockFormatting.ts,
  src/features/editor/toolbar/blockFormatting.test.ts
- Native shells, toolbar chrome is NATIVE, commands are shared (bridge v3):
  the host renders its own toolbar from a GENERATED copy of the manifest and
  drives the editor over the bridge — `exec(id)` runs the shared command,
  the `cursorContext` message drives Indent/Outdent visibility, `blur()`
  backs the dismiss chevron, and `setNativeToolbar(true)` suppresses the
  embed's web toolbar so two never show. `just toolbar-spec` regenerates the
  native specs; `just toolbar-spec-check` (part of `just check`) fails when
  one drifts from the manifest. → packages/editor/src/bridge.ts,
  scripts/gen-toolbar-spec.ts, tests/editor-embed-bridge.spec.ts
- iOS native: the toolbar is the keyboard's `inputAccessoryView` (generated
  ToolbarSpec.swift rendered by EditorToolbar.swift), replacing the stripped
  prev/next/Done bar — the system owns docking/animation with the keyboard.
  All buttons verified end-to-end on the iOS simulator 2026-06-10 (exec
  commands mutate the doc and autosave; Indent/Outdent appear only on list
  lines; pickers open natively; chevron blurs). → EditorToolbar.swift,
  EditorWebView.swift `futo_overrideInputAccessoryView`
- Android native: the toolbar is a Compose bar (generated ToolbarSpec.kt
  rendered by EditorToolbar.kt) docked above the soft keyboard via the editor
  screen's `imePadding`, shown only while the editor is focused (bridge
  `focus` message). All buttons verified end-to-end on the emulator
  2026-06-10 (exec commands mutate the doc and autosave; Indent/Outdent
  appear only on list lines; pickers open natively; chevron blurs, dropping
  keyboard + toolbar). → EditorToolbar.kt, NoteEditorScreen.kt,
  EditorWebView.kt `EditorHost`
- Android native: dismissing the soft keyboard by the system back
  gesture/button (not just the chevron) also blurs the editor — the caret
  and selection handle must not linger on screen with no keyboard (#24).
  The app-root `ClearFocusOnImeDismiss` ([app.md](app.md) "Soft keyboard")
  drops native-field focus, and its root install also blurs the editor over
  the bridge on the same IME visible→hidden transition — the editor's DOM
  caret survives a view-level clearFocus. (iOS can't hit this: keyboard and
  first-responder caret are coupled.) → MainActivity.kt,
  ui/components/ImeDismiss.kt, EditorImeDismissBlurTest.kt
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
  derives the geometry from `onScrollGeometryChange`; Android from
  `onGloballyPositioned` (`positionInWindow`) + a measure-tick. → EditorToolbar.swift
  `computeSnap`, EditorToolbar.kt `computeToolbarSnapPx`
- Camera inserts a photo from the device camera or photo library; Image opens
  a file picker. Both save the image into the vault and insert `![](file)`.
  On the native shells the toolbar's Camera/Image buttons reach the host
  picker (web toolbar posts `pickImage`; the native iOS/Android toolbars
  invoke it directly), which presents the native picker (Photo Picker / camera intent
  on Android; PHPicker on iOS, camera falling back to the library on the
  simulator), saves the bytes into the vault root under a generated
  space-free name, and calls `insertImage` back into the embed.

## Images

- Pasting an image into the editor (desktop) saves it to the notes directory
  and inserts `![](filename)`; supported types follow
  `@futo-notes/editor` `IMAGE_EXTENSIONS`, conformance-locked to the canonical
  Rust vault rule. Native Swift/Kotlin pickers receive that Rust list through
  generated UniFFI bindings. Both clipboard shapes work: a raw
  bitmap (OS screenshot-to-clipboard) and a browser **Copy Image** (which the
  source app puts on the clipboard as an `<img>` `text/html` fragment plus a
  bitmap). When the paste event exposes an image file it is saved directly;
  otherwise the bitmap is read from the OS clipboard via the
  `fs_paste_clipboard_image` Tauri command. This native fallback is required on
  Linux/Wayland, where WebKitGTK hides the clipboard image from the JS paste
  event — a screenshot arrives with empty `items`, and a Copy Image arrives as
  a lone `text/html` item — so the gate is "no image file found and no
  `text/plain` to paste" (plain/rich-text pastes are left untouched).
  Verified on Linux (WebKitGTK) and Windows (WebView2), both image types,
  2026-06-22. → imagePaste.ts `handlePasteEvent` / `looksLikeImagePaste` /
  `pasteFromNativeClipboard`;
  `apps/tauri/src-tauri/src/image_commands.rs` `fs_paste_clipboard_image`
- Images render inline in live preview via the Tauri asset protocol, with a
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
  live-preview/images.ts `setLocalImageBaseUrl`, tests/editor-embed-bridge.spec.ts
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
  v5) and the host reads the image off the native clipboard. → editor-embed/main.ts
  `handleNativeImagePaste`, bridge.ts `SaveImageDataMessage` /
  `PasteClipboardImageMessage` (contract v5), EditorWebView.kt + ImagePicker.kt
  `saveImageDataIntoVault` (Android), EditorWebView.swift `saveImageData` +
  `clipboardImageData` + EditorImages.swift `VaultImages.save` (iOS),
  fs_paste_clipboard_image (Tauri), tests/editor-embed-bridge.spec.ts
- A delayed native picker/clipboard completion belongs to the editor attachment
  generation that started it. Detaching, deleting, or adopting another note
  invalidates the completion, so it cannot insert Markdown into a different
  note. Android holds both the editor mutation permit and vault gate through
  confirmed WebView insertion, and cancellation cannot leave a queued main-
  thread insertion behind; iOS checks the adopted WebView generation before
  and after inserting, increments that generation on detach, queues every image
  completion, and drains the queue through the editor's next animation frame
  before a navigation capture. It removes a just-saved image when its attachment
  became stale before insertion. →
  `EditorAttachmentGate.kt`, `EditorWebView.insertImageAndWait`,
  `EditorHost.detach`, `EditorCompletionQueue`, `VaultImages.remove`

> **Gap:** Clipboard image paste is verified on Linux (WebKitGTK), Windows
> (WebView2), native Android (emulator, 2026-06-22), and **macOS desktop**
> (Tauri/WKWebView — real clipboard image + real Cmd+V through the
> `looksLikeImagePaste` → `fs_paste_clipboard_image` fallback, verified in the
> 2026-07-02 full-spec QA pass). The iOS path is wired both ways: the embed
> posts `saveImageData` when WKWebView exposes the pasted image File, and falls
> back to the payload-less `pasteClipboardImage` (bridge contract v5) when
> WKWebView hides the bitmap — EditorWebView.swift's `clipboardImageData()`
> then reads it off `UIPasteboard.general` (raw png/jpeg, else UIImage→PNG) and
> saves through `VaultImages.save`, the SAME vault path as the picker. Compiles
> clean (`just build-ios-native`). What remains is on-device end-to-end QA on
> **native iOS only**: copy a screenshot / "Copy Image", paste into the editor,
> confirm a vault blob + `![](image-…)` insert. (bridge added 2026-06-26)

## Code / fence isolation

- Wikilinks and tags inside inline code or fenced blocks are NOT decorated and
  NOT extracted. → markdown-spec/cases/03-code, 08-wikilinks, 09-tags

## Performance

- Per-keystroke editor work is bounded by the viewport plus a small margin,
  never by document size: live-preview decorations scan only
  `view.visibleRanges` and markdown parsing is forced only to
  `viewport.to + 5000` chars. Typing dispatch stays within one 60fps frame
  (median ≤ 16.7 ms, measured in the desktop app, 2026-07) in
  multi-thousand-line notes. `tests/typing-perf.spec.ts` (E2E suite) guards
  the regression class, not that number: it asserts the median hook-driven
  keystroke in a ~32k-block note stays ≤ 60 ms — a bound sized to fail an
  O(document) decoration scan (~700 ms measured), with the measurement
  including the test hook's full-document read-back. Reaching a
  not-yet-parsed region (e.g. jumping straight to the end of a large note)
  parses the intervening document incrementally in ≤ 200 ms slices — amortized
  once per region, decorations may arrive a beat late; steady-state scrolling
  through parsed text stays viewport-bounded. → LiveMarkdownPlugin.ts,
  buildLiveMarkdownDecorations.ts, viewportScanRanges.ts,
  tests/typing-perf.spec.ts
- Per-keystroke work does not scale with the number of links on screen times the
  vault. Rendering a wikilink needs the whole note-id list twice — once to resolve
  the target, once for the shortest unique display suffix — so both go through one
  index (`getWikilinkIndex`), never per link; `[[` completion shares it. In the
  desktop app a 300-line note with a wikilink per line types at 2.5 ms/keystroke
  against an 8,000-note vault, against 41 ms when each link scanned the list
  itself. The index is rebuilt whole whenever the note list changes, which a save
  mid-typing does, so the keystroke after an autosave pays one pass over the whole
  vault — tens of ms at 8,000 ids and over 100 ms at 50,000 in a Node
  microbenchmark of the build alone, never measured in a shipped engine, so treat
  those as a floor: a very large vault pays a real hitch there, and profiling it
  against these numbers will mislead. → wikilinks.ts, notes.svelte.ts,
  live-preview/wikilinkDecorations.test.ts
- One large insertion (a paste) costs time proportional to the pasted size, not its
  square — in FUTO Notes' own paste work; a paste landing in one giant markdown leaf
  is still quadratic upstream, per the Gap below. The worst shape for our own work
  is a pasted numbered list whose numbers are all wrong (a list of `1.` items),
  because renumbering it is one edit per item; three paths
  scaled with that count and are all bounded now — block-start resolution walks in
  ascending line order and stops where the previous walk landed; table block
  expansion skips a change already inside the last expanded block, testing that
  against the parse ceiling it clamps to rather than raw offsets, because the ceiling
  is the tree's length and CM6 parses on a time budget — past an unfinished parse
  every change expands to the one block ending at the ceiling, so raw offsets place
  them all outside it and restore the per-change walk on exactly the slow machines
  that can least afford it; and the renumber
  dispatches one change per list block rather than per item, which is ~1.7x faster
  on desktop at 5,000 items (79 ms → 46 ms; the caret is mapped explicitly so
  merging cannot collapse it to a span edge). In the desktop app a
  16,000-item list paste measures ~150 ms, 8,000 items went from 4,466 ms to
  ~100 ms, and cost no longer varies with how many numbers are wrong. Chromium —
  the only engine the Playwright suite runs — is flat to 16,000 items (2026-08-05).
  `tests/paste-perf.spec.ts` compares the same paste at 1,250 and 5,000 items and
  bounds the RATIO (~1.1x after, 14.6x before) rather than a duration, because a
  busy machine inflates both sizes alike but only a quadratic inflates the ratio;
  the sharp guards are bounds on line reads and on change-range count in
  `listContinuation.test.ts` and `table/interactiveTableEditor.test.ts`. A read-count
  bound is only machine-independent if the tree it runs against is pinned: the
  table guard pins a deliberately short tree, because measuring the fully-parsed
  path alone passes on a fast machine whether the ceiling is handled or not.
  Measure a paste with a real paste event: CDP `Input.insertText`
  (`page.keyboard.insertText`) splits a multi-line insertion into quadratically many
  browser editing operations and is quadratic even against a bare `contenteditable`
  carrying no application code, so it measures the harness, not the editor (M21).
  → orderedListRenumber.ts, table/interactiveTableEditor.ts, tests/paste-perf.spec.ts
- Interactive table decoration updates are incremental: syntax discovery scans
  only changed/affected parsed blocks, while offset refresh work is bounded by
  the number of known tables. → table/interactiveTableEditor.ts,
  table/interactiveTableEditor.test.ts
  > **Gap:** a note whose text forms one giant markdown _leaf_ — tens of KB
  > with no blank line, e.g. a 3000-line contiguous blockquote, one huge
  > paragraph, or a single ~500 KB line — still types at ~30–50 ms/keystroke
  > (grows with leaf size; ~240 ms at 1.2 MB). Root cause is upstream:
  > `@lezer/markdown` re-runs inline parsing (`parseInline`/`LinkEnd`) over
  > the entire leaf on each edit, as one uninterruptible step CM6's parse
  > budget cannot preempt (CPU-profile attributed, 2026-07-29). This is an
  > ecosystem-wide CM6/lezer characteristic — Obsidian exhibits the same
  > class of large-note typing lag — not FUTO Notes code. Candidate future
  > fix: a lezer block-parser extension splitting leaves every ~32 KB
  > (VS Code-style bounded tokenization). Repro: open a note that is one giant
  > contiguous block (e.g. a 3000-line blockquote with no blank lines) in
  > `just tauri-dev` and type. The same upstream stack is also quadratic on a
  > single large **paste** into one block, because `cx.parts` — the inline
  > delimiter stack `LinkEnd` and `resolveMarkers` rescan per delimiter — is
  > reset per block and so grows with the paste. It scales with delimiters, not
  > lines, so quote the density: 16,000 lines with no blank line between them,
  > pasted into Chromium, cost ~1.3 s at **two** wikilinks per line
  > (`see [[a i]] and [[b i]]`) but only ~357 ms at one, against ~37 ms for the
  > identical text with a blank line after each line — so 37x at two links,
  > 9x at one. `[`-dense text is worse still (~2.1 s for three bracket pairs a
  > line); inline links ~262 ms, `**`/`~~` emphasis ~84 ms, plain prose ~55 ms.
  > A CPU profile attributes 628 ms of 790 ms self time to `LinkEnd`. Footnotes
  > and reference links share the cause; lists, tasks, tables, images, fenced
  > code, blockquotes, and one 857 KB newline-free line are all flat.
  > FUTO Notes' own paste work is proportional (see the paste bullet above).

## Saving & rename

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
  instead of letting the parent route pop early; after its final CM6 capture it
  also commits a valid visible title immediately rather than waiting for the
  rename debounce. The iOS move captures the final live CM6 document
  after destination selection, persists or parks it through the draft workflow,
  and moves the parked conflict identity when that is where the local draft was
  committed. _(iOS, Android)_ → `NotesStore.write`,
  NoteEditorScreen.kt / NoteEditorView.swift,
  NativeMutationOutcomeTest / NativeMutationOutcomeTests
- Title edits debounce (~500 ms) into a rename (iOS commits via the rename
  dialog instead). Before the file moves, any pending body save is flushed to
  the _current_ id and the in-flight save is cancelled — otherwise a stale save
  recreates a ghost note at the old id (data loss). → NoteEditorScreen.kt /
  NoteEditorView.swift `commitRename`
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
  captures, or the capture races the write it supersedes. _(iOS/Android)_
- The body an exit commits is the **exact snapshot it captured** — never a
  re-read of disk, and never an earlier buffer than the one the capture returned.
  The single exception is specified below: on a destructive exit a change that
  lands mid-exit is folded in, because it is newer than the capture.
  _(iOS/Android)_
- An exit that cannot commit does not leave: a failed capture, a failed body
  flush, or a pending rename that will not commit refuses the exit, releases
  every latch that exit set, and reports which step failed so the shell can word
  the message. A failed delete un-latches so the editor stays usable, and a
  failed draft write never deletes. _(iOS/Android)_
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

Three **permitted** divergences — each shell keeps its own sequence; the shared
invariant above is what both must satisfy:

- Navigation commit order: Android commits the body, then the title; iOS commits
  the title (the rename), then the body. Both commit both before the file moves,
  so neither can strand a body at a dead id. _(iOS/Android)_
- Where the committed body comes from: iOS captures out of the WebView on every
  committing exit; Android round-trips the WebView for navigation and uses the
  live content buffer for move and delete. Coupled to the quarantine gap below —
  revisit the capture source when Android gains one. _(iOS/Android)_
- Move-picker timing: iOS drains before presenting the destination picker (its
  own `prepareMove` exit); Android presents immediately and drains in `onPick`.
  Both complete the drain before the move commits. _(iOS/Android)_

Two divergences are **not** permitted — each is one shell failing the invariant,
left open because closing it is a behavior change, not a refactor:

- On a parked-conflict flush the editor follows the parked id, so it never stays
  pointed at an id whose disk content is now the peer's version.
  > **Gap (iOS):** on the navigation exit iOS ignores a parked-conflict
  > disposition — the engine parks the draft as a conflict copy and the editor
  > stays on the original id, whose content on disk is now the peer's version.
  > Only the move exit follows the parked id (`editorMoveSourceId`). Android
  > re-keys the open note on navigation too. Observed 2026-08-01 reading both
  > shells' exits side by side; → issue #79.
- An editor change that arrives after a destructive exit has latched is
  quarantined and folded into the final commit, never dropped: a committed delete
  discards it, a failed delete restores it.
  > **Gap (Android):** an editor change that lands after the destructive latch is
  > DROPPED on Android — `acceptsEditorChange` returns false once closed and
  > there is no quarantine buffer, so a keystroke inside the delete window is
  > lost when that delete then fails. iOS quarantines it, folds it into the
  > commit, and hands it back on failure. Observed 2026-08-01; → issue #80.

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
    in the gitignored generated Tauri-Android tree, which is no longer generated;
    the only surviving artifact is the `WRY_RUSTWEBVIEW_CLASS_EXTENSION` override
    in `apps/tauri/src-tauri/.cargo/config.toml`, still marked DO-NOT-REMOVE for
    the Tauri-Android build path.)
- Typing must be free of IME/caret glitches on every WebView the editor runs in.
  _(Android)_
  > **Gap:** on some old Android System WebViews (the Chromium 80–98 tier that
  > runs the editor but predates `@layer`), users report the shift key re-arming
  > after each character and the caret jumping to the start of the line, so words
  > land in reverse order with no spaces between them (github#8, github#33).
  > Unreproduced after two passes on Android 11 / Chromium 83 with FUTO Keyboard
  > 0.1.29.1. Exercised there and correct: tapped-key composition, fast-burst
  > typing, real glide typing, typing 9k characters into a virtualized document,
  > a composition interrupted mid-flight, and the selection toolbar's Select all
  > (whole document deleted, no leftovers). The third symptom reported alongside
  > these — content scrolling out of view while typing — WAS reproduced and is
  > fixed (the collapsed height chain above); rerunning every input path with that
  > layout deliberately reinjected still typed correctly, so it is not upstream of
  > these two.
  >
  > **The offsets Chromium reports to the IME are relative to the start of
  > CodeMirror's contiguous rendered block, not the document — never read one as a
  > note position.** A caret at document offset 2,748 was reported as 503, its
  > distance from the first rendered line exactly. So the base moves as the note
  > scrolls: caret pinned at line-148, changing only `scrollTop`, the reported
  > cursor went 1,175 → 0 once line-148 became the first rendered line. From the
  > IME's side that IS "the caret jumped to the start". It re-bases mid-composition
  > too, not only between words — and it still misplaces nothing (160 keystrokes,
  > four arms, zero split edits), because Blink maps back and ships a matching text
  > window. A precondition, demonstrated; the corruption, not.
  >
  > What produces the exact signature is a whole-document `setContent` landing
  > mid-typing: it replaces the document with `preserveSelection: false`,
  > CodeMirror maps the caret to 0, and the next word lands at the HEAD of the
  > note, capitalized and unspaced, because the IME now sees start-of-field.
  > Engine-independent. Locked by tests in editorContentSync.test.ts rather than
  > by a device run. **But the code trace says no user can reach it**:
  > `preserveSelection: false` has exactly ONE call site in the repo — the bridge's
  > own `FutoEditor.setContent` — so desktop cannot reach it at all, and on Android
  > all three `host.setContent` sites are guarded (the `lastPushedContent` dedupe,
  > page boot, and a renderer rebuild that lands in a fresh page with no live
  > caret). A sync adopt is exempt by construction: it goes through
  > `applyExternalContent`, which preserves the selection. It was provoked from a
  > debugger, which bypasses those gates. Weakest remaining point, unproven: while
  > a storage migration is latched, `acceptsEditorChange` drops editor changes, so
  > Compose `content` and `lastPushedContent` freeze at the pre-migration text
  > while the live document diverges — the invariant the dedupe rests on is
  > deliberately broken there, and any write to `content` inside that window would
  > push a caret-destroying `setContent` into a document being edited. No such
  > write was found.
  >
  > Two traps for a re-test. The broken build only oscillates when the caret is FAR
  > from the scroll position; near it, or at the document end, the same build on
  > the same note moves the window zero times and looks calm. And do not score
  > placement by diffing typed text against the document — autocorrect rewrites
  > words, so a naive comparison reads as corruption; use
  > `tests/lib/android/editPlacement.mjs`. Untested: Android 10 (API 29) with a
  > Chromium ≥80 WebView (the stock AOSP image ships Chromium 74, below the
  > editor's floor, so this needs a physical device or a platform-signed WebView
  > APK), FUTO Keyboard 1.30 as the reporter runs, and Chromium 80–82 / 84–86. Ask
  > a reporter to re-test on a build carrying the height-chain fix before spending
  > more here.
