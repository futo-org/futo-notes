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
- `src/wellFormed.ts` owns "no lone surrogate leaves the editor" (RC-48, decision 16A): `MilkdownEditor`'s
  `readSerialized`/`getContent` and the desktop `invoke` wrapper (`src/lib/platform/tauri/invoke.ts`) write each
  one as U+FFFD. Never call `String.prototype.toWellFormed` directly: the Android WebView floor (Chromium 80)
  and iOS 15 lack it, and the helper carries the fallback.
- `src/toolbar.ts` owns toolbar items; execution belongs in shared `TOOLBAR_EXEC`, never a shell.
- Never edit generated native specs, or the **bundled** editor output; edit the source and
  regenerate. The repo-root `editor.html` is the hand-written source — the native copies
  (`apps/*/…/editor.html`) are generated from it by `vite build --config vite.editor.config.ts`.

## Milkdown compat plugins — the M6 carve-out

`src/milkdown-compat/` fixes round-trip defects in `@milkdown/kit` 7.22.1:
an inline `<br>` deleted with no replacement and `[](url)` losing its href — and retires the preset's `<br />`
stand-in for an empty paragraph in favour of extra blank lines (`emptyLine.ts`,
both the parse-side transformer and the serializer `join`; never register a
plugin under the name `remark-preserve-empty-line`, that is what turns the tag
back on). On the serializer side it narrows two of remark-stringify's escapes
(`atxEscape.ts`, `underscoreEscape.ts`, installed through
`withNarrowedEscapes` in `stringifyHandlers.ts` — by the editor AND by the
census harness, so both write the same bytes), and scopes the presets' three
whole-document passes to the touched blocks (`listOrder.ts`, `tablePasses.ts`,
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

Four more escaping repairs, from the 2026-09 release-hardening campaign (FB-4a):

- `withNarrowedEscapes` also writes an autolink's text (`<https://…>`)
  VERBATIM — CommonMark reads no escapes inside `<…>`, and `safe()` doubled
  its backslashes every save — and sends every run Milkdown's `text` handler
  would return raw (`/^[^*_\\]*\s+$/`: any run ending in whitespace, which is
  every run before a mark, link, wikilink or inline HTML) through `safe()`
  minus its trailing whitespace. Never delegate such a run back to Milkdown's
  handler: that shortcut is what saved `\# a **b**` as a heading and split a
  cell on a typed `|`.
- `attentionEncoding.ts` wraps Milkdown's `strong`/`emphasis` handlers (and
  a restated GFM `delete`) with upstream's `encodeInfo`, so bold, italic or
  strikethrough whose edge is punctuation next to a letter still flanks
  (`**Note:**&#x62;ar`). When such an edge can only flank encoded, the
  adjacent character is written as a character reference (`&#x62;`); the marker
  is never switched (`_` to `*`), because that broke flanking next to `*` runs.
  Installed by `attentionEncodingPlugin` in `commonmarkWithCompat()`.
- `inlineHtmlIndent.ts` puts back the up-to-three continuation-line columns
  micromark strips from INLINE HTML. It hooks the `htmlText` token on purpose:
  by the time a tree transform runs, the preset has wrapped block HTML in a
  paragraph and the two are indistinguishable.
- `imageTitle.ts` gives a title-less image the empty-string `title` its schema
  validates as a string (mdast hands the parser `null`); an empty title is not
  written back, so the round trip is unchanged.
- `emptyTaskItem.ts` reads a list item whose first paragraph is only `[ ]`/`[x]`
  as an EMPTY task item (GFM needs text after the marker), and `listItemFiller.ts`
  writes that marker itself for an empty task item; without the pair it saved as
  a bare `-`.
- `listItemSpread.ts` makes an editor-made list item TIGHT: the preset defaults
  `list_item.spread` to `true` (the parser always overrides it from the source), so
  a nested list built by typing Enter then Tab saved `- b\n\n  - c` (RC-102). Placed
  after the gfm preset in `gfmWithCompat()`; parsed and pasted items are untouched.
- The app's own `break` handler (`src/features/editor/milkdown/table/tableLineBreak.ts`)
  writes a space where `\n` is unsafe (an ATX heading) and `<br>` before inline
  HTML; the wikilink handler writes `|` as `\|` in a table cell.

Five structural repairs from the same campaign (FB-4b/4c):

- `linkDefinitions.ts` replaces the preset's `remarkInlineLinkPlugin`: it
  inlines a USED link reference definition exactly as upstream did, but keeps
  every unused one as its own source text (an inline `html` atom, verbatim).
  It runs after the blank-line restore, so inlining leaves no empty paragraphs.
- `tableWidth.ts` pads a ragged table's rows at the END (header included,
  alignment unset) before ProseMirror sees it; `fixTables` padded them at the
  START and moved values under the wrong header.
- `tableAlignment.ts` keeps a cell's missing alignment through the DOM
  (`data-align-unset`), so a pasted table is not written `| :- |`.
- `trailingParagraph.ts` wraps the doc serializer so the document's trailing
  empty paragraphs (the `trailing` plugin's parked one) are not written;
  `src/features/editor/milkdown/blockSerializer.ts` drops the same units, and
  the two must stay byte-identical (`just chunk-census --serialize`).
- In `frontmatter.ts`: a parser wrapper refuses the front matter construct for
  a note with no closing fence (the construct is `concrete`, and a failed
  attempt at EOF had disabled every list and quote; canary in
  `frontmatter.test.ts`), and a paste keeps front matter only where it can
  land (`withLandableFrontmatter`), else as a code block, never dropped.

`src/milkdown-compat/frontmatter.ts` is in the same directory for the same
reason but is an ADDITION, not a fork: the preset has no front matter construct,
so `---\ntags: [a, b]\n---` parsed as a thematic break plus a setext heading and
any edit wrote back `***` and `tags: \[a, b]`. The block itself has no canary — upstream
is not wrong, it just does not ship the extension — and it must come after the
preset in `commonmarkWithCompat()`, because it overrides the preset's own `doc`
node by re-registering that id and reads the registered entry back to inherit
everything but the content expression (only `trailingParagraph.ts`'s doc
override, which wraps it the same way, comes later).

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
