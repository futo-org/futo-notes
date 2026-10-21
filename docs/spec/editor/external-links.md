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
  missing-bundle fallback; `http/https/mailto/tel` navigations are canceled and
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

- Only a bare URL links as you type. Link syntax typed by hand (`[text](url)`,
  `<url>`) is not a bare URL: it stays the text it was typed as, and is saved
  so it reopens as that same text. → src/features/editor/milkdown/autolink.ts
  `firstLiteral`, tests/editor-embed-milkdown-parity.spec.ts
