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

## Cursor

- **Tapping in the editor places the cursor at the tapped character** — not the
  start/end of the line or document. → MarkdownEditor.svelte
- **A tap past the end of a line's text lands at the end of the tapped VISUAL
  row.** A wrapped line is one markdown line across several rows, and its
  `line.to` is the end of the LAST row: snapping there dropped the caret a row
  below the tap, right after the engine had placed it correctly. On the row that
  carries the line's end the answer IS `line.to`, because hidden trailing markers
  (a wikilink's `]]`) stop the rendered row short of the source it stands for.
  → interactions/caretInteractions.ts `rowEndAt`, tests/editor-ux.spec.ts,
  tests/wikilinks.spec.ts
- **A resolved caret carries its row.** A wrap point is ONE position the caret can
  be drawn in two places — the end of a row or the start of the next — and only
  the association distinguishes them; the tap's own y picks. Every path that
  places a caret from a pointer dispatches that association rather than a bare
  offset, or the caret appears one row below an otherwise correct tap. This bit
  a tap on an UNFOCUSED editor long after the focused path was right, and again
  the blank space beside a wrapped row, because each resolves through a different
  handler — the rule holds only where every one of them applies it.
  → interactions/caretRow.ts `cursorOnTappedRow`, interactions/caretInteractions.ts,
  interactions/blankSpaceCaret.ts, iosTapFocus.ts, MarkdownEditor.svelte `setCaret`,
  interactions/caretInteractions.test.ts
- **Tapping the blank space around a note reaches into it.** The note's tappable
  surface is the text plus two line-heights to either side and below it, and
  upward it takes in the whole tag bar — the bar's slack is part of the surface,
  while its pills, buttons and input keep their own taps. The title row is
  outside. → NoteWorkspace.svelte `handleBlankSpaceMouseDown`,
  interactions/blankSpaceCaret.ts `resolveBlankSpaceCaret`, tests/editor-ux.spec.ts
- Inside that surface the caret goes to the **nearest position in the text**:
  left of a line → its start, right of it → its end, and below the last line →
  whatever the same tap would have hit ON that line, so the column under the
  pointer picks the character. A tap above the text reaches the first VISIBLE
  line, never a hidden header tag block — the caret would reveal its markup.
- Past the surface the directions differ. **Below** the note is still the note:
  the tap lands at its end. **Out to either side** is a tap away from it: the
  caret stays where it was. The side edge is one straight line at every height,
  so the surface is a rectangle rather than an L.
- **Reaching also hands the editor focus; tapping off takes it away.** Inside the
  surface the caret moves AND the editor focuses, so the note is ready to type
  into — being able to type is the whole point of reaching. Outside it the editor
  gives up focus and the caret stays put, so the note reads as deselected rather
  than half-selected. → tests/editor-ux.spec.ts
- Only a **primary (left) press** reaches. Any other button leaves the caret where
  it is, so a right-press in the blank space opens the platform menu without
  dragging the cursor along first. A modified tap (Shift/Alt/Cmd/Ctrl) is likewise
  a selection gesture, left to the platform, and a note that is nothing but a
  hidden tag block has no reachable position at all — a tap in it must not land in
  the markup. → NoteWorkspace.svelte `handleBlankSpaceMouseDown`
  > **Gap:** the native shells have no reach rules of their own. Their blank space
  > below the text is INSIDE the contenteditable (editor.html's `.cm-content
{ min-height: 100% }`), so the engine resolves those taps: there is no
  > two-line boundary and no click-off zone, at any distance. The reach rules
  > above are desktop/web only. _(native shells)_
- The first tap that opens the editor resolves the tapped CM line on `touchend`,
  focuses with `preventScroll`, then sets the selection — it must NOT use the
  native contenteditable tap-focus path, which scroll-jumps the whole app during
  keyboard presentation. → docs/learnings/ios-keyboard-editor-jump.md _(iOS)_
  > **Gap:** a first tap that resolves to NO CM line — the blank space below the
  > text, which on the native shells is inside the contenteditable — has no
  > position to set, so `iosTapFocus` declines and that native tap-focus path runs
  > after all. Certain from the gating (`getLineHitAtPoint` finds no `.cm-line`,
  > so `resolveTapPositionAt` answers null); whether the scroll-jump actually
  > follows is NOT verified on device. Predates the reach work. _(iOS)_
- **Tapping an UNFOCUSED editor places the caret at the tap AND raises the
  keyboard** — on refocus, WebKit and Blink restore the selection saved at
  blur (e.g. the header the cursor was on when the keyboard was dismissed,
  #24). The mechanism differs per engine: iOS intercepts the touchend
  (`iosTapFocus`, also dodging WKWebView's tap-focus scroll-jump); Android
  must let the NATIVE tap run — preventDefault-ing it suppresses the IME for
  a JS focus — and re-places the caret on click
  (`mobileTapCaretCorrection`, which also fixes Android Chrome dropping to
  position 0 on empty/widget lines — that fallback bites even while focused,
  so Android corrects every single tap that lands ON a line; iOS focused taps
  are left to WebKit's native placement). A tap that lands on NO line — the
  blank space below the text — has no answer to correct to, and the engine's
  own placement stands: answering "end of the document" there discarded the
  column the engine had resolved from the same tap, and the caret then walked
  between the two answers on alternate taps. The correction is anchored on the
  host-asserted
  `nativeShell` prop, never a UA-sniffed flag alone — pinned-false flags
  silently disabled tap paths in the native embeds twice. On a WRAPPED line
  the tap resolves within the tapped visual row (the tap's own y, clamped
  into the line box — never the line-rect midpoint, which yanked the caret
  to the middle row and made repeated corrective taps read as
  double/triple-tap selections). Double/triple-tap word/line selection stays
  native on both shells. → src/features/editor/iosTapFocus.ts, MarkdownEditor.svelte
- Arrow up/down on a wrapped line moves by visual row, not logical line.
  Arrowing past a block widget (HR) lands in the adjacent paragraph, not inside
  the widget. → markdown-spec/cases/10-cursor-reveal
- Pressing Enter in a continued list item scrolls the new item into view (don't
  bypass CM's `scrollIntoView`). → docs/learnings/ios-keyboard-editor-jump.md
  _(iOS)_
- Text selection is the platform's native selection. On the native shells the
  system owns it entirely (loupe, grab handles, callout) — the editor never
  re-dispatches or "snaps" the selection, so it must not fight the native
  handles. On desktop ONLY, a mouse drag-select that covers the visible content
  of a markdown element whose source markers are hidden snaps outward through
  those markers so copy/delete carry valid markdown; the pointer-selection
  listeners are disabled whenever `nativeShell` identifies the native embed.
  Verified on Android and iOS devices 2026-07-10.
  → MarkdownEditor.svelte (pointer-selection gate) _(native shells / desktop snap)_

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
- A blockquote line's content starts at a fixed x-offset that depends only on
  its nesting depth: every `>` marker occupies a constant-width gutter, so
  `> text` and `>text` land at the same x, each extra depth adds exactly one
  more gutter, and revealing the marker under the caret never shifts the line's
  content sideways. Each nesting level paints its own 2px stripe at the left
  edge of its gutter. → src/styles/markdown-blocks.css
  `--md-quote-marker-gutter`, tests/blockquote-gutter.spec.ts
- Lists: ordered, unordered, nested, and task checkboxes (checked / unchecked /
  uppercase `X`).
- Tapping/clicking a bullet or number marker places the caret at the marker
  (revealing the dimmed `-`/`N.` source — the same state as arrowing onto
  it); a marker tap must never be a no-op. The markers are
  contenteditable=false widget spans, so the browser can't place a caret in
  them and CM's default `ignoreEvent() === true` would swallow the tap —
  both marker widgets return `false` (same contract as the HR widget).
  Checkbox and image widgets intentionally keep `true` + their own handlers
  (toggle / place-at-line-end). → live-preview/listDecorations.ts
  BulletWidget/NumberWidget, liveMarkdownTransform.decorations.test.ts
- A list item that wraps does **not** hanging-indent its continuation lines:
  wrapped lines start at the left margin — only the first visual line carries
  the nesting indent + marker. Applies to bullets, ordered items, and task
  items at every nesting depth, on every platform (spec decision 2026-06-10;
  wrapped text previously aligned under the first line's text). →
  live-preview/listDecorations.ts `cm-md-list-line` decorations
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
  unfocused: on iOS the tap-to-focus handler (`iosTapFocus`) yields taps that
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
  interactive; Back again returns to the list). → MarkdownEditor.svelte
  `wikilinkClickHandler`, AppNavigation.kt `AppNavigator.openNote` (push),
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
  is detected via a dedicated `touchend` path in `linkClickHandler` (mirroring
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
  → platform/openExternalUrl.ts, MarkdownEditor.svelte `linkClickHandler` (`onopenurl`),
  editor-embed/main.ts, packages/editor bridge v6 `openUrl`,
  EditorWebView.swift `openUrl` case, EditorWebView.kt `openExternalUrl` /
  `shouldOverrideUrlLoading` / `isInAppEditorNavigation`,
  tests/editor-embed-bridge.spec.ts
- Only the link's own glyphs open it: the hit test runs per visual-line fragment
  (`getClientRects()`), so clicking the blank space past the end of a link —
  including a link that wraps onto several visual lines, whose union bounding box
  spans that blank space — places the caret instead of opening the URL.
  → interactions/linkInteractions.ts `findExternalLinkElementAtPoint`,
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

  > **Gap:** on the **native** shells (iOS/Android) the note text arrives as an edit, so
  > opening a lazily-numbered note renumbers it on screen straight away. Nothing is
  > posted back to the host, so the file on disk keeps its own numbering until the next
  > real keystroke, when the renumbered text is saved. _(native shells)_ →
  > editor-embed/createFutoEditorApi.ts `applyContent`
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
  > after each character, the caret jumping to the start of the line after the
  > first character, and content scrolling out of view while typing (github#8).
  > These are CM6-on-old-engine input limitations. They did **not** reproduce on
  > the Chromium-83 emulator even with FUTO Keyboard as the IME (per-keystroke,
  > fast-burst, and glide typing all behaved), so the cause is likely
  > physical-device IME timing or a specific WebView build. Unaddressed — the
  > legacy-WebView work fixes the black-text half and the sub-floor blank-editor
  > case, not these input glitches.
