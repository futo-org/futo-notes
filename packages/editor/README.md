# @futo-notes/editor

Shared note rules, toolbar/title manifests and the editor engine's payload types.

Desktop Tauri edits through the engine-backed desktop editor (`src/features/editor/desktop/`),
a view over the Rust editor engine (`crates/futo-notes-editor`, compiled to WASM). iOS and
Android use native views backed by Rust editor sessions and consume this package's generated
toolbar/title manifests.

Consumed as TypeScript source with no build step.
Path alias: `@futo-notes/editor` → `packages/editor/src`.

This package owns the sanctioned synchronous TypeScript mirrors of the Rust note rules needed
in hot paths — filename/title (`filename.ts`), tags (`tags.ts`), image filename classification
(`images.ts`) and note previews (`preview.ts`) — plus `wellFormed.ts` (no lone surrogate leaves
the editor). Cross-language fixtures in `tests/conformance/` keep those mirrors aligned with Rust.

## Manifests

`toolbar.ts` (the toolbar items, order, grouping, labels, icons and visibility) and the title
rules in `filename.ts` are the sources of truth for the native shells: `scripts/gen-toolbar-spec.ts`
and `scripts/gen-title-spec.ts` generate `ToolbarSpec.*` / `TitleSpec.*` from them
(`just toolbar-spec`, `just title-spec`).

`wasmPayloads.d.ts` (`@futo-notes/editor/wasm-payloads`) holds the TypeScript shapes of the engine's
WASM payloads.

## Test

```bash
pnpm --filter @futo-notes/editor test
```
