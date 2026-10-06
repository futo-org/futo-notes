> **2026-09-08 decision:** CommonMark now decides ambiguous list syntax. The
> bullet-number pre-pass described in the historical results below was removed;
> extra blank lines, content preservation and unchanged-open protection remain.

# Milkdown round-trip census — scorecard

What opening and re-saving a note in the Milkdown editor does to its bytes,
measured over 30,995 real notes plus the maintainer's own 2,511-note vault.
This is the evidence behind `packages/editor/src/milkdown-compat/` and the
owned serializer (`packages/editor/src/markdown/`), and the report the
transition plan's D4 asks for. Most numbers are a scorecard; since #266 two
are hard gates the serializer ships under, `content_loss` and
`second_pass_unstable` (see "2026-10-06 — the owned serializer" below).

- Harness: `tests/milkdown-census/` — `just milkdown-census`.
- Editor: `@milkdown/kit` 7.22.1, the app's core plugin chain and load sequence
  (`defaultValueCtx`, then `replaceAll`), headless Chromium. Since 2026-10-06
  (#266) `compat` mounts every plugin of the app's chain that changes what a
  note's bytes parse into or what a save writes, the wikilink plugin (#101) and
  the table cell `<br>` reader included (`tests/milkdown-census/README.md`).
  Every result dated before that was measured with commonmark + gfm only, so in
  those tables `[[wikilink]]` backslash-escaping counts as a difference the
  shipping editor did not have.
- Corpora: `notes_corpus.jsonl.gz` (30,995 notes, not in this repo) and the
  maintainer's real vault (local only — its results are never committed).
- `baseline` is the unpatched upstream preset; `compat` is what the app ships.
  Both come from the same harness on the same corpus, which is what makes the
  comparison mean anything.

## Headline

**Both real content-loss classes are at zero, and nothing regressed.**

| | baseline | compat |
|---|---:|---:|
| notes processed | 30,995 | 30,995 |
| harness failures / editor crashes | 0 | 0 |
| **`br_loss`** — the note came back with fewer `<br>` tags | **61** | **0** |
| **`empty_link_loss`** — a `[](url)`'s URL is gone entirely | **26** | **0** |
| `html_loss` — fewer HTML tags than it went in with | 61 | 0 |
| `bullet_br_injected` — a bullet's content replaced by `<br />` | 342 | 299 |
| `unstable` — `round1 ≠ round2` | 117 | 112 |
| `unstable_persistent` — `round2 ≠ round3` | 8 | 7 |
| `doc_mismatch` — the document changed, not just its spelling | 660 | 611 |
| `text_loss` — visible text changed | 482 | 437 |
| `structural_diff` — node/mark histogram changed | 541 | 493 |
| `wikilink_loss` | 1 | 1 |

Per-note diff, `compat` against `baseline`: **339 flags cleared, 0 newly
raised.** Not one note is worse off than it was.

The maintainer's vault (2,511 notes) says the same thing: `br_loss` 1 → 0,
`html_loss` 1 → 0, `bullet_br_injected` 32 → 11, `doc_mismatch` 35 → 13,
`text_loss` 34 → 12, and again **0 newly raised**.

The single remaining `wikilink_loss` is the false positive the first census
already identified (idx 18959, a Wikipedia-style `[[50]](url)` citation, not
Obsidian syntax).

### The harness reproduces the first census

`unstable` 117, `unstable_persistent` 8, `doc_mismatch` 660 and
`structural_diff` 541 match the spike's original corpus report exactly, on
a harness rewritten from scratch. `text_loss` (482 vs 524), `html_loss` (61 vs
64) and `wikilink_loss` (1 vs 1, after a detector fix — see below) differ
because those heuristics had to be re-derived; the original harness is gone.

## 2026-09-03 — the `<br />` placeholder is gone

The compat set stopped writing Milkdown's `<br />` stand-in for an empty
paragraph and spells the gap as extra blank lines instead
(`packages/editor/src/milkdown-compat/emptyLine.ts`; the list-item corollary is
`listItemFiller.ts`). Same harness, same corpus, `compat` re-run against the
same `baseline`:

| | baseline | compat (before) | compat (now) |
|---|---:|---:|---:|
| `br_loss` | 61 | 0 | 4 |
| `html_loss` | 61 | 0 | 6 |
| `bullet_br_injected` | 342 | 299 | **0** |
| `unstable` | 117 | 112 | 115 |
| `unstable_persistent` | 8 | 7 | 7 |
| `doc_mismatch` | 660 | 611 | **230** |
| `text_loss` | 482 | 437 | **60** |
| `structural_diff` | 541 | 493 | **110** |

Per-note diff against `baseline`: **1794 flags cleared, 20 newly raised.** Every
one of the 20 was read:

- `br_loss` ×3 / `html_loss` ×5 — five notes carry an author-written lone
  `<br>` on a line of its own between blank lines. That is byte-for-byte the
  shape the placeholder took, so it now loads as an empty paragraph and saves as
  blank lines. Deliberate: the two are indistinguishable, and the editor shows
  the same gap either way. Two more (`6307`, `6783`) still hold every tag after
  the save (`<<EOF` 1→1, `<c-i>` 6→6); the flag is the fence-masking counter
  artifact described under "`<br>` deletion".
- `unstable` ×7 — the 16 "digit-dot bullets indented 4+ columns" residue from
  the bullet-number fix. `    - 1. text` used to save as `* <br />` over a nested
  ordered list, forever. It now saves as `* 1. text`, which the escape then
  reads as the author meant (`* 1\. text`) on the NEXT save, and settles there
  (`unstable_persistent` is unchanged). One save late, but the right end state.
- `unstable` ×1 (`19501`) — `- * [ ]  [[x]]` with two spaces loses one on the
  second save. Same one-save-late class.
- `unstable`/`doc_mismatch`/`text_loss`/`structural_diff` ×1 (`7383`) — **not
  this change.** The note opens with a lone `---`, and with the front matter
  plugin loaded a later `> [!abstract]` callout parses as a paragraph (the
  unpatched preset gets a blockquote). Reproduced with the plugin alone;
  diverges under the chunk census at HEAD too. Filed as a finding, not fixed here.

Two regressions the first run of this change exposed were fixed before landing:
a list item whose only content is a block saved as a bare `*` line that the next
save escaped to `\*` (60 notes; the schema's filler paragraph is now left out),
and two lists separated by a blank line merged into one because the empty
paragraph reset remark's marker alternation (2 notes; the marker is carried
across). The chunk census (`just chunk-census`) is back at parity: 29,413
equivalent, 1 divergent (`7383`, above), 1,581 harness failures — the known
wikilink tokenizer crash, unchanged.

## 2026-09-08 — CommonMark owns ambiguous lists

Removed the bullet-number pre-parser. The same 30,995-note corpus, compared
against the pre-change compat build, raised **zero new flags** and cleared
28: seven each for instability, document mismatch, text loss, and structural
differences. Both runs had zero harness failures and zero editor failures.

| Detector | Before | After |
|---|---:|---:|
| `unstable` | 115 | 108 |
| `doc_mismatch` | 230 | 223 |
| `text_loss` | 60 | 53 |
| `structural_diff` | 110 | 103 |

Persistent instability (7), `<br>` loss (4), HTML loss (6), and wikilink loss
(1) are unchanged; empty-link and frontmatter loss remain zero. These are
heuristic flags with the limitations described above, not a claim of perfect
preservation. The old pre-parser's second-pass reinterpretation is gone;
`* 0. text` now consistently follows CommonMark's nested-list parse.

Reproduce with `just milkdown-census --out <after> --diff <before>` using a
baseline captured before this change. Results stayed in ignored local build
outputs; no corpus documents were added to the repository.

## 2026-10-06 — the owned serializer (#266)

Every save is now written by the editor's own serializer in one house style
(docs/spec/editor.md "Markdown house style"); remark-stringify and its patches
are gone. The census `compat` variant writes with it, and since the same day
reads with the app's wikilink plugin and table cell `<br>` reader too
(`tests/milkdown-census/README.md`).

**The two hard gates** — `compat`, run 2026-10-06 on the final #266 code:

| | corpus (30,995 notes) | vault (2,570 notes) |
|---|---:|---:|
| `content_loss` — the save reads back as a different document, once the house style's deliberate changes are taken out | 3 | 0 |
| `second_pass_unstable` — write, read, write again: the bytes differ | 0 | 0 |

The 3 corpus notes (8761, 9151, 9478) are one shape, a quoted ordered list
whose nested items are tab-indented under a whitespace-only `> ` line: the
parser reads one nested list as loose (mdast `spread`) only in the source
spelling. The maintainer accepted them as a KNOWN EXCEPTION (decision 1,
2026-10-06); the gate is not normalized to hide them. A `compat` run prints
every note either gate flags and ends with a verdict that passes only when
each is on the list (`tests/milkdown-census/knownExceptions.mjs`), exiting
non-zero otherwise:

| corpus note | flag | repro | why it is accepted |
|---|---|---|---|
| 8761, 9151, 9478 | `content_loss` | `> 1. A\n> \t- B\n> \t\t- C\n> \n>2. D` | the parser marks the one-item list `C` loose only through the tab indentation and the whitespace-only `> ` line; the save writes it with spaces, which reads tight, as CommonMark's own rule reads both spellings |

**First-save churn (story 31)** — how many notes a first save re-spells, and
how many written lines a note did not already hold (`first_save_churn`,
`churn_lines`; both ignore the final newline, which the corpus export
stripped):

| | old formatter | owned serializer |
|---|---:|---:|
| corpus notes churned | 23,569 | 20,972 |
| corpus lines churned | 431,144 | 348,618 |
| vault notes churned | 2,237 | 2,176 |
| vault lines churned | 30,958 | 27,285 |

Method. Owned: `node tests/milkdown-census/run.mjs --variant compat`, and the
same with `--vault ~/Documents/futo-notes --out build/milkdown-census/<name>`,
on the final #266 code (wikilink plugin and cell `<br>` reader mounted). Old
formatter: the same harness at 12eb1e27, before the switch (3c40a09b),
where `compat` was remark-stringify plus the compat patches; measured
2026-10-06 in a scratch run with the census page's bullet set to the app's
`-` (the page wrote `*`, which would have inflated the old number), not
committed, and without the wikilink plugin, which that page could not mount.
The owned serializer churns MORE table lines (corpus 17,747 against 12,313,
same-day run before the plugins were mounted) because it never pads columns;
everything else it re-spells less. The owned column is the run after the
Obsidian-shaped changes below.

### 2026-10-06 — Obsidian-shaped, and a cell's last `<br>` kept

Maintainer decision 2: the house style writes what Obsidian would, the bytes
the user typed and no added character references, in four places
(docs/spec/editor.md "Markdown house style"). Each change was measured on its
own, in order, with `compat` over the corpus and the vault:

| change | corpus churn (notes / lines) | vault churn (notes / lines) | other flags that moved |
|---|---:|---:|---|
| before | 20,977 / 348,632 | 2,176 / 27,287 | corpus `br_loss` 6, `html_loss` 6, `doc_mismatch` 2,930; vault `br_loss` 1, `html_loss` 1, `doc_mismatch` 15 |
| a cell's last line break is written `<br>`, not dropped | 20,977 / 348,632 | 2,176 / 27,287 | corpus `br_loss` 6 → 4, `html_loss` 6 → 4, `doc_mismatch` 2,930 → 2,928 (notes 4278, 7481) |
| a rule on line 1 is `---` unless `---` would open front matter | 20,972 / 348,625 | 2,176 / 27,287 | none |
| front matter byte for byte, CRLF included | 20,972 / 348,625 | 2,176 / 27,287 | none: neither set has CRLF front matter |
| two paragraphs in a tight item are two lines, `- a\n  b` | 20,972 / 348,625 | 2,176 / 27,287 | none: only the editor makes the shape |
| no reference for whitespace at a line's start | 20,972 / 348,618 | 2,176 / 27,285 | corpus `doc_mismatch` 2,928 → 2,930 (notes 6371, 24446) |

Both gates held at every step: corpus `content_loss` 3 (the known
exceptions above) and `second_pass_unstable` 0, vault 0 and 0, verdict PASS.

- The four `br_loss` notes left are each a `<br>` alone on a line, the
  placeholder an older build wrote for an empty paragraph, which is now an
  empty paragraph by design; the vault's one is the same.
- The whitespace rule writes a task item's `- [ ]  x` back as typed (it was
  `- [ ] &#x20;x`), which is the churn it saves. Its two new `doc_mismatch`
  notes hold `a\n<br> b`, which the parser already reads as `a`, `<br>`, a
  line break, then ` b`: the space after the `<br>` now starts a line in the
  document, so a save drops it, where it used to be written `&#x20;`.

