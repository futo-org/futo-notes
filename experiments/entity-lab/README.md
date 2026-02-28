# Entity Lab (Experiment Spike)

Offline experiment workspace for extracting note entities with a local LLM and building "smart album"-style grouped views (no folders).

This is intentionally separate from app/runtime code so extraction quality can be tuned on real notes before product integration.

## Scope

- Extract entities from markdown notes with Ollama (`qwen3:8b` by default)
- Cache extraction results by content hash (incremental reruns)
- Normalize/merge entities across notes
- Build browsable reports (`Projects`, `People`, etc.)
- Generate a review queue for low-confidence and risky merges

## Implemented In This Spike

- Prompt + strict JSON schema:
  - `experiments/entity-lab/prompts/entity-extract.md`
  - `experiments/entity-lab/schemas/entity-extraction.schema.json`
- Extraction runner with Ollama integration and checkpointing:
  - `experiments/entity-lab/scripts/run-extraction.mjs`
- Normalization/dedupe with many-to-many note mapping:
  - `experiments/entity-lab/scripts/normalize-entities.mjs`
  - `experiments/entity-lab/scripts/lib/entity-normalization.mjs`
- Report generation (`projects.md`, `people.md`, etc.):
  - `experiments/entity-lab/scripts/build-reports.mjs`
- Review queue generation (low-confidence/risky merge/near-duplicate):
  - `experiments/entity-lab/scripts/review-queue.mjs`
- End-to-end orchestrator:
  - `experiments/entity-lab/scripts/run-all.mjs`
- Root npm scripts:
  - `entity-lab:extract`, `entity-lab:normalize`, `entity-lab:reports`, `entity-lab:review`, `entity-lab:run`
- Generated artifacts are git-ignored except `.gitkeep`:
  - `experiments/entity-lab/cache/*`
  - `experiments/entity-lab/runs/*`
  - `experiments/entity-lab/reports/*`

## Entity Types

- `project`
- `person`
- `organization`
- `tool`
- `place`

## Prerequisites

- Linux/macOS machine with Ollama running
- Model pulled locally: `ollama pull qwen3:8b`

## Commands

From repo root:

```bash
# 1) Extract entities from notes with Qwen3
npm run entity-lab:extract -- --notes-dir /path/to/notes

# 2) Normalize + dedupe entities
npm run entity-lab:normalize -- --notes-dir /path/to/notes

# 3) Build grouped markdown reports
npm run entity-lab:reports

# 4) Optional: generate review queue
npm run entity-lab:review

# End-to-end
npm run entity-lab:run -- --notes-dir /path/to/notes
```

## Important Flags

```bash
# Override model/host
--model qwen3:8b
--ollama-host http://127.0.0.1:11434

# Rerun all notes (ignore hash checkpoint)
--force

# Process a subset
--max-notes 100

# Faster smoke testing without Ollama
--mock
```

## Outputs

- `experiments/entity-lab/cache/extractions-cache.json`
  - Persistent hash checkpoint + latest per-note extraction
- `experiments/entity-lab/runs/<timestamp>/`
  - Run-specific logs and extraction output
- `experiments/entity-lab/reports/entities.json`
  - Normalized machine-readable artifact
- `experiments/entity-lab/reports/*.md`
  - Human-browsable grouped entity reports

## Notes

- A note can map to multiple entities (many-to-many).
- Extraction is conservative: it prefers precision over aggressive merging.
- Merge risk and low-confidence mentions are surfaced in the review queue.

## Verification Evidence

Validation run on 2026-02-28:

- `node --check experiments/entity-lab/scripts/*.mjs`
  - Result: pass
- `node --check experiments/entity-lab/scripts/lib/*.mjs`
  - Result: pass
- `npm run entity-lab:run -- --notes-dir experiments/entity-lab/fixtures/sample-notes --mock --force`
  - Result: pass
  - Observed: extracted 3/3 notes, normalized entities, wrote grouped reports and review queue
- `npm run entity-lab:extract -- --notes-dir experiments/entity-lab/fixtures/sample-notes --mock`
  - Result: pass
  - Observed: `notes to process: 0`, `skipped unchanged: 3` (incremental checkpoint working)
- `npm run test:unit`
  - Result: pass (`124` tests)

## Run On Your GPU Machine

From repo root:

```bash
# 1) Ensure model is local in Ollama
ollama pull qwen3:8b

# 2) Run full entity pipeline on your notes
npm run entity-lab:run -- --notes-dir /path/to/your/notes --model qwen3:8b
```

After run:

- Inspect grouped views:
  - `experiments/entity-lab/reports/index.md`
  - `experiments/entity-lab/reports/projects.md`
  - `experiments/entity-lab/reports/people.md`
- Inspect machine-readable artifact:
  - `experiments/entity-lab/reports/entities.json`
- Inspect review queue for cleanup/tuning:
  - `experiments/entity-lab/reports/review-queue.md`

## Next Steps

1. Run first full pass on real notes with `--force` to create baseline artifacts.
2. Review `review-queue.md` and tune prompt + thresholds (`--fuzzy-threshold`, `--low-confidence-threshold`).
3. Iterate normalization guardrails to reduce false merges, especially for `person` and `project`.
4. Define quality gates (precision/merge-error checks) before folding entity extraction into product indexing.
