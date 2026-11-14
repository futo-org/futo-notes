# @futo-notes/editor

Shared desktop Markdown editor code, browser embed contract, and native toolbar/title manifests.

Desktop Tauri consumes the editor as Svelte/TypeScript source and mounts
`MilkdownEditor.svelte` directly. The standalone browser fixture mounts the same component
through the versioned `futoBridge` contract. iOS and Android use native views backed by Rust
editor sessions and consume this package’s generated toolbar/title manifests.

Consumed as TypeScript source with no build step.
Path alias: `@futo-notes/editor` → `packages/editor/src`.

This package also owns the sanctioned synchronous TypeScript mirrors of the
Rust note rules needed in the editor hot path, including image filename
classification. Cross-language fixtures in `tests/conformance/` keep those
mirrors aligned with Rust.

## The bridge contract — `src/bridge.ts`

`bridge.ts` is the single source of truth for the editor ↔ host interface:

- `FutoEditorApi` — the `window.FutoEditor` surface hosts call into.
- `FutoEditorOutboundMessage` — the discriminated union the editor posts back
  to the host's `futoBridge` sink.
- `BRIDGE_VERSION` — bump on any breaking change; the `ready` message carries
  it so a host can refuse a bundle it doesn't understand.

The standalone editor entry point (`src/editor-embed/main.ts`) implements this contract.
The browser suites in `tests/editor-embed-milkdown*.spec.ts` exercise its host messages.

## The bundle — `editor.html`

The repo-root `editor.html` is the hand-written entry point for a self-contained browser
fixture with JS/CSS inlined. `vite.editor.config.ts` owns the build. The embed test setup
builds an isolated copy for each run; `pnpm run test:e2e:editor-embed` exercises it.
Native mobile builds do not stage or load this HTML.

## Test

```bash
pnpm --filter @futo-notes/editor test
```
