# Milkdown round-trip corpus report

**Corpus:** `notes_corpus.jsonl.gz`, 30,995 real notes (full corpus, not the sample).
**Editor config:** `@milkdown/kit` 7.22.1, `.use(commonmark).use(gfm).use(history).use(listener).use(clipboard).use(cursor).use(trailing)` —
identical plugin chain to `src/features/editor/MilkdownEditor.svelte`, including its exact load
sequence (`defaultValueCtx` at creation, then `replaceAll()` with the same content, mirroring
`applyExternal()` — the naive "defaultValueCtx only" reading is NOT what the app ever actually
produces, and was corrected early in harness development after it manufactured spurious
instability).
**Method:** headless Chromium (Playwright) driving the real Milkdown bundle. For every note:
`round1 = serialize(parse(body))` (via the app's real load path), `round2 = serialize(parse(round1))`,
`round3` for a subset to check settling. ProseMirror `doc.eq()` for structural equality, node-type/mark
histograms, normalized-whitespace text-content comparison, and regex heuristics for wikilinks/HTML
(corrected mid-run to tolerate CommonMark's backslash-escaping and exclude autolink syntax — see
Harness notes below).

## Headline numbers

| Metric | Count | % of corpus |
|---|---:|---:|
| Notes processed | 30,995 | 100.00% |
| Corpus JSON parse failures | 0 | 0.00% |
| Empty-body notes skipped | 0 | 0.00% |
| **Harness failures** (timeout/crash, our fault) | **0** | **0.00%** |
| **Milkdown parse/serialize failures (crash)** | **0** | **0.00%** |
| Any flag raised (info-loss or instability signal) | 704 | 2.27% |
| Unstable round-trip (`round1 ≠ round2`) | 117 | 0.38% |
| Still changing after 2 cycles (`round2 ≠ round3`) | 8 | 0.03% |
| ProseMirror doc structurally unequal (`doc.eq()` false) | 660 | 2.13% |
| Visible-text loss (normalized-whitespace mismatch) | 524 | 1.69% |
| Node/mark-count structural diff | 541 | 1.75% |
| HTML-tag-count regression (heuristic) | 64 | 0.21% |
| Wikilink-count regression (heuristic) | 1 | 0.003% (false positive, see below) |

Zero notes crashed the parser, zero notes hung, zero notes were silently dropped. Harness-side
failures were 0%, well inside the 0.5% budget — no fixups were needed for the harness's own
reliability. Full run: 30,995/30,995 notes in 112s (8 parallel pages), worst single-note latency
3.2s (a 138KB note) — no pathological blowups.

## Failure-class breakdown

Of the 704 flagged notes, classified by the actual cause (a note can match more than one class):

| Class | Count | % of corpus | Severity |
|---|---:|---:|---|
| **`<br>` deleted inside table cells / inline text (word fusion)** | 61 | 0.20% | **Real loss** |
| Numbered-looking bullet text gets a spurious `<br />` injected | 456 | 1.47% | Structural corruption (no text lost) |
| Link+emphasis mark overlap → duplicated link, split emphasis | 17 | 0.05% | Structural corruption (no text lost) |
| Empty-text link `[](url)` deleted entirely | *(rare, in "other")* | <0.01% | **Real loss** |
| Inline code span embedded newline → space | 53 | 0.17% | Acceptable (CommonMark spec) |
| Bare URL ↔ `<URL>` autolink wrapping / paren-escaping | 37 | 0.12% | Acceptable normalization |
| Trailing space inside link label trimmed | 28 | 0.09% | Trivial (whitespace only) |
| Non-CommonMark block extensions (MkDocs admonitions) lose indentation | few, in "other" | — | Expected (non-standard syntax) |
| Obsidian `[[wikilink]]` / `![[embed]]`, LaTeX `_` escaped with `\` | many, overlaps others | — | Cosmetic (literal text unchanged) |
| CRLF/CR-only line endings normalized to LF | few, in "other" | — | Beneficial normalization |
| Settles only after 2-4 edit cycles (raw HTML block indentation) | 8 | 0.03% | Cosmetic (all 8 traced; content unaffected) |

### 1. `<br>` deleted inside table cells — real, deterministic content corruption

**This is the headline bug.** GFM tables cannot contain a literal newline inside a cell, so `<br>`
is the standard way to represent multi-line cell content. Milkdown drops it with **zero
replacement** — no space, no `\n`, nothing — fusing the text on either side.

Minimal repro:
```
IN : | a | b |
     | --- | --- |
     | sentence one.<br>sentence two. | x |

OUT: | a                          | b |
     | -------------------------- | - |
     | sentence one.sentence two. | x |
```
`sentence one.` and `sentence two.` become one run-on sentence with no separating space.

Real corpus example (idx 5112, a technical comparison table):
```
BODY:   ...within the integration technology layer.<br>The integration layer includes...
ROUND1: ...within the integration technology layer.The integration layer includes...
```
Outside tables, the same tag drop happens for *any* inline (non-block-level) `<br>`/`<br/>` used
as a manual line break; whether it reads as visible corruption depends on whether the source had
surrounding spaces (`text<br/>text` fuses; `text <br/> text` merely loses the line break, leaving a
double space). Block-level `<br>` — its own line, blank lines on both sides — IS preserved
(re-emitted as `<br />`). 121 notes (0.39% of the corpus, 925 total occurrences) contain a `<br>`
tag at all; 61 of those actually trip a detectable flag (the rest have padding whitespace that
masks the loss from a naive check, but the tag itself is still gone).

### 2. Numbered-looking bullet text → spurious `<br />` injected

A bullet-list item whose visible text starts with `<digit>.` or `<digit>)` (e.g. a manually
numbered step written as a bullet, `* 1. First step`) causes Milkdown to inject a stray `<br />`
before the text and push it to an indented continuation line:
```
IN : * 0. item one
     * 1. item two

