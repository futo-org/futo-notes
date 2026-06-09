# @futo-notes/editor

The embedded markdown editor — the **one** CodeMirror 6 / Svelte editor bundle
(`editor.html`) hosted by all three runtimes (Tauri desktop, native iOS, native
Android) — plus the **versioned `futoBridge` contract** they all depend on.

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
the iOS host wires it in `apps/ios/Sources/EditorWebView.swift`.
Android (Phase 4) and Tauri reuse the identical contract.

## The bundle — `editor.html`

`editor.html` is built into a **single self-contained HTML file** (all JS/CSS
inlined) so a WKWebView / Android WebView can load it without module-loading or
`file://` restrictions:

```bash
# From the repo root:
pnpm exec vite build --config vite.editor.config.ts
# → apps/ios/Resources/editor.html
```

`vite.editor.config.ts` still lives at the repo root (it shares the root
`src/` and Tailwind setup). Formalizing the full build pipeline into this
package — and pointing every host at one checksum-verified artifact — is
tracked for Phase 4 (Android), per the migration plan §9.

## Test

```bash
pnpm --filter @futo-notes/editor test
```
