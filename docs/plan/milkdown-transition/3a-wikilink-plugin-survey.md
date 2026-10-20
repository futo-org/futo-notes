## 3a. Wikilink plugin — survey result (T4 / #101)

The ticket required a survey before a line of plugin code: adopt a maintained
extension if one fits, build only if none does. **None does — built.**
Measured 2026-08-28 against Milkdown 7.22.1's own pipeline (remark 15, micromark
4, mdast-util-from/to-markdown 2), on two requirements: serialize `[[target]]`
back byte-for-byte, and tokenize exactly what `WIKILINK_RE` tokenizes.

| candidate | downloads/mo | verdict |
|---|---|---|
| `remark-wiki-link@2.0.1` | 89k | Parses under micromark 4 despite stale declared deps, but ESCAPES `*`, `_`, `[`, `\` inside the target on serialize — `[[a_b_c]]` returns as `[[a\_b\_c]]` (9/26 byte diffs), and splits on its `:` alias divider (3/26 target mismatches). |
| `@moritzrs/*-ofm-wikilink@0.0.1` | 5.7k | Obsidian semantics baked in: the node's value is the LAST path segment, `\|` and `#` split the target, `[[ x ]]` is rewritten to `[[x]]` (9/26 target mismatches). |
| `@flowershow/remark-wiki-link@4.0.0` | 3.4k | Publishes no `dist/` — the tarball is LICENSE + README + package.json. Cannot be imported. |
| `@portaljs/remark-wiki-link@1.2.0` | 2.4k | micromark 3 / mdast-util 1 generation; throws under Milkdown's pipeline (9/9). |
| `remark-wikirefs@0.0.12-rm` | 0.7k | Same generation gap; throws (10/10). |
| `mdast-util-wikilink-syntax@2.0.1` + `micromark-extension-wikilink-syntax@2.1.1` | 22 | Right generation, but parse-only — no `toMarkdown` export at all. 0 stars. |

Two findings decide it beyond the numbers. Every candidate implements Obsidian's
`[[target|alias]]` and `[[target#heading]]`, which `docs/spec/editor.md`
explicitly rejects — our rules treat the whole inner text as the target and the
Rust port pins that. And nothing on npm is version-current, maintained AND
round-trip-safe: the popular one is four years stale, the current ones are
single-author 0.0.x.

Adopting any of them would have split the wikilink grammar in two, which is the
failure mode that matters: the editor showing a chip the Rust rename rewriter
will not rewrite (a rename silently breaks the link), or the rewriter rewriting
text the editor showed as prose (a rename mangles the user's words).

So `src/features/editor/milkdown/wikilink/` states the grammar a third time and
`syntax.test.ts` locks it with a differential against `findWikilinks` — the same
shape as the TS↔Rust rule differential — over 34 hand-picked edges plus an
80-case cross-product. Registered in `scripts/drift-registry.json`.
