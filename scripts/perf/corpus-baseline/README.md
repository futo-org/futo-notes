# Corpus-based Android editing baseline

Analyze the public `futo-notes-ml/dataset/notes_corpus.jsonl.gz` corpus:

```sh
FUTO_NOTES_CORPUS=/path/to/notes_corpus.jsonl.gz just corpus-baseline --revision <ml-git-sha>
```

Then claim the physical reference phone and run the generated fixtures:

```sh
just qa-claim android --serial <serial>
ANDROID_SERIAL=<serial> just test-android-text-first-bench --fixtures .futo/corpus-baseline/fixtures
```

`--keys 50` is the default for this mode. `--only listItems-p95` selects a prefix;
`--stress` runs the separately retained P100 examples. Repeat the same command to
check stability. The separate `.perf.dev` package preserves the existing dev app.
The recipe builds the release-ffi engine and a non-debuggable, unminified Android
perf app. Do not compare this configuration directly with R8 real-keyboard runs.

Use `--source-types github,obsidian-publish --out .futo/corpus-baseline/personal`
when analyzing the corpus to export the personal-note-source subset separately.
The full-corpus and subset reports retain their respective denominators.

## Sampling

Each deduplicated note has equal weight. Structural percentiles use the largest
matching structure in each note, conditioned on that feature being present:

- Note size: UTF-8 bytes of the complete original Markdown.
- Paragraph: UTF-16 source units, including inline syntax and soft line breaks;
  paragraphs within lists are excluded. Code fences are excluded.
- List: all descendant items in one outer list, including nested items;
  continuation lines do not count as items. Depth is reported separately.
- Table: rows (including header, excluding separator) times header columns,
  including empty cells.

Lezer CommonMark + GFM supplies corpus descriptors, not application editing rules.
Its interpretation can differ from the canonical engine. Device setup therefore
requires the source target to map to literal text through Rust's correspondence
and requires a table target to open an actual cell. Invalid targets fail visibly.

Nearest-rank P50/P95/P99 thresholds describe the corpus, not latency. Three notes
nearest each threshold are selected deterministically by value distance then
content hash. The full note is retained, so surrounding structure still affects
layout. Notes without an editable literal target are skipped; the manifest records
the actual selected value, not just its requested percentile. One maximum case per
metric is kept separately. These selected cases are diagnostic probes, not a
random sample from which to estimate overall user latency.

The caret targets a middle item's literal end in the largest list, a middle cell
in the largest table, or a literal position in the longest non-list paragraph.
For note-size probes, the longest editable paragraph is preferred. Targets are
stored as source UTF-8 offsets and mapped by Rust before timing.

The corpus is public-web material, not usage telemetry. `analysis.json` includes
source-type distributions and conditional percentiles so a large contributing
source cannot silently stand in for all users. Corpus SHA-256, supplied revision,
whole-note hashes, original dimensions and source URLs make selection repeatable.

## Measurements

The existing native view harness measures input-connection dispatch through
`onDraw`, excluding Gboard, GPU and panel latency. Type, Enter and Backspace each
start at the same original target. After every warmup and measured edit, an untimed
Undo must restore the exact source; selection is restored and the UI is drained
before the next trial. The final close must preserve the original saved note.
Table trials measure typing and Backspace through the cell connection; Enter is
not included because its cell semantics differ from paragraph Enter. This does
not measure the Compose cell overlay or the real keyboard.

Reports include per-trial durations, stage distributions, sample/refusal/timeout
counts and selection setup time. Raw timing columns are total, editor, UI queue,
text apply, spans/layout, frame wait, draw, frames late, engine, Kotlin. Stage
percentiles are not additive. The open callback is engine/controller readiness,
not first readable presentation. `firstTextDrawNs` separately records the first
onDraw containing text, once per fixture; it excludes navigation and GPU/panel
latency and is not an opening-latency percentile. There is no new latency pass/fail threshold;
collection fails on missing fixtures, refusals, timeouts or incomplete trials.

The original extremes mode is retained for historical comparisons. Its sequential
edits mutate the fixture and its default midpoint is not structure-targeted, so
its timings are not interchangeable with these reset-between-trial measurements.
