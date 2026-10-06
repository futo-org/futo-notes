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
`docs/editor/milkdown-roundtrip-census.md`; per D4 of the transition plan the
numbers are a scorecard, not a release gate.

## Layout

| file | what it is |
|---|---|
| `entry.ts` | the browser side — a real editor with the app's plugin chain and load sequence, exposed as one `load(variant, markdown)` call |
| `build.mjs` | esbuild bundle + page, also used by `tests/editor-embed-milkdown-compat.spec.ts` |
| `detectors.mjs` | what counts as a flag |
| `run.mjs` | the driver: corpus in, `results.jsonl` + `summary.json` out |

`entry.ts` imports the compat plugins (which install the serializer) from
source, so the census can never drift from what the app ships. It mounts commonmark + gfm only — not the wikilink
plugin (#101), which needs the app's note index and so cannot be bundled here;
that plugin carries its own differential and embed-seam tests, and the effect on
these numbers is that `[[wikilink]]` escaping still shows up as a difference. It mirrors `MilkdownEditor.svelte`'s load path exactly:
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
