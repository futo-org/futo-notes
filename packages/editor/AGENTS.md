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
- `src/wellFormed.ts` owns "no lone surrogate leaves the editor" (RC-48, decision 16A): `serializationLoop.ts`'s
  `readSerialized`/`hostHandle.ts`'s in-process desktop `getContent` and the desktop `invoke` wrapper (`src/lib/platform/tauri/invoke.ts`) write each
  one as U+FFFD. Never call `String.prototype.toWellFormed` directly: the Android WebView floor (Chromium 80)
  and iOS 15 lack it, and the helper carries the fallback.
- `src/toolbar.ts` owns toolbar items; execution belongs in shared `TOOLBAR_EXEC`, never a shell.
- Never edit generated native specs, or the **bundled** editor output; edit the source and
  regenerate. The repo-root `editor.html` is the hand-written source — the native copies
  (`apps/*/…/editor.html`) are generated from it by `vite build --config vite.editor.config.ts`.

## Milkdown compat plugins — the M6 carve-out

`src/milkdown-compat/` adapts `@milkdown/kit` 7.22.1 on the way IN — what a
note's bytes parse into — and installs the editor's own serializer
(`ownedSerializer.ts`, below) as Milkdown's `serializerCtx`. Nothing here
patches remark-stringify any more: Milkdown's own serializer is never called.

Parse-side repairs: an inline `<br>` deleted with no replacement and `[](url)`
losing its href; the preset's `<br />` stand-in for an empty paragraph retired
in favour of extra blank lines (`emptyLine.ts`, the parse-side transformer;
never register a plugin under the name `remark-preserve-empty-line`, that is
what turns the tag back on). The presets' three whole-document passes are
scoped to the touched blocks (`listOrder.ts`, `tablePasses.ts`,
`touchedRange.ts`; `gfmWithCompat()` pairs with `commonmarkWithCompat()`).
**CommonMark decides ambiguous list syntax; there is no pre-parse bullet-number rewriting.**
**These carry no Rust mirror.** They
are adapters to one editor library's implementation — which mdast node a plugin
deletes, how a link mark finds text to attach to — not note rules, so M6 does
not apply. Nothing in Swift, Kotlin, or Rust may hold a second copy either.

`inlineNodesCursor.ts` is an INPUT fork, not a round-trip one (FB-19): upstream's
`inlineNodesCursorPlugin` returned `true` from `compositionend`, which keeps ProseMirror's own
handler from running, so an IME commit between two non-text inline nodes (two chips, image +
chip) left `view.composing` set for good off Android — input rules stop and `isComposing()`
sticks. It also deletes a selection that covers a chip before a composition starts over it (RC-97:
ProseMirror re-dispatching that selection made Chromium drop the composition). The fork is swapped in at the same index in `commonmarkWithCompat()`; its canary is in
`editor-embed-milkdown-compat.spec.ts`, its real-IME tests in
`editor-embed-milkdown-wikilinks.spec.ts`.

From the 2026-09 release-hardening campaign (FB-4a/4b/4c), all on the parse side:

- `inlineHtmlIndent.ts` puts back the up-to-three continuation-line columns
  micromark strips from INLINE HTML. It hooks the `htmlText` token on purpose:
  by the time a tree transform runs, the preset has wrapped block HTML in a
  paragraph and the two are indistinguishable.
- `imageTitle.ts` gives a title-less image the empty-string `title` its schema
  validates as a string (mdast hands the parser `null`); an empty title is not
  written back, so the round trip is unchanged.
- `emptyTaskItem.ts` reads a list item whose first paragraph is only `[ ]`/`[x]`
  as an EMPTY task item (GFM needs text after the marker); the serializer writes
  an empty task item as `- [ ]`.
- `listItemSpread.ts` makes an editor-made list item TIGHT: the preset defaults
  `list_item.spread` to `true` (the parser always overrides it from the source), so
  a nested list built by typing Enter then Tab saved `- b\n\n  - c` (RC-102). Placed
  after the gfm preset in `gfmWithCompat()`; parsed and pasted items are untouched.
- The app's table-cell `<br>` reader (`src/features/editor/milkdown/table/tableLineBreak.ts`)
  turns a `<br>` beside text in a cell back into a line break; the wikilink
  tokenizer reads `\|` in a table cell as `|`.
- `linkDefinitions.ts` replaces the preset's `remarkInlineLinkPlugin`: it
  inlines a USED link reference definition exactly as upstream did, but keeps
  every unused one as its own source text (an inline `html` atom, verbatim).
  It runs after the blank-line restore, so inlining leaves no empty paragraphs.
