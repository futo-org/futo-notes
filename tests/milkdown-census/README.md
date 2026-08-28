# Milkdown round-trip census

Runs a corpus of real notes through a real Milkdown editor and reports what
opening and re-saving each note would change.

```
just milkdown-census --limit 200                        # ~4s smoke
just milkdown-census --variant baseline                 # the UNPATCHED preset
just milkdown-census --diff build/milkdown-census/baseline
just milkdown-census --vault ~/Documents/futo-notes     # your own notes
```

## What it is for

`packages/editor/src/milkdown-compat/` repairs three Milkdown round-trip
defects. This harness is how they were found, how "fixed" was established, and
how a future change to them is shown to cost nothing. The findings live in
`docs/editor/milkdown-roundtrip-census.md`; per D4 of the transition plan the
numbers are a scorecard, not a release gate.

## Layout

| file | what it is |
|---|---|
| `entry.ts` | the browser side — a real editor with the app's plugin chain and load sequence, exposed as one `load(variant, markdown)` call |
| `build.mjs` | esbuild bundle + page, also used by `tests/editor-embed-milkdown-compat.spec.ts` |
| `detectors.mjs` | what counts as a flag |
| `run.mjs` | the driver: corpus in, `results.jsonl` + `summary.json` out |
| `probe.mjs` | prints a handful of cases through both variants — the fastest way to see what a change does |

`entry.ts` imports the compat plugins from source, so the census can never drift
from what the app ships. It mounts commonmark + gfm only — not the wikilink
plugin (#101), which needs the app's note index and so cannot be bundled here;
that plugin carries its own differential and embed-seam tests, and the effect on
these numbers is that `[[wikilink]]` escaping still shows up as a difference. It mirrors `MilkdownEditor.svelte`'s load path exactly:
`defaultValueCtx` at creation followed by an immediate `replaceAll` of the same
content. A `defaultValueCtx`-only reading manufactures instability on every
list/table/quote/fence note, because the `trailing` plugin has not settled.

## Variants

`--variant compat` (default) is what the app ships. `--variant baseline` is the
unpatched upstream preset, and it is how a comparison gets produced from this
harness rather than from a set of numbers nobody can re-derive: run baseline,
run compat with `--diff`, read the newly-raised flags. `--diff` exits non-zero
if there are any.

## The flags

Two are precise measurements of the loss classes the compat plugins exist to
eliminate. The acceptance criteria are stated against these:

- `br_loss` — the note came back with fewer `<br>` tags than it went in with.
- `empty_link_loss` — a `[](url)`'s URL is not in the output at all.

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
