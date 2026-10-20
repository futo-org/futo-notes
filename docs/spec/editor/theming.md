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
  tests/editor-embed-webview-floor-css.spec.ts (legacy WebView tests)
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
  tests/editor-embed-webview-floor-css.spec.ts (engine preflight tests)
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
