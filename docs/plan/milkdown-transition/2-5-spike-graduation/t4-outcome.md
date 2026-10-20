### T4 outcome (#101, done)

Branch `feat/milkdown-wikilinks`. Wikilinks work in the Milkdown editor:
`src/features/editor/milkdown/wikilink/` — `syntax.ts` (micromark tokenizer +
mdast from/to-markdown), `node.ts` (inline atom node + node view), `display.ts`
(which of the shared index's two answers a rendering uses), `inputRule.ts`,
`autocomplete.ts`. The survey that decided "build, don't adopt" is §3a.

- **The reason this was mandatory, measured**: unpatched, Milkdown serializes
  `[[notes/alpha]]` as `\[\[notes/alpha]]`. Every link in a note breaks on its
  first edit. Fences and code spans were already safe.
- **`![[embed]]` was corrupted twice over** and needed a second construct.
  micromark's `labelStartImage` claims the `![` pair at the `!`, leaving a lone
  `[` that cannot open a wikilink — so the whole run escaped to `!\[\[embed]]`.
  A lookahead construct at `!` now claims the `!` as plain text only when a real
  wikilink follows (`effects.check` rewinds), leaving `![alt](url)` an image.
- **Re-rendering never touches the document.** A host `setNotes` can flip a link
  from broken to resolved; doing that through a transaction would make a host
  call look like a user edit and normalize-save a note nobody touched. The node
  views mutate their own DOM instead, and a test asserts no `change` is posted
  and `getContent()` is unchanged.
- **The chip is an ATOM**, because display and source deliberately differ —
  `[[Projects/Roadmap]]` reads as "Roadmap" and a caret inside a shortened
  rendering has no honest source position. Two existing spec lines describe the
  CM6 model instead and are **bucket-2 renegotiation input**: "hidden trailing
  syntax such as a wikilink's `]]`" (marker reveal near the caret), and "a broken
  wikilink still focuses, so it can be edited" — in WYSIWYG a broken chip is
  selected and replaced, not edited in place.
- **One tap path for both link kinds.** The `touchend` leg exists because iOS
  WebKit cancels the synthetic click after a prevented mousedown — which is just
  as true of external links, so they share it rather than leaving the sibling on
  the leg that dead-ends (M17).
- **Accepted normalization, pinned by test**: `![[x]]` gains a `\!` on the first
  real edit (mdast-util-to-markdown escapes `!` before `[` and its `unsafe` list
  only grows), and literal `[[` that is not a wikilink is escaped the way a bare
  `[` already is. Both are idempotent and neither touches a wikilink.
- **Coverage**: 291 unit cases (differential vs `findWikilinks`, round trip,
  display, autocomplete matching) and 22 embed-seam cases driving the real
  `editor.html` with real keyboard and touch.
- **Desktop** reaches all of this the moment it mounts the shared bundle (D9's
  big-bang swap); it still mounts CM6 today, so "identical on all three shells"
  holds by construction — one plugin set in the one engine wrapper — not by a
  desktop-specific code path.
- Fixed in passing: `clickCaretInto` in `editor-embed-milkdown.spec.ts` measured
  a caret point without waiting for `document.fonts.ready`, so a Barlow swap
  between the measurement and the click moved every character. Seen red 3/3 on a
  loaded machine, green 25/25 after.
