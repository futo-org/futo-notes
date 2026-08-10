# AGENTS.md — Shared Editor Contract

@README.md for the package overview. Root `AGENTS.md` still applies.

This package owns the sanctioned synchronous TS mirrors of Rust note rules, the versioned
`futoBridge` contract, and the native toolbar manifest.

## Ownership and traps

- Rust remains canonical for filename, tag, preview, wikilink, and image rules. Hot-path TS mirrors
  live here except wikilinks (`src/shared/note/wikilinks.ts`) and stay locked by conformance fixtures.
- `src/bridge.ts` owns bridge messages and `BRIDGE_VERSION`. A new message requires both native
  hosts (`EditorWebView.swift` and `EditorWebView.kt`); ask before a version bump.
- `src/toolbar.ts` owns toolbar items; execution belongs in shared `TOOLBAR_EXEC`, never a shell.
- Never edit generated native specs or `editor.html`; edit these sources and regenerate.

## Rule-change chain

1. Add the new input to the relevant group in `tests/conformance/generate.mjs`.
2. Change both this package and canonical Rust (`futo-notes-model` / `futo-notes-core`).
3. Run `pnpm exec tsx tests/conformance/generate.mjs`.
4. Run `pnpm run test:editor:minimal` and `just test-rust`.
5. Search Swift/Kotlin for un-fixtured sibling copies.

Bridge/toolbar changes also run `just bridge-spec` / `just toolbar-spec` and the matching package
tests. Finish with `just check-drift`; it rejects unregistered copies and stale projections.