- `tableWidth.ts` pads a ragged table's rows at the END (header included,
  alignment unset) before ProseMirror sees it; `fixTables` padded them at the
  START and moved values under the wrong header.
- `tableAlignment.ts` keeps a cell's missing alignment through the DOM
  (`data-align-unset`), so a pasted table is not written `| :-- |`.
- `trailingParagraph.ts` answers whether a document ends in more empty
  paragraphs than its own serialization would read back as (a host `setContent`
  must still be applied then); the serializer does not write trailing ones.
- In `frontmatter.ts`: a parser wrapper refuses the front matter construct for
  a note with no closing fence (the construct is `concrete`, and a failed
  attempt at EOF had disabled every list and quote; canary in
  `frontmatter.test.ts`), and a paste keeps front matter only where it can
  land (`withLandableFrontmatter`), else as a code block, never dropped.

`src/milkdown-compat/frontmatter.ts` is in the same directory for the same
reason but is an ADDITION, not a fork: the preset has no front matter construct,
so `---\ntags: [a, b]\n---` parsed as a thematic break plus a setext heading and
any edit rewrote the metadata. The block itself has no canary — upstream
is not wrong, it just does not ship the extension — and it must come after the
preset in `commonmarkWithCompat()`, because it overrides the preset's own `doc`
node by re-registering that id and reads the registered entry back to inherit
everything but the content expression.

Rules that do bind here:

- The parse-side set ships as one `commonmarkWithCompat()` array. Half of it is worse
  than none: filtering the upstream plugin without the replacement drops every
  blank line the author typed, and adding the replacement without filtering runs
  both and brings the `<br />` placeholder back. It is a memoized FUNCTION, not a const, because
  this package's barrel re-exports the module: building the preset at module
  scope would run its upstream-shape check on every import of
  `@futo-notes/editor` and pull `@milkdown/kit` into every bundle that touches
  the barrel, the codegen scripts' included.
- **The forks are meant to die.** `tests/editor-embed-milkdown-compat.spec.ts`
  reproduces each upstream bug against the _unpatched_ preset. A red canary means
  upstream shipped a fix — delete our fork, do not relax the canary. The
  `@milkdown/kit` version is pinned (not a range) so this stays meaningful.
- Any change to these plugins is measured, not argued:
  `just milkdown-census --variant baseline` then
  `just milkdown-census --diff build/milkdown-census/baseline`. Zero newly-raised
  flags over ~31k real notes. `tests/milkdown-census/README.md` owns the harness.

## The markdown serializer — `src/markdown/` (#266)

The editor's own serializer and the only one in the product: a pure function
from the document's JSON to the bytes a save writes, in the house style of
docs/spec/editor.md "Markdown house style". The save path keeps a per-block
cache over it (`src/markdown/cache.ts`, built by
`src/features/editor/milkdown/serializationLoop.ts` `createDocumentSerializer`);
`src/milkdown-compat/ownedSerializer.ts` makes it Milkdown's `serializerCtx`,
so `getMarkdown()` and a copy's text/plain write the same bytes
(`just chunk-census --serialize` holds the cache equal to it). Both are handed
the editor's own `parserCtx`.

- Spec line first, then a golden in `tests/conformance/markdown-house-style.json`
  (hand-reviewed; never pasted from output), then the code. The goldens run against
  the shipping parser in `src/features/editor/milkdown/markdownHouseStyle.test.ts`.
- No `@milkdown/*` or `prosemirror-*` import, ever: the parser is injected.
- Escaping is decided by parsing the candidate output (`choose.ts`). A pattern may
  only decide WHEN to parse (the `plausible` sites, `obviouslyFlanks`), never what
  to write. A layout quirk of the parser is offered as a layout site, not hard-coded,
  unless it is measured and stated (`touches` in `blocks.ts`).
- Output depends only on the document and the parser — no clock, no randomness —
  and only on the document's NORMALIZED form (`normalize.ts`), which is what makes a
  second save a no-op. The census `content_loss` detector states the same
  normalizations independently (`tests/milkdown-census/detectors.mjs`
  `houseDocument`): change one, change both, in the same commit.
- Measured, not argued: `just milkdown-census` (the default `compat` variant writes
  with this serializer) over the corpus and `--vault`; `content_loss` and
  `second_pass_unstable` are the gates.

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
