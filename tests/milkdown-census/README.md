# Milkdown round-trip census

Runs a corpus of real notes through a real Milkdown editor and reports what
opening and re-saving each note would change.

```
just milkdown-census --limit 200                        # ~4s smoke
just milkdown-census --variant baseline                 # the UNPATCHED preset
just milkdown-census --diff build/milkdown-census/baseline
just milkdown-census --vault ~/Documents/futo-notes --out build/milkdown-census/vault  # your own notes
```

## What it is for

`packages/editor/src/milkdown-compat/` repairs three Milkdown round-trip
defects on the way in, and the editor's own serializer
(`packages/editor/src/markdown/`, #266) writes every note on the way out. This
harness is how the defects were found, how "fixed" was established, how the
serializer's two hard gates are measured, and how a future change to either is
shown to cost nothing. The findings live in
`docs/editor/milkdown-roundtrip-census.md`. Most numbers are a scorecard (D4 of
the transition plan); two are hard gates since #266: `content_loss` and
`second_pass_unstable` (below).

## Layout

| file | what it is |
|---|---|
| `entry.ts` | the browser side — a real editor with the app's plugin chain and load sequence, exposed as one `load(variant, markdown)` call |
| `build.mjs` | esbuild bundle + page, also used by `tests/editor-embed-milkdown-compat.spec.ts` |
| `noteIndexStub.ts` | the empty note index the wikilink plugin renders with on the census page (below) |
| `detectors.mjs` | what counts as a flag |
| `knownExceptions.mjs` | the gate notes the maintainer accepted, and the gate verdict |
| `run.mjs` | the driver: corpus in, `results.jsonl` + `summary.json` out |

`entry.ts` imports from source, so the census can never drift from what the app
ships. On `compat` it mounts every plugin of the app's chain
(`src/features/editor/milkdown/editorPlugins.ts`, same order) that changes what a
note's bytes parse into or what a save writes: the compat presets (which install
the owned serializer), the inline line-break node view, the wikilink plugin
(#101) and the table cell `<br>` reader (`table/tableLineBreak.ts`
`tableCellLineBreakRemark`). So the gates cover `[[wikilinks]]` and in-cell line
breaks exactly as the app reads and writes them. What only renders, edits or
decorates is left out. The wikilink plugin reads the app's note index, a Svelte
runes module esbuild cannot bundle; `build.mjs` resolves it to
`noteIndexStub.ts`, an empty vault, so every link renders as broken and
autocomplete offers nothing — neither changes a parse or a save. It mirrors
the app's load path exactly:
`defaultValueCtx` at creation followed by an immediate `replaceAll` of the same
content. A `defaultValueCtx`-only reading manufactures instability on every
list/table/quote/fence note, because the `trailing` plugin has not settled.

## Variants

`--variant compat` (default) is what the app ships: the compat presets read
the note and the editor's own serializer writes it. It is the variant the
serializer's two hard gates are stated against (below). `--variant baseline` is
the unpatched upstream preset, reading and writing with remark, and it is how a
comparison gets produced from this harness rather than from a set of numbers
nobody can re-derive: run baseline, run compat with `--diff`, read the
newly-raised flags. `--diff` exits non-zero if there are any.

There was an `owned` variant while the serializer was being built beside
remark-stringify; it became `compat` the day the serializer shipped (#266).

## The flags

Three are precise measurements. The acceptance criteria are stated against these:

- `br_loss` — the note came back with fewer `<br>` tags than it went in with.
- `empty_link_loss` — a `[](url)`'s URL is not in the output at all.
- `entity_inserted` — the save holds a numeric character reference the note did
  not, and it is malformed (`&#xNAN;`, `&#x61&#x3B;`) or names a character the
  note never contained. The serializer writes references on purpose (`**Note:**&#x62;ar`
  keeps a bold run), so only a bad or foreign one counts. Text GAINED is
  invisible to `text_loss`; this is the detector for it (RC-104). Must be 0.

Two are the serializer's hard gates (#266), measured on the `compat` variant
over the corpus and the vault: a change to the serializer or to the compat set
must not raise either.

- `content_loss` — the document the note reads as and the document its save
  reads as differ, once everything the house style may change on purpose is
  taken out (`houseDocument` in `detectors.mjs` lists each thing and why:
  spelling-only attributes such as the `*`/`_` marker and a list item's label,
  whitespace at a line end, a heading's line breaks, empty paragraphs no
  spelling reaches, CR line endings, an HTML block's indentation). The save
  lost or changed something the author wrote.
- `second_pass_unstable` — write, parse with the bare parser, write again: the
  bytes differ. A second save must be a no-op.

A `compat` run ends with the gate verdict (`knownExceptions.mjs`): it prints
every note either gate flagged, then `gate verdict: PASS` only if each of them
is on the known-exceptions list for that flag and every note was checked (a
note the harness timed out on was never held to the gate), and exits non-zero
on `FAIL`. An exception names one note of one corpus, never a pattern, so a
new note of the same shape still fails; a listed note that is no longer
flagged is printed so the list can shrink. The list today, all
`notes_corpus.jsonl.gz`, all `content_loss`, accepted by the maintainer
(decision 1, 2026-10-06):

| note | repro | why it is accepted |
|---|---|---|
| 8761, 9151, 9478 | `> 1. A\n> \t- B\n> \t\t- C\n> \n>2. D` | the parser reads the one-item list `C` as loose (mdast `spread`) only through the tab indentation and the whitespace-only `> ` line; the save writes it with spaces, which reads tight, as CommonMark's own rule reads it in both spellings |

Not a flag but a scorecard beside them: `first_save_churn` counts the notes
whose bytes a first save changes, and `churn_lines` the written lines a note did
not already hold. Both ignore whether the file ends in a newline: the corpus
export stripped every note's final newline, so counting it would measure the
dataset. A first save is allowed to re-spell (ADR-0002); the number shows by
how much.

The rest are broad signals, useful against a baseline rather than in isolation:
`unstable` (`round1 ≠ round2`), `unstable_persistent` (`round2 ≠ round3`),
`doc_mismatch` (the ProseMirror document changed, not just its spelling),
`text_loss`, `structural_diff` (node/mark histogram), `html_loss`,
`wikilink_loss`.

## Corpus content never gets committed

`results.jsonl` carries the round-tripped text of every flagged note, so a
`--vault` run's output is a copy of your own notes. Output goes to
`build/milkdown-census/` which is gitignored; keep it that way. The committed
write-up quotes only minimal repros.
