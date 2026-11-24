# AGENTS.md — Shared Editor Contract

@README.md for the package overview. Root `AGENTS.md` still applies.

This package owns the sanctioned synchronous TS mirrors of Rust note rules, the shared
toolbar and title manifests, and the engine's WASM payload types.

## Ownership and traps

- Rust remains canonical for filename, tag, preview, wikilink, and image rules. The hot-path TS
  mirrors (filename, tag, preview, image) live here and stay locked by the hand-reviewed goldens in
  `tests/conformance/`. Wikilink rules have no TS copy: the desktop editor and the store reach
  them in Rust (`crates/futo-notes-wikilinks`).
- `src/wellFormed.ts` owns "no lone surrogate leaves the editor" (RC-48, decision 16A): the desktop
  `invoke` wrapper (`src/lib/platform/tauri/invoke.ts`) and clipboard writes use it to turn
  each one into U+FFFD. It carries the fallback where `String.prototype.toWellFormed` is unavailable.
- `src/toolbar.ts` owns toolbar items; mobile dispatches through Rust editor sessions and the
  desktop toolbar runs engine commands (`src/features/editor/desktop/FormatToolbar.svelte`).
- Never edit generated native specs (`ToolbarSpec.*`, `TitleSpec.*`); edit the source and
  regenerate.

## Rule-change chain

The `tests/conformance/*.json` cases are hand-reviewed behavioral goldens, not output dumped from
either implementation. Nothing regenerates them — write the expectation you intend, then make both
languages satisfy it.

1. Add the case, with the outcome the spec says it should have, to the relevant
   `tests/conformance/*.json` golden.
2. Change both this package and canonical Rust (`futo-notes-model` / `futo-notes-core`) until each
   satisfies that independent expectation.
3. Run `just test-unit packages/editor` and `just test-rust` — the goldens on both sides, plus the
   batched TS↔Rust rule differential (`tests/conformance/title-rules-differential.mjs`),
   which asks both implementations the same broad corpus and fails on any divergence.
4. Search Swift/Kotlin for un-fixtured sibling copies.

Toolbar changes also run `just toolbar-spec` and the matching package tests.
Finish with `just check-drift`; it rejects unregistered copies and stale projections.
