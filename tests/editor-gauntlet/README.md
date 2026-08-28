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
- `foreignCorpus.ts` + `foreignPreservation.ts`: streaming, deterministically shardable
  foreign-corpus runner. It walks each block boundary, makes an isolated edit per parser-derived
  block (so blank lines inside fences/lists/tables stay owned by that construct), and reports exact
  note/block/operation accounting, failures by stage, refusals, warnings, exact-only notes,
  edited-block rewrites, and rewrites outside the edited block. Candidate case IDs use only the
  record ordinal; corpus titles, hashes, URLs, and content never enter reports.
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

Omit `EDITOR_GAUNTLET_CORPUS_LIMIT` for a complete sweep. Long runs can be split into deterministic
modulo shards. Each process needs its own dev port, Playwright run ID, and report path:

```sh
FUTO_DEV_PORT=5400 PW_RUN_ID=foreign-0 \
  EDITOR_GAUNTLET_CORPUS=~/Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz \
  EDITOR_GAUNTLET_EXPECTED_RECORDS=30995 \
  EDITOR_GAUNTLET_ARTIFACT_CAPTURE=off-retry-on-failure \
  EDITOR_GAUNTLET_SHARD_COUNT=4 EDITOR_GAUNTLET_SHARD_INDEX=0 \
  EDITOR_GAUNTLET_REPORT_PATH=tests/editor-gauntlet/local/foreign-0.json \
  pnpm run test:editor-gauntlet:foreign

pnpm run test:editor-gauntlet:foreign:aggregate -- --output \
  tests/editor-gauntlet/local/current-cm6-foreign-preservation.aggregate.json \
  tests/editor-gauntlet/local/foreign-0.json \
  tests/editor-gauntlet/local/foreign-1.json \
  tests/editor-gauntlet/local/foreign-2.json \
  tests/editor-gauntlet/local/foreign-3.json
```

The aggregate command rejects missing/duplicate shards, capped shards, shards that did not reach
EOF, mismatched compressed-corpus SHA-256/config/adapter revisions, unexpected corpus or exact
modulo-shard counts, uncompleted planned edits/caret positions, and accounting that does not
balance. The run definition is a content-derived config fingerprint shared by every batch; the
per-process `PW_RUN_ID` is deliberately excluded. Aggregate `wallMs` is the maximum shard duration,
not a misleading sum. A completed shard report is therefore resumable evidence; rerun only missing
shards.
The exhaustive mode disables Playwright video/trace/screenshots because encoding hours of green
interaction distorts the measurement. If a shard lacks its custom JSON report or has a hard
infrastructure failure, rerun that shard once with artifact capture unset for diagnosis, then rerun
it in `off-retry-on-failure` mode so its fingerprint matches the aggregate.
Playwright traces can contain editor state and ordinal case IDs, so `test-results/` and
`playwright-report/` remain denied by the root `.gitignore` alongside this directory's denied
`local/` and `generated/` evidence paths.

Corpus-derived inputs and reports must stay local. Read `~/Developer/futo-notes-ml/NOTICE.md`
before using the foreign corpus, and do not commit derived fixtures.
