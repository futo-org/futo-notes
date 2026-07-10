# @futo-notes/editor

The shared markdown editor code and the native embed contract.

Desktop Tauri consumes the editor as Svelte/TypeScript source and mounts
`MarkdownEditor.svelte` directly. Native iOS and Android load the generated
`editor.html` bundle in a WebView and drive it through the versioned
`futoBridge` contract.

Consumed as TypeScript source (no build step), like `@futo-notes/shared`.
Path alias: `@futo-notes/editor` → `packages/editor/src`.

## The bridge contract — `src/bridge.ts`

`bridge.ts` is the single source of truth for the editor ↔ host interface:

- `FutoEditorApi` — the `window.FutoEditor` surface hosts call into
  (`setContent` / `getContent` / `focus` / `setTheme`).
- `FutoEditorOutboundMessage` — the discriminated union the editor posts back
  to the host's `futoBridge` sink (`ready` / `change` / `focus`).
- `BRIDGE_VERSION` — bump on any breaking change; the `ready` message carries
  it so a host can refuse a bundle it doesn't understand.

The editor entry point (`src/editor-embed/main.ts`) implements this contract;
the native hosts wire it in `apps/ios/Sources/EditorWebView.swift` and
`apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt`.

## The bundle — `editor.html`

`editor.html` is built into a **single self-contained HTML file** (all JS/CSS
inlined) so a WKWebView / Android WebView can load it without module-loading or
`file://` restrictions:

```bash
# From the repo root:
just build-ios-native      # builds apps/ios/Resources/editor.html
just build-android-native  # also stages it into apps/android/app/src/main/assets/
```

`vite.editor.config.ts` still lives at the repo root (it shares the root
`src/` and Tailwind setup). The native `just` recipes regenerate the bundle
before compiling their shells.

## Test

```bash
pnpm --filter @futo-notes/editor test
```
