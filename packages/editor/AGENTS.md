# AGENTS.md — Shared Editor Contract

@README.md for the package overview. Root `AGENTS.md` still applies.

This package owns the sanctioned synchronous TS mirrors of Rust note rules, the versioned
`futoBridge` contract, and the native toolbar manifest.

## Ownership and traps

- Rust remains canonical for filename, tag, preview, wikilink, and image rules. Hot-path TS mirrors
  live here except wikilinks (`src/shared/note/wikilinks.ts`) and stay locked by the hand-reviewed
  goldens in `tests/conformance/`.
- `src/bridge.ts` owns bridge messages and `BRIDGE_VERSION`. A new message requires both native
  hosts (`EditorWebView.swift` and `EditorWebView.kt`); ask before a version bump.
- `src/toolbar.ts` owns toolbar items; execution belongs in shared `TOOLBAR_EXEC`, never a shell.
- Never edit generated native specs, or the **bundled** editor output; edit the source and
  regenerate. The repo-root `editor.html` is the hand-written source — the native copies
  (`apps/*/…/editor.html`) are generated from it by `vite build --config vite.editor.config.ts`.

## Milkdown compat plugins — the M6 carve-out

`src/milkdown-compat/` fixes three round-trip defects in `@milkdown/kit` 7.22.1:
an inline `<br>` deleted with no replacement, `[](url)` losing its href, and a
spurious `<br />` on `* 0.`-style bullets. **These carry no Rust mirror.** They
are adapters to one editor library's implementation — which mdast node a plugin
deletes, how a link mark finds text to attach to — not note rules, so M6 does
not apply. Nothing in Swift, Kotlin, or Rust may hold a second copy either.

Rules that do bind here:

- The parse-side set ships as one `commonmarkWithCompat()` array. Half of it is worse
  than none: filtering the upstream plugin without the replacement turns the
  serializer's empty-paragraph placeholder off, and adding the replacement
  without filtering runs both. It is a memoized FUNCTION, not a const, because
  this package's barrel re-exports the module: building the preset at module
  scope would run its upstream-shape check on every import of
  `@futo-notes/editor` and pull `@milkdown/kit` into every bundle that touches
  the barrel, CodeMirror's and the codegen scripts' included.
- **The forks are meant to die.** `tests/editor-embed-milkdown-compat.spec.ts`
  reproduces each upstream bug against the *unpatched* preset. A red canary means
  upstream shipped a fix — delete our fork, do not relax the canary. The
  `@milkdown/kit` version is pinned (not a range) so this stays meaningful.
- Any change to these plugins is measured, not argued:
  `just milkdown-census --variant baseline` then
  `just milkdown-census --diff build/milkdown-census/baseline`. Zero newly-raised
  flags over ~31k real notes. `tests/milkdown-census/README.md` owns the harness.

## Rule-change chain

The `tests/conformance/*.json` cases are hand-reviewed behavioral goldens, not output dumped from
either implementation. Nothing regenerates them — write the expectation you intend, then make both
languages satisfy it.

1. Add the case, with the outcome the spec says it should have, to the relevant
   `tests/conformance/*.json` golden.
2. Change both this package and canonical Rust (`futo-notes-model` / `futo-notes-core`) until each
   satisfies that independent expectation.
3. Run `pnpm run test:editor:minimal` and `just test-rust` — the goldens on both sides, plus the
   batched TS↔Rust rule differential (`tests/conformance/title-rules-differential.mjs`),
   which asks both implementations the same broad corpus and fails on any divergence.
4. Search Swift/Kotlin for un-fixtured sibling copies.

Bridge/toolbar changes also run `just bridge-spec` / `just toolbar-spec` and the matching package
tests. Finish with `just check-drift`; it rejects unregistered copies and stale projections.