OUT: * <br />
       0. item one
     * <br />
       1. item two
```
No text is lost, but every such list item in the document acquires literal junk markup — this was
the single largest failure class (456 notes, 1.47% of the corpus), almost entirely from a handful
of notes that use "0., 1., 2." as manual step numbering inside bullets (a common pattern in
translated/Korean technical notes in this corpus, e.g. idx 4249, idx 8805, idx 9478 — the Chinese/Korean
share of the corpus is disproportionately represented here).

### 3. Link + emphasis mark overlap → duplicated link, split emphasis

When a link's text mixes an emphasized sub-run with plain text (`[_brand_ icons here](url)`), the
serializer sometimes emits two separate links sharing the same href instead of one link with a
nested emphasis mark:
```
BODY:   Check out all the different [_brand_ icons
        here](https://fontawesome.com/icons?d=gallery&s=brands).

ROUND1: Check out all the different _[brand](https://fontawesome.com/icons?d=gallery\&s=brands)_ [icons
        here](https://fontawesome.com/icons?d=gallery\&s=brands).
```
(idx 76.) The visible text is unchanged (still reads "brand icons here", all of it still linked to
the same URL) but the mark/DOM structure is corrupted — a real structural bug, 17 confirmed
instances (0.05%) where the round-trip *introduces* a duplicate href that wasn't in the source (a
broader net of 37 candidates included pre-existing, legitimate duplicate links that aren't a bug).

### 4. Empty-text links vanish entirely

```
IN : ## heading

     [](api-plan.md)

OUT: ## heading
```
A link with no visible label text is deleted outright — both the (invisible) label and the href
are gone, not just re-styled. Seen in the wild at idx 7687 (`[](api制定.md)` disappears after
round-trip). Rare (empty-text links are themselves rare) but a clean, unambiguous data-loss case
when it occurs.

### 5. Acceptable normalization (not loss)

- Inline code spans with an embedded literal newline get the newline turned into a space
  (`` `git commit\n--fixup` `` → `` `git commit --fixup` ``) — this is CommonMark-spec-mandated
  behavior (any compliant renderer does this), not a Milkdown quirk. 53 notes (0.17%).
- Bare URLs get wrapped as `<https://...>` autolinks, or the reverse (unwrapped, with parens
  escaped): `<https://...Priming_(psychology)>` → `https://...Priming_\(psychology\)`. URL content
  is byte-identical either way. 37 notes (0.12%).
- List markers (`-` → `*`), ordered-list styles, table separator spacing (`---` → `-`), and
  blockquote/fence/list spacing (a required blank line inserted before a following paragraph) are
  all routine CommonMark serializer choices, fully stable after the first load.
- A line immediately followed by `---` gets read as a Setext H2 heading (`title: fake
  frontmatter\n---` → `## title: fake frontmatter`) — this is standard CommonMark, not
  Milkdown-specific; any compliant parser does the same with this input shape.
- Obsidian-specific syntax the app doesn't understand — `[[wikilinks]]`, `![[embeds]]` — and LaTeX
  underscores (`E_{in}`) get CommonMark-escaped (`\[\[...\]\]`, `E\_{in}`) to keep them literal.
  The visible text is 100% unchanged; the extra backslashes are only a concern if the note is later
  opened in a tool that *does* interpret that syntax (Obsidian, a LaTeX renderer) — worth a note but
  not information loss inside this app.
- Non-standard block extensions this corpus contains from other tools (MkDocs `!!! note` admonitions
  with 4-space-indented bodies) lose their indentation/nesting on round-trip — expected collateral
  of syntax CommonMark was never going to understand; the text itself survives, flattened into a
  plain paragraph.
- CRLF/lone-CR line endings get normalized to LF — a fix, not a loss.
- The 8 "still changing after 2 cycles" notes all converge by round 4-5 on inspection; every one
  traced was raw-HTML-block indentation (tabs/mixed leading whitespace) being trimmed by one level
  per cycle. The visible text and all HTML attributes were byte-identical across every round in
  every case inspected — purely cosmetic re-indentation of markup nobody reads as prose.

## Perf outliers

No pathological cases. Slowest note: 3.2s for a 138KB body (idx 5764); all other notes over 500ms
were similarly large (multi-hundred-KB) documents, scaling roughly linearly with size, not
exhibiting quadratic blowup. Median well under 10ms; p99 still comfortably sub-second. No timeouts
(20s budget) were ever hit.

## Harness notes (things that looked like bugs and weren't)

- **Naive "parse once via `defaultValueCtx`" undercounts what the app actually loads.** The real
  component always follows `defaultValueCtx` with an immediate `replaceAll()` of the same content
  (`applyExternal`), which lets the `trailing` plugin settle. Comparing against a `defaultValueCtx`-only
  reading manufactured false "instability" on every list/table/quote/fence note. Fixed before the
  real run by mirroring the production load path exactly.
- **Wikilink/HTML regex heuristics needed to tolerate CommonMark's backslash-escaping**
  (`[[x]]` → `\[\[x]]` is faithful preservation, not loss) and to **exclude autolink syntax**
  (`<https://...>` is a link, not an HTML tag). Both were fixed mid-development; the single
  remaining `wikilink_loss` flag in the final run (idx 18959) is a residual false positive — a
  Wikipedia-style citation `[[50]](url)` (bracketed link text, not Obsidian wikilink syntax), not a
  real Milkdown defect.

## Verdict

Across the full 30,995-note corpus, Milkdown never crashed, never hung, and never silently dropped
a note. The overwhelming majority of round-trip differences (well over half of all flagged notes)
are the spurious-`<br />`-injection artifact on numbered-looking bullet items — ugly and worth
fixing, but not data loss. The remaining classes are dominated by spec-mandated or genuinely benign
CommonMark normalization (autolinks, code-span newlines, list markers, Setext headings).

That said, there is **one clear, real information-loss bug that should block shipping Milkdown
as-is for this corpus**: literal `<br>`/`<br/>` tags — the standard way to write a multi-line table
cell in Markdown, and a common way to force a manual line break generally — are **deleted with no
replacement whitespace**, silently fusing adjacent words/sentences together. It is 100%
deterministic, trivially reproducible, and affects real notes in this corpus (0.39% contain a
`<br>` at all; every one of them is corrupted on open, though the corruption is only visible as a
flag when the surrounding source has no padding space). A smaller but categorically identical bug
drops links whose visible text is empty (`[](url)`), losing the href too.

**Bottom line:** Milkdown is safe for this corpus in the "does it eat your note" sense — no crashes,
no vanishing paragraphs, no destroyed tables (beyond the `<br>` cell-fusion case), no eaten
frontmatter-like content, no math/HTML-comment destruction. It is **not yet safe to ship
unconditionally**: the `<br>`-deletion bug is a genuine, silent content-corruption defect that will
affect any note using `<br>` for manual line breaks (very common in tables and READMEs), and should
be fixed or the note reformatted before disk before Milkdown becomes the default editor. Everything
else found is either cosmetic, spec-compliant normalization, or a rare edge case (empty links, mark
overlap on emphasized link text) worth tracking but not blocking.

## Files

- `corpus-results.jsonl` — one JSON record per note (30,995 lines): `idx`, `content_hash`,
  `source_type`, `word_count`, `body_len`, `time_ms`, `flags` (`{}` for clean notes), plus
  diagnostic detail (`round1`, node/mark count diffs, error info) for every flagged note so failures
  can be re-examined without re-running the corpus.
- `corpus-summary.json` — the raw aggregate counters.
- `run.log` — full progress log of the production run.
- `harness/` — the harness itself (`entry.js` bundled Milkdown page, `run.mjs` the corpus driver,
  `analyze*.mjs` the post-hoc categorization scripts, `minitest*.mjs` the isolated repros referenced
  above).
