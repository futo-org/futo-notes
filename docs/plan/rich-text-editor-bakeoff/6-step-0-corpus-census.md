## 6. Step 0 — corpus census (run FIRST; ~1 day; re-prices everything)

Point the TipTap branch's census harness at `futo-notes-ml`:

- Input: `~/Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz`
  (30,995 notes; `dataset/sample.jsonl` for schema eyeballing).
- Measure, per note: block-map failure rate, refusal rate, exact-only rate,
  edited-block rewrite rate, and a **histogram of which constructs cause
  each**. The same numbers the 2,608-note vault census produced, on 12× the
  data — and on _foreign_ files, which is the population that matters.
- Also run the corpus through the CM6 parse/render path and count where
  today's live preview mis-renders (the factory judge's neutral-theme visual
  diff can sample this).

Why first: if wild markdown is 5–10× weirder than the reference vault
(likely — Obsidian Publish notes carry callouts, footnotes, embedded HTML,
dataview blocks), tree-owned approaches (3, and 4's mapping coverage) get
repriced downward before anyone spends two weeks on them. If it is _tamer_,
Approach 3's residue may be acceptable. Either way the histogram tells
Approach 1 exactly which constructs its intent rules must cover.

**Licensing note:** the corpus is public-web harvested. Read
`futo-notes-ml/NOTICE.md` before redistributing anything derived from it.
Using it as a local test corpus is fine; do NOT commit corpus-derived
fixtures into this repo without checking provenance — generate them locally
and gitignore them.
