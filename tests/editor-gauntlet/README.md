# Editor gauntlet

This is the durable, candidate-neutral harness from the rich-text editor bakeoff. Candidate code is
kept behind `EditorGauntletAdapter`; the matrix and oracles do not import CodeMirror, TipTap, or a
native editor model.

## Components

- `split-torture.spec.ts`: 56 cases (seven inline constructs × two cases for each of Enter,
  Backspace, paste, and marker-edge typing). Every case checks the shell save payload, semantic
  source parse structure, semantic decorations and visible content, every captured post-edit
  render, persisted note bytes, and byte-exact persisted undo. "Never broken" here means the immediate post-input snapshot and the
  state after two animation frames; this browser harness cannot observe compositor paints between
  JavaScript microtasks or prove native-WebView rendering.
- `foreignPreservation.ts`: reusable foreign-corpus runner. It walks each block boundary, makes an
  isolated edit per parser-derived block (so blank lines inside fences/lists/tables stay owned by
  that construct), and reports refusals, warnings, exact-only notes, edited-block rewrites, and
  rewrites outside the edited block.
- `performanceFloor.ts`: the 1k/10k/50k-line and TipTap-benchmark-shaped generated 10 MiB fixtures,
  with the bakeoff's 1,000 ms settled-open and 16 ms synchronous keystroke-p95 budgets.
  Settled-to-paint is reported separately but is not gated: a raw one-frame sample is phase-dependent
  and already approaches 16.7 ms on a 60 Hz display even when the editor does no work.
- `feelOracle.ts`: adapts candidates to the existing factory `DriverState`; `just factory-judge`
  remains a human-read divergence report, never a pass/fail gate.
- `cm6Adapter.ts`: current-main CM6 implementation of the shared boundary.

Run the current CM6 split baseline from the repository root:

```sh
pnpm exec playwright test tests/editor-gauntlet/split-torture.spec.ts
pnpm run test:editor-gauntlet:perf

# Read ~/Developer/futo-notes-ml/NOTICE.md first. Start with sample.jsonl;
# point at notes_corpus.jsonl.gz for the complete census.
EDITOR_GAUNTLET_CORPUS=~/Developer/futo-notes-ml/dataset/sample.jsonl \
  EDITOR_GAUNTLET_CORPUS_LIMIT=100 pnpm run test:editor-gauntlet:foreign
```

Corpus-derived inputs and reports must stay local. Read `~/Developer/futo-notes-ml/NOTICE.md`
before using the foreign corpus, and do not commit derived fixtures.
