# Milkdown round-trip bug fixes — findings + WIP (parked)

Status: **parked mid-fix, per explicit instruction**. Repo tree has been reverted to
exactly the state it was in when this task started (verified: `MilkdownEditor.svelte`
is back to 1100 lines / no diff beyond pre-existing dirty state; `tsc --noEmit` and
`vite build --config vite.editor.config.ts` both pass clean on the reverted tree).
All fix work is saved here instead. Nothing was committed at any point.

## Files in this directory

- `roundtrip-wip-milkdownMarkdownGuards.ts` — the (nearly-complete, NOT fully verified)
  fix module. This is a straight copy of what would be
  `src/features/editor/milkdownMarkdownGuards.ts`.
- `roundtrip-wip-MilkdownEditor.svelte.patch` — a clean, minimal unified diff (5 hunks)
  against the CURRENT (reverted) `src/features/editor/MilkdownEditor.svelte`, showing
  exactly how it needs to be wired up to use the guards module. Apply with:
  `patch -p1 src/features/editor/MilkdownEditor.svelte < roundtrip-wip-MilkdownEditor.svelte.patch`
  (or just re-apply the 5 edits by hand, they're small and self-explanatory).
- `harness/entry.js` — the corpus harness bundle entry, **already updated** to import
  `prepareMarkdownForMilkdown`/`restoreMarkdownFromMilkdown` directly from
  `src/features/editor/milkdownMarkdownGuards.ts` via esbuild (so there is zero drift
  between what the corpus exercises and what the app would ship) — but that file
  doesn't exist in the repo right now (only in this scratchpad), so **re-copy
  `roundtrip-wip-milkdownMarkdownGuards.ts` back to
  `src/features/editor/milkdownMarkdownGuards.ts` before rebuilding the harness bundle**
  (`node_modules/.bin/esbuild harness/entry.js --bundle --outfile=harness/bundle.js
  --format=iife --platform=browser`, run from the repo root so it resolves
  `node_modules`).
- `harness/entry-baseline.js` / `bundle-baseline.js` / `page-baseline.html` /
  `run-baseline.mjs` — a regenerated **baseline** (pre-fix) corpus harness, since the
  original baseline `corpus-results.jsonl` got overwritten by an in-progress run early
  in this session. Confirmed to reproduce the exact baseline numbers from
  `milkdown-corpus-report.md` (117 unstable, 8 persistent, 660 doc_mismatch, 524
  text_loss, 541 structural_diff, 1 wikilink_loss, 64 html_loss) — keep this around,
  it's the fastest way to diff "did my next change regress anything" without re-deriving
  it from scratch.
- `corpus-results-baseline.jsonl` / `corpus-summary-baseline.json` — the regenerated
  baseline results (see above).
- `corpus-results-fixed.jsonl` / `corpus-summary.json` — the **last completed** full
  corpus run with the WIP fix applied (see numbers below) — NOT the final state, two
  known regressions remain (see "Known remaining issues").
- `idx*-body.txt` — extracted bodies of specific corpus notes used for debugging
  (indices: 2027, 2280, 2294, 2322, 2326, 2347, 2707, 4099, 4107, 4158, 4166, 4182,
  8560, 11082, 11735, 13240, 24520, 25957). Handy for fast repro without re-decompressing
  the corpus.

## Root causes (all three confirmed via doc-tree dumps / direct source reading, not guessing)

### Bug 1 — `<br>` deleted with zero replacement (the headline bug)

**Root cause found in `@milkdown/preset-commonmark`'s
`plugin/remark-preserve-empty-line.ts`** (NOT the html node schema, which is actually
fine — see below). Its `visitEmptyLine` walks the mdast tree and **deletes any `html`
node whose trimmed value is exactly one of `'<br />'`, `'<br>'`, `'<br >'`, `'<br/>'`**,
unconditionally — with NO check that the node is alone in its paragraph. This plugin's
real purpose (and it works correctly for this): when Milkdown serializes a genuinely
EMPTY paragraph that isn't the document's last node, `node/paragraph.ts`'s
`toMarkdown` emits a literal `<br />` placeholder (to visually preserve a blank line
that Markdown would otherwise fold away); on the NEXT parse, this plugin recognizes
that exact placeholder and deletes it again, reconstructing the empty paragraph. This
round-trip is correct and was NOT touched by the fix.

The bug: the exact-string-match deletion doesn't care whether the html node has text
SIBLINGS in the same paragraph/cell/list-item. An inline `<br>` used mid-sentence, or
inside a GFM table cell (the only legal way to represent a cell line-break), matches
the identical value string and gets deleted with **zero replacement**, silently fusing
the surrounding words. Confirmed via a `doc.toJSON()` dump: the `<br>` html atom node
literally never reaches the ProseMirror doc at all for an inline occurrence — it's
gone before Milkdown's own parser state machine ever sees it.

**The html node schema itself (`node/html.ts`) is NOT broken** — it correctly declares
an inert atom node (`atom: true`, renders via `toDOM` as a `<span>` whose **text
content** is the literal tag string, i.e. never live/executed HTML) with
`parseMarkdown`/`toMarkdown` that round-trip verbatim. This is confirmed by generic
inline HTML like `<kbd>K</kbd>` and `<!-- comments -->` **already round-tripping
perfectly** with zero fix needed — only the `<br>`-specific plugin is the problem.

**Fix approach taken** (editor-layer, no preset forking, no new deps): a pure
string-level "protect/restore" pass done in `MilkdownEditor.svelte`, OUTSIDE
Milkdown's own pipeline:
- `protectInlineBreaks(markdown)` — before Milkdown ever parses, find every
  `<br>`/`<br/>`/`<br />`/`<br >` (regex, skipping fenced code blocks and inline code
  spans) and, UNLESS it is "isolated" (see below), rewrite it to
  `<br data-futo-hb="1">` — a marker string that still parses as an ordinary inert
  `html` atom node (so it renders as literal inert text, same as `<kbd>`) but does NOT
  match `remarkPreserveEmptyLinePlugin`'s exact 4-string check, so it survives.
- `restoreInlineBreaks(markdown)` — after Milkdown serializes, a plain
  `.split(marker).join('<br>')` to strip the marker back out before the text is ever
  treated as "real" content (echo comparison, `onchange`, `getContent()`).
- Wired into `MilkdownEditor.svelte` at: the initial `defaultValueCtx` set,
  `applyExternal`'s `replaceAll`, `readSerialized()` (wraps `getMarkdown()`), the
  `markdownUpdated` listener callback, and `insertMarkdown`. See the patch file for
  the exact 5 hunks.

**"Isolated" (leave the tag alone, don't protect) turned out to need THREE cases**,
discovered incrementally by re-running the full 30,995-note corpus after each attempt
and diffing newly-introduced instability against the regenerated baseline (this
iteration process is exactly why this is only ~90% done, not the number of remaining
bugs):
1. **Bare top-level paragraph**: the whole line (trimmed) is just the tag, AND the
   line before and the line after are both blank (or doc start/end). This is the
   original "preserved blank line" case and needs the blank-line check because a `<br>`
   alone on its own line WITHOUT blank-line separation is still part of a
   multi-line paragraph (soft-broken), not its own empty paragraph.
2. **GFM table cell**: `cellContent: 'paragraph'` (preset-gfm's `node/table/schema.ts`)
   means an EMPTY table cell hits the exact same "empty paragraph → `<br />`"
   mechanism, and Milkdown puts the `<br />` there ITSELF (nothing in the original
   note) whenever a cell has no content — e.g. a table row with fewer real
   columns than the header, or lazy-continuation lines after a table becoming
   extra rows with empty second columns (see `idx 25957` below). Isolation here
   means: the tag is the ENTIRE trimmed content between the nearest `|` on each
   side, found via `line.trim().startsWith('|')` + `lastIndexOf('|')`/`indexOf('|')`
   around the match.
3. **List item / blockquote**: a bullet/ordered list item or blockquote whose ONLY
   content is the tag hits the same mechanism too (a list item's/blockquote's content
   is a paragraph). Unlike case 1, this does NOT need a blank-line-neighbor check
   (list items in a "tight" list have no blank lines between them at all). Isolation
   here strips a repeated leading `(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)+` prefix
   and checks the remainder trimmed equals the tag trimmed.

**Known remaining gap (NOT yet fixed) — nested containers**: case 2 and case 3 were
implemented as SEPARATE checks, each assuming the tag's container starts the line
directly. `idx 25957` in the corpus is a table **inside a blockquote**
(`"> | ... | <br /> |"`) — case 2's cell-boundary check requires
`line.trim().startsWith('|')`, which is false here (`> ` comes first), and case 3's
block-prefix strip correctly eats the `> ` but then sees `| ... | <br /> |` as the
"remainder", which is NOT equal to just the tag (there's other cell content on the
same line) — so it falls through as NOT isolated, gets marker-protected, and becomes
unstable across rounds (round1 has the correct pre-existing `<br />`, round2 has the
marker-restored `<br>` — same content, different literal spelling, so
`round1 !== round2` as strings even though the actual doc is equivalent). **The fix**:
generalize by stripping the list/blockquote block-prefix FIRST, then check if what's
left starts with `|`, and if so do the cell-boundary check on that remainder (not the
original whole line) — i.e. compose case 3's prefix-strip with case 2's cell check
instead of treating them as mutually exclusive. Also similarly check `idx 8560`
(footnote definition `[^4]: <br />` — a GFM footnote-definition's content is ALSO a
paragraph, hitting the same mechanism a third way) — the block-prefix regex needs an
alternative for `\[\^[^\]]+\]:[ \t]+` (footnote definition marker) added to
`BLOCK_PREFIX_RE`.

**Also known but not yet root-caused**: 16 notes in the last full run still flag
`html_loss` (a raw-tag-count heuristic comparing `note.body` to `round1`) — NOT yet
investigated whether these are `<br>`-related (likely NOT, since the two identified
`<br>`-related regression classes above are a different flag, `unstable`) or some
other pre-existing HTML-tag class. Indices captured in `idx*-body.txt` where fetched
(11082, 11735, 13240, 24520 and neighbors 24513–24875 look like a cluster, possibly
all the same note-template/pattern — worth checking that first). Re-run
`node -e "..."` against `corpus-results-fixed.jsonl` filtering `flags.html_loss` to get
the full list of 16 indices if this needs picking back up (the exact one-liner is in
this session's tool history but trivial to redo: parse each line, collect `idx` where
`flags.html_loss`).

### Bug 2 — empty-text link `[](url)` deletes the href too

**Root cause**: `mark/link.ts`'s `parseMarkdown.runner` does
`state.next(node.children)` for a `link` mdast node — for `[](url)`, `node.children`
is an EMPTY array (mdast gives an empty-label link zero children), so `state.next([])`
is a no-op: NOTHING is added to the ProseMirror doc. Since Milkdown represents links as
a **mark** (not a node), and marks attach to existing content, there is no text run to
attach the mark to — both the (invisible) label and the href are gone, with nothing
in the doc ever carrying the href.

**Fix**: `expandEmptyLinks(markdown)` — before parsing, regex-rewrite
`(?<!!)\[]\(url(?: "title")?\)` → `[url](url "title")`, i.e. use the URL itself as
visible link text, giving the mark something to attach to. One-way (no restore
needed on serialize — this is a permanent, correct upgrade, same category as
Milkdown's own other forward-only normalizations). The `(?<!!)` negative lookbehind
is IMPORTANT: it excludes `![](url)` (empty ALT TEXT IMAGE syntax), which is a
completely different, legitimate, already-lossless pattern (a decorative image with
no alt text) — the first version of this fix did NOT have that exclusion and it
was a major source of corpus regressions (every image with empty alt text got its alt
text rewritten to the URL) before being caught and fixed. Verified fixed: images now
round-trip byte-identical again.

**This part is done and verified** (unlike bug 1's edge cases) — `[](url)` →
`[url](url)` (or the GFM-autolink-collapsed `<url>` form, when link text equals href —
that's `remark-inline-links`, an existing Milkdown plugin, doing its own normal thing
on top of our fix, also fine) confirmed stable across rounds, and confirmed NOT
touching `![](url)` images.

### Bug 3 — spurious `<br />` on bullet items starting with `<digit>.`/`<digit>)`

**Root cause**: NOT a Milkdown bug — CommonMark itself (any compliant parser)
legitimately parses `* 0. item one` as a bullet list item whose content is a NESTED
ORDERED LIST (starting at 0), because a list item's content is parsed as its own
mini-document and `0. item one` opens a new list. Confirmed via `doc.toJSON()`: the
bullet item becomes `[empty paragraph, ordered_list]`. The empty leading paragraph
(needed structurally to hold the item together before the nested list) is
"not the last node", so it hits the SAME `paragraph.ts` "empty → `<br />`" mechanism
as bug 1, and comes back out as visible `* <br />` + an indented nested-list
continuation line.

remark-stringify's own protection for exactly this ambiguity is a backslash escape
(`0\.`) — this machinery is intact and unmodified in Milkdown (its `SerializerState`
builds a full mdast tree and hands it to plain, un-forked `remark-stringify` in one
shot, per `serializer/state.ts`'s `toString`), it just never gets the chance because
the ambiguity was already resolved (as real nested-list structure) at PARSE time,
before serialization ever runs.

**Fix**: `escapeAmbiguousBulletNumbers(markdown)` — before parsing, regex
`^([ \t]{0,3}[*+-][ \t]+)(\d{1,9})([.)])(?=[ \t]|$)` (multiline, skips fenced/inline
code) inserts a backslash before the `.`/`)`: `* 0. item one` → `* 0\. item one`.
CommonMark parses the escaped form as plain text "0. item one" (backslash escapes are
unescaped during parsing), so there's no nested list, no empty paragraph, no `<br />`
artifact, and the visible rendered text is unchanged. Confirmed via `doc.toJSON()`:
clean flat paragraph, no nested structure. Only escapes when the digit-dot is
IMMEDIATELY adjacent to the bullet marker (the actual ambiguous shape) — a digit-dot
appearing later in item text ("see step 2. above") is untouched, and real/intentional
nested ordered lists on their own indented continuation line are untouched (this is
anchored to marker+digit on the SAME line).

**This part is done and verified** — stable across rounds, doesn't affect genuine
ordered lists, doesn't affect non-ambiguous digit-dot text, doesn't touch fenced code
or inline code spans, task lists still work.

## Verification done so far

- `pnpm exec tsc --noEmit` — clean, on every iteration.
- `pnpm run lint` — clean (only 2 pre-existing unrelated warnings in unrelated test
  files, present before this work).
- `pnpm run check:svelte` — clean (checked once, before the isolation-logic
  refinements to `milkdownMarkdownGuards.ts` — should still be clean since none of
  those refinements touched the `.svelte` file, but hasn't been RE-run after the
  latest guards.ts changes; trivial to re-run, doesn't need repeating from scratch).
- `node_modules/.bin/vite build --config vite.editor.config.ts` — clean, builds
  `build/native-editor/editor.html`, on every iteration.
- All 4 existing scratchpad smokes (`touch-drag-smoke.mjs`, `block-drag-smoke.mjs`,
  `formatstate-smoke.mjs`, `checkbox-touch-smoke.mjs`) — PASS against the rebuilt
  bundle (block drag, undo, checkbox tap, format-state emission all unaffected).
- Real built `editor.html` (not just the harness) driven via Playwright + the actual
  `window.FutoEditor` bridge confirms the PARSE side of all 3 fixes renders correctly
  in the real component (`RENDERED` DOM text checks: table-cell `<br>` no longer
  fuses, `<kbd>`/comments still literal, empty link shows URL as text, numbered
  bullet shows clean text, block-level preserved-blank-line `<br>` unaffected).
  (Note: `getContent()` echoes the host's ORIGINAL bytes verbatim until the doc is
  actually edited — by design, the load-echo safety guard — so it can't be used to
  observe the fix; the DOM text content can, since it reflects what Milkdown actually
  parsed regardless of the echo guard. A "force a real edit via synthetic
  keyboard/execCommand" approach was tried and abandoned as too flaky/unreliable in
  this environment — matches the M21 warning about synthetic input in this repo's
  AGENTS.md; not worth fighting further given the DOM-text check already proves the
  parse-side wiring, and the harness — which uses the identical guard functions,
  imported directly from source, not copy-pasted — already proves the full
  parse+serialize loop.)
- **Full 30,995-note corpus, multiple iterations** (~67s each, `POOL_SIZE=8`):
  - Regenerated baseline (pre-fix): unstable=117, unstable_persistent=8,
    doc_mismatch=660, text_loss=524, structural_diff=541, wikilink_loss=1,
    html_loss=64. (Matches `milkdown-corpus-report.md` exactly — confirms the harness
    reproduction is faithful.)
  - First fix attempt (protect ALL non-isolated-by-blank-line-only `<br>`, plus
    unguarded `expandEmptyLinks` matching images too): unstable jumped to 1466 — a
    regression, root-caused to (a) empty table cells' OWN `<br />` placeholder being
    wrongly protected, and (b) `![](url)` images getting their alt text rewritten.
  - After adding table-cell isolation + image exclusion: unstable dropped to 1242 —
    better but still a big regression, root-caused to empty LIST ITEMS' own `<br />`
    placeholder being wrongly protected (same mechanism, different container).
  - After adding list-item/blockquote isolation (current WIP state, in
    `roundtrip-wip-milkdownMarkdownGuards.ts`): **unstable=113, unstable_persistent=8,
    doc_mismatch=621, text_loss=485, structural_diff=501, wikilink_loss=1,
    html_loss=16** — better than baseline on every metric except html_loss isn't yet
    at the target 0, AND diffing against baseline shows exactly **2 remaining
    regressions** (`idx 8560`, `idx 25957`, both described above — footnote-definition
    and nested table-in-blockquote cases of the same "Milkdown's own `<br />`
    placeholder" mechanism, not yet covered by the isolation checks).

## Exact next steps for whoever resumes this

1. Copy `roundtrip-wip-milkdownMarkdownGuards.ts` back to
   `src/features/editor/milkdownMarkdownGuards.ts`.
2. Apply `roundtrip-wip-MilkdownEditor.svelte.patch` to
   `src/features/editor/MilkdownEditor.svelte` (or redo the 5 small edits by hand —
   they're short and the patch context makes them unambiguous).
3. Fix the 2 known remaining regressions in `protectInlineBreaks`'s isolation logic:
   - Generalize `isSoleTableCellContent` so it runs on the remainder AFTER stripping
     `BLOCK_PREFIX_RE` (currently they're checked as alternatives, not composed) —
     handles table-inside-blockquote/list (`idx 25957`).
   - Add a footnote-definition alternative (`\[\^[^\]]+\]:[ \t]+`) to
     `BLOCK_PREFIX_RE` — handles footnote-definition-content-is-just-`<br />`
     (`idx 8560`).
4. Investigate the 16 remaining `html_loss` notes (indices captured in
   `idx*-body.txt` for several of them already) — not yet root-caused, may or may not
   be `<br>`-related.
5. Re-run the full corpus (`POOL_SIZE=8 node harness/run.mjs` from the scratchpad
   root) and diff `corpus-results.jsonl` against `corpus-results-baseline.jsonl` (see
   the diffing one-liner pattern used throughout this session — load both as
   `Map<idx, flags>`, compare) until **zero** newly-introduced regressions remain and
   `<br>`-deletion / empty-link-loss are fully at 0 for their specific classes.
6. Re-run `pnpm run check:svelte` (not re-run since the last guards.ts edit — should
   be fine, but confirm) plus the 4 scratchpad smokes one more time after the final
   corpus-clean version, then hand off / report per the original task's verification
   checklist.
7. Write `scratchpad/corpus-report-after-fix.md` (the original task asked for this —
   not yet written since the corpus wasn't clean yet) with the final before/after
   numbers table once step 5 is truly clean.

## Ground rules that were being followed (still apply)

- Fix is 100% editor-layer string transforms (`milkdownMarkdownGuards.ts` +
  `MilkdownEditor.svelte` wiring) — no preset forking, no new npm deps, no top-level
  await, Svelte 5 runes only (the module itself is plain functions, no runes needed).
- Preserved HTML renders INERT (as literal text via the existing `html` node schema's
  `toDOM`, a `<span>` with the tag string as its **text** child, never `innerHTML`) —
  this was true before the fix and remains true; the fix only changes WHICH `<br>`
  occurrences reach that (already-inert) rendering path.
- Did not touch: load-echo suppression logic, block drag handles (mouse/touch), the
  54px gutter padding, formatState emission, checkbox/link tap handling, toolbar EXEC
  commands — confirmed via the 4 scratchpad smokes still passing.
