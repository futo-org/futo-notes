# packages/editor — shared rules and native editor contract

Read root `AGENTS.md` first. Rust remains canonical for note rules; this package owns only sanctioned
hot-path TS mirrors, `futoBridge`, and the toolbar manifest.

## Ownership and traps

- TS mirrors live here except wikilinks (`src/shared/note/wikilinks.ts`) and stay locked by
  `tests/conformance/`.
- `src/bridge.ts` owns messages and `BRIDGE_VERSION`; a new message needs both native hosts. Ask
  before a version bump.
- `src/toolbar.ts` owns toolbar items; execution belongs in shared `TOOLBAR_EXEC`, never a shell.
- Never edit generated native specs or bundled editor outputs. The root `editor.html` is the
  hand-written source; native copies are generated.

## Rule-change chain

1. Add inputs to the relevant group in `tests/conformance/generate.mjs`.
2. Change both TS and canonical Rust (`futo-notes-model` / `futo-notes-core`).
3. Run `pnpm exec tsx tests/conformance/generate.mjs`.
4. Run `pnpm run test:editor:minimal` and `just test-rust`.
5. Search Swift/Kotlin for un-fixtured sibling copies.

Bridge/toolbar work also runs `just bridge-spec` / `just toolbar-spec` and package tests. Finish with
`just check-drift`.
