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
