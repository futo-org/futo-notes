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
- `performanceFloor.ts`: the generated line and TipTap-benchmark-shaped adversarial fixtures, with
  the bakeoff's 1,000 ms settled-open and 16 ms synchronous keystroke-p95 budgets. Two ladders:
  CM6 keeps a hard open budget at every size, and Milkdown uses the policy
  docs/plan/milkdown-transition.md §5 sets — hard budgets at sizes real notes reach (1k/10k lines,
  1 MiB), and "scales linearly, no cliff" at 50k lines and 10 MiB, each measured against a
  hard-gated fixture built by the same generator. The keystroke budget applies at every size.
  Settled-to-paint is reported separately but is not gated: a raw one-frame sample is phase-dependent
  and already approaches 16.7 ms on a 60 Hz display even when the editor does no work.
- `feelOracle.ts`: adapts candidates to the existing factory `DriverState`; `just factory-judge`
  remains a human-read divergence report, never a pass/fail gate.
- `cm6Adapter.ts`: current-main CM6 implementation of the shared boundary.
- `milkdownAdapter.ts`: the Milkdown implementation. It drives the single-file `editor.html` the
  native shells ship, over `file://`, with the editor-embed harness's fake native host — that is
  where Milkdown lives during the transition, so there is no app shell to drive. Two translations
  it owns: markdown source offsets become (top-level block, visible-character offset) via
  `sourcePositions.ts`, and the factory `DriverState` is read off the rendered ProseMirror DOM.
- `lossOracle.ts`: "did any writing disappear?", as a token multiset containment check. This is the
  bar a WYSIWYG candidate is held to instead of byte fidelity (ADR-0002), and it is the same
  question the round-trip corpus census asked.
- `scoreBaseline.ts` + `milkdown-split-torture.baseline.json`: the recorded score. A case that
  starts failing is a regression; a case that starts passing while still listed is a stale entry.
  Both are red.

## Running it

Every recipe is in the justfile; reports land in the gitignored `local/`.

```sh
just gauntlet-milkdown        # 56-case split-torture matrix, scored against the ledger
just gauntlet-milkdown-perf   # performance floor
just gauntlet-cm6             # the same matrix against the shipping CodeMirror editor
just gauntlet-cm6-perf
```

### Where Milkdown stands (recorded 2026-08-28, desktop chromium)

**Split torture: 36 of 56.** The 20 failures are three families, all in
`milkdown-split-torture.baseline.json` with a reason each: the wikilink is an atom node (8), a caret
on a mark boundary types outside the mark (7, ProseMirror mark inclusivity), and pasted text
inherits the mark of the range it replaced (4).

The wikilink family is not a defect — the link survives every one of those eight cases intact. An
atom has no inside, so a case written to split a construct mid-span has no answer in this editor;
the caret resolves to an edge and the matrix records what happens instead. Treat those eight as a
question for the §4 parity audit, not a bug list. Zero of 56 undos are byte-for-byte
identical — every one adds a trailing newline. That is normalize-once, which is why undo is checked
for loss rather than for bytes, and the count is in the report as the scorecard (plan D4).

**Performance floor: fails, and the report says exactly where.** Open misses the 1 s budget at
10,000 lines, and synchronous keystroke p95 misses 16 ms at 50,000 lines and 10 MiB. Absolute
numbers move 20-40% between runs on the same machine, so read the report file for a given run's
figures rather than quoting a constant.

What the run does NOT show is a cliff: per-line open cost at 50k is 1.4x the 10k cost and per-byte
cost at 10 MiB is 0.3x the 1 MiB cost, so the scaling claim behind the transition holds. The gap is
that progressive open (plan §5 / D7) is not built — the editor parses and mounts the whole document
before it is interactive. Adding the perf probe's `content-visibility` stylesheet to the live page
does not close it, so that rule is a keystroke-layout lever, not an open-cost one.

Two things about how the floor is judged, both deliberate:

- **The open gate measures time-to-fully-loaded, and the plan budgets
  time-to-interactive-first-viewport.** Those are the same number today, because there is no
  progressive open and therefore no earlier milestone to measure. Time-to-fully-loaded is an upper
  bound: beating it certainly beats the budget, missing it does not certainly miss it. Re-point the
  gate when the first-viewport milestone exists.
- **The adversarial fixtures carry no absolute open budget.** The plan states the note-size
  population in lines (corpus max 19,295; vault max 13,876), so it has nothing to say about a
  1 MiB TipTap-benchmark-shaped document. That fixture is measured and reported, and it earns its
  place by anchoring the 10 MiB linearity check — a per-byte comparison needs a smaller reading from
  the same generator.

The floor is asserted, not ledgered: three numbers you read directly, where a stale perf ledger
would rot and a noisy one would flake.

### The CM6 baseline

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

The Milkdown sweep (`just gauntlet-milkdown-foreign`) takes the same environment variables and
shards the same way, but asserts the LOSS-ONLY bar — never refuse, never warn, never lose — instead
of byte fidelity. A round trip through a WYSIWYG editor renormalizes markdown across the whole
document (a mixed 8-note smoke rewrote 10 of 11 edited blocks), so the rewrite counters stay in the
report as normalize-once evidence and are no longer pass conditions. Loss is judged by
`lossOracle.ts`; on that smoke it found the census's two real loss classes (a deleted inline `<br>`
fusing two words, and an empty-text link deleted href and all) and flagged nothing on the six benign
notes. Reports are `foreign-preservation-v4`, which is not comparable to a v3 one.

Corpus-derived inputs and reports must stay local. Read `~/Developer/futo-notes-ml/NOTICE.md`
before using the foreign corpus, and do not commit derived fixtures.