## What each fix bought

### `<br>` deletion — 61 notes, fixed

Upstream's `remarkPreserveEmptyLinePlugin` deleted every `<br>` in the mdast
tree, wherever it sat, with no replacement:

```
IN : | a | b |
     | --- | --- |
     | sentence one.<br>sentence two. | x |

OUT: | sentence one.sentence two. | x |
```

`packages/editor/src/milkdown-compat/emptyLine.ts` replaces the plugin with a
copy that deletes the tag only where the placeholder can actually be: in block
position, or as the sole content of a paragraph or table cell.

The `html_loss` set turned out to be **exactly** the `br_loss` set — the same 61
notes, no others. That closes out the "16 uninvestigated `html_loss` notes" the
parked work left open: under a tag counter that does not mask code fences, every
`html_loss` note in the corpus is a deleted `<br>`, and all 61 are now clean.
(The parked run's 16 were an artifact of masking code fences before counting:
the round trip re-indents raw HTML blocks, which moves which backtick runs the
mask matches.)

One knock-on had to be repaired with it. remark's serializer will not write an
end-of-line directly before inline HTML — on the next parse that HTML could
start an HTML *block*, so it substitutes a space
([mdast-util-to-markdown#15](https://github.com/syntax-tree/mdast-util-to-markdown/issues/15)).
The line break that eol represented is then gone, and for a hard break it is
worse than gone: `a  \n<br/>b` came back as `a\ <br/>b`, one break short and one
visible backslash up. Since two adjacent line-break markers commute, a kept
`<br>` is moved in front of them — `a<br/>\` + newline + `b` keeps both breaks
and is stable. This is the only reason the compat set touched notes upstream
left alone, and with it the regression count is zero.

### Empty-label links — 26 notes, fixed

`[](api-plan.md)` lost its href along with its invisible label, because
Milkdown's link *mark* had no text to attach to. `emptyLink.ts` gives the link
its URL as visible text before the mark runs. One-way and deliberate; images
(`![](pic.png)`, a different mdast node whose empty label is alt text) are
untouched.

### Numbered-looking bullets — 43 of 342 notes, partly fixed

`* 0. item` is CommonMark behaving as specified: a list item's content is its
own mini-document, so `0. item` opens a nested ordered list and the item gets an
empty leading paragraph — which comes back as a literal `* <br />` plus an
indented continuation line. The former bullet-number pre-pass escaped the digit-dot before the
parse, which is the only place the ambiguity can still be resolved.

**342 → 299.** The plan scoped this fix to digit-dot ambiguity, and that is what
it does. The remaining 299 are the same placeholder mechanism reached through
different openers, and they are a different problem:

| residual | notes | why the escape does not apply |
|---|---:|---|
| `* > quote`, `* * nested`, `* # heading` | 279 | escaping would change the meaning — unlike a manual "0.", these are plausibly intentional nesting |
| digit-dot bullets indented 4+ columns | 16 | the escape allows CommonMark's 0–3 spaces; widening it would start rewriting indented code blocks, which a string pass cannot recognise |
| digit-dot inside code | 3 | correctly left alone |

**Recommended follow-up (not done here, outside this ticket's scope):** drop the
structurally-required empty leading paragraph when a `listItem`'s first child is
an empty paragraph followed by a block. That makes `* > quote` round-trip
byte-identically and covers all 299 without changing anyone's meaning. It does
not fix *rendering* — the item still shows as a nested list rather than the text
the author typed — which is why the escape is the better fix where it applies.

### YAML front matter — 8 notes, fixed, and a blind spot closed

This one is a correction to the table above as much as an addition to it. The
first census reported "no eaten frontmatter-like content", and that was wrong —
it was unmeasurable. **Every flag in this harness except `br_loss`,
`empty_link_loss`, `html_loss` and `wikilink_loss` compares round1 against
round2**, i.e. it measures STABILITY, and corrupted front matter is perfectly
stable:

```
IN : ---                        OUT: ***
     title: Front Matter Test
     tags: [a, b]                    title: Front Matter Test
     date: 2026-09-01                tags: \[a, b]
     ---                             date: 2026-09-01
                                     ----------------
```

`***` plus a setext underline round-trips to itself forever, so nothing fired —
while `tags: [a, b]` had become `tags: \[a, b]`, a changed metadata VALUE, on
the first edit anywhere in the note. `detectors.mjs` now carries a
`frontmatter_loss` flag that compares round1 against the ORIGINAL BYTES, which
is the right bar for this construct: front matter is not markdown, so ADR-0002's
normalize-once has no re-spelling of it to accept.

The 31k corpus holds only 8 notes with front matter, and all 8 sit past the line
where the corpus reader currently dies on a malformed record, so the routine
`--limit 4000` run sees none of them. Measured on a `--corpus` slice of exactly
those 8 (extracted locally; note text, so never committed):

| | baseline | compat |
|---|---:|---:|
| notes processed | 8 | 8 |
| **`frontmatter_loss`** | **8** | **0** |
| every other flag | 0 | 0 |

`packages/editor/src/milkdown-compat/frontmatter.ts` adds `remark-frontmatter`
plus an atomic, non-editable `frontmatter` node pinned to the document's first
position. The routine 4000-note run is unchanged in every column and raises no
new flag, front matter included.

## What is left, and why it is fine

The 611 `doc_mismatch` notes that remain are the classes the first census
already dispositioned as acceptable, and this work did not change any of them:
inline code spans with embedded newlines collapsing to a space (CommonMark
mandates it), bare URLs wrapping as autolinks, list-marker and table-spacing
normalization, Setext heading recognition, Obsidian `[[wikilink]]` and LaTeX
underscores being backslash-escaped to keep them literal, MkDocs admonitions
flattening, and CRLF normalizing to LF. That list is the whole breakdown — the
spike report it originally cited went away with `spike-notes/` at swap time.

Zero notes crashed the parser, zero hung, zero were dropped — in either variant,
on either corpus.

## Keeping this honest

- `tests/editor-embed-milkdown-compat.spec.ts` runs every case above against
  both variants. Its `baseline` half is a canary: when upstream fixes one of
  these bugs, that canary fails, and the local fork should be deleted.
- `just milkdown-census --variant baseline` then
  `just milkdown-census --diff build/milkdown-census/baseline` reproduces this
  table in about six minutes. `--diff` exits non-zero on any newly-raised flag.
- The two upstream bugs are drafted for filing in
  `docs/editor/upstream-milkdown-issues.md`.
