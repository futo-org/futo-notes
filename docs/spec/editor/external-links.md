## External links

- Tapping/clicking an external link (`http(s)://`, autolinks, bare URLs) opens
  it in the system browser, never inside the editor. On the native shells a tap
  is detected via a dedicated `touchend` path (mirroring wikilinks — a
  click-only handler dead-ends on iOS WebKit) and the resolved URL
  is posted to the host via the `openUrl` bridge message (bridge v6); the host
  opens it in the system browser (iOS `UIApplication.open`, Android
  `ACTION_VIEW`), scheme-guarded to `http/https/mailto/tel` (iOS also `sms`, below). `window.open` is a
  no-op inside a WKWebView, which is why the bridge round-trip is required.
  Android additionally enforces in `EditorWebView.kt` that only `file://` editor
  assets may load in the reused WebView; all other schemes are intercepted and
  launched with `ACTION_VIEW`. iOS enforces the same policy in
  `EditorWebView.swift`'s `decidePolicyFor` (added 2026-07-30): main-frame loads
  are allowed only for the bundled `editor.html` itself (exact standardized-path
  match — any other `file://` URL is denied, since `loadFileURL` grants read
  access to the whole bundle resources directory) and the `about:blank`
  missing-bundle fallback; `http/https/mailto/tel/sms` navigations are canceled and
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

  > **Gap:** _(Android, desktop)_ the iOS guard (`editorNavigationDecision`, also used by the
  > native text-first editor's link taps) opens `sms:` links, matching the engine's link rule
  > (`http`, `https`, `mailto`, `tel`, `sms`); Android's `openExternalUrl` in
  > `EditorHostCommands.kt` and the desktop dev opener (`dev_open_url.rs`) still deny `sms:`.
  > The set is pinned on iOS in `TextFirstLinkTests.swift`.

- Only the link's own glyphs open it: the hit is the anchor element under the
  pointer, so clicking the blank space past the end of a link — including a link
  that wraps onto several visual lines — places the caret instead of opening the
  URL. → src/features/editor/milkdown/linkTaps.ts `linkAt`

- Typing a bare URL links it the moment its word ends — Space or Enter — with
  exactly the extent and href reopening the note would give
  it (GFM's autolink literal: trailing punctuation left out, `http://` added
  for `www.`), because the word is read by the editor's own markdown parser;
  the link is applied only when the save writes it so the next open reads back
  the same text and the same link. A URL holding markdown punctuation
  (`…/Rust_(programming_language)`, `/~user`, `?q=a*b`) links and saves bare.
  A URL inside inline code or a code block stays text. The note keeps the URL
  as typed: a bare URL is saved bare, not as `<url>` or `[www.…](http://…)`,
  and editing a note leaves the bare URLs already in it bare, unless a bare
  spelling would not read back as the same link. →
  src/features/editor/milkdown/autolink.ts,
  packages/editor/src/markdown/inline.ts,
  tests/editor-embed-milkdown-parity.spec.ts

- Link syntax typed by hand (`[text](url)`, `<url>`) does not become a link
  of its own: it stays the text it was typed as. The URL spelled inside it
  links as its word ends, with the href typed, and reopens the same — typed
  `[t](https://x.test)` keeps `[t](` and `)` as text around a link to
  `https://x.test`; typed `<https://x.test>` keeps its brackets as text around
  a link to `https://x.test` (saved `<<https://x.test>>`). →
  src/features/editor/milkdown/autolink.ts,
  tests/editor-embed-milkdown-parity.spec.ts

- The portable replacement core preserves canonical link meaning, exact source and transient input lifetimes through correction, Code, structural commands, own-action relinks and saving; its source contract is [link editing and source ownership](portable-core/links.md). Shipping renderer activation and external-open guards remain the contract above until cutover. → crates/futo-notes-editor/src/inline/links.rs, crates/futo-notes-ffi/src/editor/links.rs
