# Entity Lab (Experiment Spike)

Offline experiment workspace for auto-tagging and entity extraction on markdown notes using a local LLM. Intentionally separate from app/runtime code so quality can be tuned on real notes before product integration.

## Prerequisites

- Linux/macOS machine with Ollama running
- Model pulled locally: `ollama pull qwen3:8b`

---

## Tag Pipeline (Recommended)

Automatically discovers and assigns broad topic tags (e.g. "software", "finance", "journaling") to notes. Designed for sidebar navigation — tags are reusable categories, not per-note labels.

### How It Works

Three-phase pipeline:

1. **Discovery (per-note, no shared state):** Asks the LLM for 1-3 freeform topic tags per note. No constraints, no pre-existing list. Uses `--think` mode (Qwen3 chain-of-thought) for better accuracy.

2. **Consolidation (no LLM, pure data processing):** Aggregates raw tags across all notes, counts frequencies, merges near-duplicates via fuzzy string matching, and prunes any tag appearing on fewer than 2 notes. This mechanically eliminates one-off "hanging" tags.

3. **Assignment (per-note, fixed tag list):** Goes back through every note with the canonical tag list. The LLM picks 0-3 tags from the list and cannot invent new ones. Runs without `--think` for speed — the taxonomy is already curated, so assignment should be permissive.

### Why This Design

- **No ordering bias.** Unlike incremental tagging (where early notes set the vocabulary), every note contributes equally to tag discovery in phase 1.
- **No context-window limit.** Unlike summarize-all-then-tag, you never need to fit all notes into a single prompt.
- **No hanging tags.** The consolidation step prunes by frequency, guaranteed.
- **Thinking where it matters.** Discovery benefits from reasoning ("what is this note actually about?"). Assignment doesn't — it just needs to pick from a list.

### Findings (50-note test, 2026-02-28)

Three configurations were tested:

| Config | Time (50 notes) | Untagged | Min tag size | Quality |
|---|---|---|---|---|
| No thinking (either phase) | ~2 min | 4 | 2 notes | Overtags — assigns wrong categories (e.g. "front license plate" → software, ai) |
| Thinking (both phases) | ~25 min | 13 | 1 note | Undertags — too conservative in assignment, leaves obvious notes blank |
| **Thinking discover + no-thinking assign** | **~20 min + ~45s** | **3** | **2 notes** | **Best balance — accurate taxonomy, permissive assignment** |

The hybrid produced 17 tags from 50 notes with only 3 correctly untagged (GFM Test, Skyline, Untitled 6). Every tag had at least 2 notes. Tags feel natural for sidebar browsing: software, ideas, ai, fitness, finance, books, music, humor, travel, journaling, etc.

Known issues at 50-note scale:
- "front license plate" still mistagged as software/ai (assignment too eager on that one)
- "technology" overlaps with "software" — may merge at full scale
- Speed: discovery with thinking is ~20-25s/note on qwen3:8b (GPU). Full corpus (~2300 notes) will take ~13-16 hours for discovery, ~40 min for assignment.

### Commands

```bash
# End-to-end (recommended)
node experiments/entity-lab/scripts/tag-run-all.mjs \
  --notes-dir /path/to/notes --think

# Individual phases
node experiments/entity-lab/scripts/tag-discover.mjs \
  --notes-dir /path/to/notes --think --force

node experiments/entity-lab/scripts/tag-consolidate.mjs

node experiments/entity-lab/scripts/tag-assign.mjs \
  --notes-dir /path/to/notes --force
```

### Flags

```bash
--think              # Enable Qwen3 chain-of-thought (slower, more accurate)
--force              # Reprocess all notes (ignore content-hash cache)
--max-notes 100      # Process a subset
--mock               # Skip Ollama, use regex-based mock
--model qwen3:8b     # Override model
--ollama-host <url>  # Override Ollama endpoint
--min-count 2        # Consolidation: minimum notes per tag (default: 2)
--fuzzy-threshold 0.85  # Consolidation: similarity threshold for merging
```

### Outputs

- `cache/tag-discover.json` — Per-note raw tags (cached by content hash)
- `cache/tag-taxonomy.json` — Canonical tag list with counts and merge map
- `cache/tag-assign.json` — Per-note final assignments (cached by content hash)
- `reports/tag-assignments.json` — Machine-readable tag→notes mapping
- `reports/tags-report.md` — Human-browsable grouped report

### Files

- `scripts/tag-discover.mjs` — Phase 1: free-form tag discovery
- `scripts/tag-consolidate.mjs` — Phase 2: merge, prune, build taxonomy
- `scripts/tag-assign.mjs` — Phase 3: assign from fixed taxonomy
- `scripts/tag-run-all.mjs` — End-to-end orchestrator
- `prompts/tag-discover.md` — Discovery prompt template
- `prompts/tag-assign.md` — Assignment prompt template
- `schemas/tag-discover.schema.json` — JSON schema (discovery, used when not thinking)
- `schemas/tag-assign.schema.json` — JSON schema (assignment)

---

## Entity Pipeline (Original Spike)

Extracts granular entities (people, tools, organizations, projects, places) with aliases, confidence scores, and evidence snippets. More detailed but noisier than tagging — produced 213 entities from 50 notes with many misclassifications (pronouns as people, cast iron pans as tools, etc.).

Kept for reference but the tag pipeline is the recommended approach for sidebar navigation.

### Entity Types

- `project`, `person`, `organization`, `tool`, `place`

### Commands

```bash
# End-to-end
npm run entity-lab:run -- --notes-dir /path/to/notes

# Individual steps
npm run entity-lab:extract -- --notes-dir /path/to/notes
npm run entity-lab:normalize -- --notes-dir /path/to/notes
npm run entity-lab:reports
npm run entity-lab:review
```

### Files

- `scripts/run-extraction.mjs` — Extraction runner with Ollama + checkpointing
- `scripts/normalize-entities.mjs` — Normalization/dedupe
- `scripts/lib/entity-normalization.mjs` — Normalization logic
- `scripts/build-reports.mjs` — Report generation
- `scripts/review-queue.mjs` — Review queue
- `scripts/run-all.mjs` — Orchestrator
- `prompts/entity-extract.md` — Extraction prompt
- `schemas/entity-extraction.schema.json` — Extraction JSON schema

### Outputs

- `cache/extractions-cache.json` — Persistent hash checkpoint
- `runs/<timestamp>/` — Run-specific logs
- `reports/entities.json` — Normalized entities
- `reports/*.md` — Grouped entity reports

---

## General Notes

- Generated artifacts (`cache/`, `runs/`, `reports/`) are git-ignored except `.gitkeep`.
- All scripts support `--mock` for fast smoke testing without Ollama.
- Caching is by content hash — unchanged notes are skipped on rerun.
- The orchestrator (`tag-run-all.mjs`) passes `--think` only to discovery, not assignment.
