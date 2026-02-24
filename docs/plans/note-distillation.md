# Note Distillation: Batch LLM Processing for Knowledge Extraction

Pre-process every note through a local LLM to extract structured knowledge. This transforms 600k tokens of raw markdown into a dense, queryable knowledge layer that small models can actually reason over at query time.

See `search-proposal.md` for the foundation and `next-gen-search.md` for query-time enhancements this complements.

---

## The Problem

Semantic search finds *relevant notes*, but answering questions requires *synthesis*. A query like "what did I decide about the database migration?" might match 8 notes totaling 8k tokens — too much for a 7B model's effective context, and definitely too much for fast inference.

Meanwhile, we have a resource that's cheap but underutilized: **idle time**. The server already runs overnight indexing for embeddings. A full pass over 652 notes at ~30-60s each fits comfortably in an 8-hour window.

## The Idea

For each note, run a local LLM to extract:

1. **Atomic claims** — standalone facts, decisions, ideas (5-15 per note)
2. **Summary** — 2-3 sentence distillation
3. **Entities** — people, projects, tools, dates, places

Store these as a new indexed layer alongside existing embeddings. At query time, retrieve *claims* instead of (or in addition to) raw chunks — 10x denser, so a small model can synthesize answers from 20+ notes worth of material in <3k tokens.

---

## What Gets Extracted

### Atomic Claims

The core output. Each claim is a single, self-contained statement that makes sense without reading the original note.

```
Note: "weekly standup 2025-01-13.md"
Raw content: "Discussed the auth migration. Sarah said we should hold off until
after the v2 launch because the current JWT setup works fine and the migration
would touch every endpoint. I agree — the risk isn't worth it right now.
Mike is going to document the current auth flow so we don't lose context."

Claims extracted:
- "Auth migration was deferred until after v2 launch (decided 2025-01-13)"
- "Current JWT auth setup is considered sufficient for now"
- "Auth migration would require touching every endpoint"
- "Mike is documenting the current auth flow"
- "Sarah recommended deferring the auth migration"
```

Properties of good claims:
- **Self-contained**: Makes sense without the source note
- **Attributed**: Includes dates, people, or context when available
- **Specific**: "Auth migration deferred until after v2" not "A decision was made"
- **Deduplicated**: If two notes say the same thing, the claim appears once (with both sources)

### Summary

Brief distillation. Useful for search result previews and for providing context when retrieving claims.

```
"Weekly standup notes from Jan 13. Key decisions: defer auth migration until
after v2 launch. Mike to document current auth flow."
```

### Entities

Structured extractions for building a lightweight knowledge graph.

```json
{
  "people": ["Sarah", "Mike"],
  "projects": ["v2 launch", "auth migration"],
  "tools": ["JWT"],
  "dates": ["2025-01-13"],
  "decisions": ["defer auth migration"]
}
```

---

## Architecture

### New Index Level

Fits into the existing tiered search architecture:

| Level | Type | When | What |
|-------|------|------|------|
| 0 | FTS5 | Realtime | Full-text keyword search |
| 2 | Embeddings | Overnight batch | Semantic vector search |
| **4** | **Distillation** | **Overnight batch** | **Claims, summaries, entities** |

Level 4 because it depends on having a generative LLM loaded (heavier than embedding models) and runs slower per note.

### Storage Schema

```sql
-- One row per extracted claim
CREATE TABLE search_claims (
  claim_id    INTEGER PRIMARY KEY,
  uuid        TEXT NOT NULL,          -- source note
  claim_text  TEXT NOT NULL,          -- the atomic claim
  claim_type  TEXT DEFAULT 'fact',    -- fact | decision | question | idea | task
  FOREIGN KEY (uuid) REFERENCES notes(uuid)
);

-- One row per note (summary + raw entity JSON)
CREATE TABLE search_distillations (
  uuid        TEXT PRIMARY KEY,
  summary     TEXT NOT NULL,
  entities    TEXT NOT NULL,          -- JSON: {people, projects, tools, dates, ...}
  FOREIGN KEY (uuid) REFERENCES notes(uuid)
);

-- Claims get embedded too (reuse existing vector infra)
-- Embed claims into the same search_vectors table with a different source
-- Or a separate search_claim_vectors table if we want different dims/model
```

Claims also get embedded into the vector index so they're retrievable via semantic search — same pipeline as note chunks, just shorter text inputs.

### Processing Pipeline

```
For each dirty note:
  1. Read note content
  2. Prompt LLM → structured JSON output (claims + summary + entities)
  3. Parse + validate JSON
  4. Delete old claims/distillation for this note
  5. Insert new claims + distillation
  6. Embed claims into vector index
  7. Update search_index_state for level 4
```

### LLM Prompt

```
You are extracting structured knowledge from a personal note.

Given the note below, output JSON with:
- "claims": array of 5-15 atomic facts, decisions, or ideas. Each should
  be a single self-contained sentence that makes sense without the original
  note. Include dates, names, and context when available.
- "summary": 2-3 sentence summary of the note.
- "entities": {"people": [], "projects": [], "tools": [], "dates": [], "places": []}

Note title: {title}
Note content:
{content}
```

Keep it simple. Don't over-engineer the prompt — a 7B model with a clean instruction and structured output format will get 80% quality. We can iterate on the prompt later.

### Model Selection

Reuse the existing benchmark infrastructure. Distillation needs a *generative* model, not just an embedding model, so this is a separate model load.

| Hardware tier | Model | Per-note time | 652 notes |
|---------------|-------|---------------|-----------|
| Strong desktop (RTX 3060+) | Qwen3-8B Q4 | ~15-30s | ~3-5 hrs |
| Mini PC / decent CPU | Qwen3-4B Q4 | ~30-60s | ~5-10 hrs |
| Raspberry Pi 5 | Qwen3-1.7B Q4 | ~60-120s | ~11-22 hrs |
| Weak hardware | — | — | Disabled |

The overnight window (8 hrs) determines which model is feasible. Run a benchmark similar to the embedding benchmark but measuring tokens/second for generation.

If the full corpus doesn't fit in one overnight window, that's fine — the job runner already supports checkpointing and resumption. Process 300 notes tonight, finish the rest tomorrow.

---

## Query-Time Usage

### Scenario: "What did I decide about the auth migration?"

**Without distillation** (current):
1. Embedding search returns 8 note chunks (~8k tokens)
2. Need a large context window to synthesize
3. 7B model struggles, misses context from chunk boundaries

**With distillation**:
1. Embedding search over *claims* returns top 20 claims (~1.5k tokens)
2. Optionally include summaries of source notes (~500 tokens)
3. Total context: ~2k tokens — a 7B model handles this easily
4. Answer: "You decided on Jan 13 to defer the auth migration until after v2 launch. Sarah recommended this because it would touch every endpoint. Mike was assigned to document the current auth flow."

### Retrieval Strategy

```
query → embed query
     → search claim vectors (top 20 claims)
     → search chunk vectors (top 5 chunks, as backup)
     → fetch summaries for source notes of top claims
     → pack into context: claims + summaries + source chunks
     → LLM generates answer
```

Claims-first retrieval is denser and more precise. Raw chunks serve as fallback for notes that haven't been distilled yet or for queries where verbatim content matters.

### Search Result Enhancement

Even without a query-time LLM, distillations improve the existing search UI:

- **Better previews**: Show the summary instead of a raw text snippet
- **Entity search**: "Find all notes mentioning Sarah" → instant, no embedding needed
- **Related notes**: Notes sharing entities or similar claims are related
- **Decision log**: Filter claims by type=decision → automatic decision history

---

## Integration with Existing Infrastructure

### What We Reuse

- **Job runner** (`jobRunner.ts`): Batch processing with checkpointing — add level 4 processor
- **Dirty tracker** (`dirtyTracker.ts`): Detects which notes need re-processing
- **Scheduler** (`scheduler.ts`): Overnight window, idle detection — same triggers
- **Model manager** (`modelManager.ts`): Extend to support generative models (currently embedding-only)
- **Benchmark** (`benchmark.ts`): Add generation speed benchmark
- **Vector DB** (`vectorDb.ts`): Embed claims the same way we embed chunks
- **Artifact builder** (`artifactBuilder.ts`): Include claims in the downloaded artifact

### What's New

- `distillationProcessor.ts` — Level 4 processor (reads note → prompts LLM → stores results)
- `generativeModelManager.ts` — Loads generative GGUF models via node-llama-cpp (separate from embedding model)
- Generative model registry entries (Qwen3 instruct models, GGUF format)
- New DB tables: `search_claims`, `search_distillations`
- Extended artifact format: include claims + summaries in the downloadable artifact
- Client-side claim search (query claims locally, same as current MiniSearch but over claims)

### Scheduling

Distillation is heavier than embedding, so it runs *after* embedding indexing completes:

```
Overnight window opens (02:00)
  → Level 0: FTS5 indexing (fast, seconds)
  → Level 2: Embedding indexing (minutes to ~1 hr)
  → Level 4: Distillation (hours, remainder of window)
Overnight window closes (06:00-10:00 depending on hardware)
```

If the window is too short, distillation checkpoints and resumes the next night. Embedding indexing always takes priority since it's more broadly useful.

---

## Incremental Processing

Distillation is expensive, so we only process *changed* notes:

1. On first run: process all 652 notes (may take 2-3 nights)
2. On subsequent runs: only process notes where `content_hash` changed since last distillation
3. Typical nightly load: 5-20 modified notes → 5-20 minutes even on slow hardware

The `search_index_state` table already tracks `content_hash` per level. Level 4 entries tell us exactly which notes need re-distillation.

---

## Deduplication (Stretch Goal)

If the same fact appears in multiple notes (e.g., a meeting note and a project doc both mention the auth migration decision), we get duplicate claims. Options:

1. **Keep duplicates, rank by frequency**: If a claim appears in 3 notes, it's probably important. Use duplicate count as a relevance signal.
2. **Embed-and-dedupe**: After extracting claims, embed them and cluster by cosine similarity. Merge claims above 0.95 similarity, keeping the most detailed version and linking all source notes.
3. **Ignore it**: Duplicate claims in search results are mildly annoying but not harmful. The reranker (Level 3) will naturally surface the best-worded version.

Start with option 1. Add option 2 later if duplication becomes noisy.

---

## Privacy and Safety

All processing happens locally. No note content leaves the device/server.

- Models run via `node-llama-cpp` (same as embeddings) — no API calls
- Claims and summaries are stored in the same SQLite DB as embeddings
- The artifact (if downloaded to client) contains claims but stays on-device
- Users who disable search also disable distillation (same `SEARCH_ENABLED` flag)

---

## Success Metrics

- **Claim quality**: Manual review of 50 random notes. Are claims accurate, self-contained, and useful? Target: 80%+ "good" claims on first pass with prompt tuning.
- **Query-time density**: For a typical question, can we fit enough context from claims alone (without raw chunks) for a 7B model to answer correctly? Target: 5x compression ratio vs. raw chunk retrieval.
- **Incremental cost**: After initial corpus processing, nightly runs should complete in <30 minutes for typical daily note activity (5-20 notes).

---

## Implementation Order

1. **Schema + processor skeleton**: New tables, level 4 registration, empty processor
2. **Generative model manager**: Load Qwen3 instruct models via node-llama-cpp, generation benchmark
3. **Distillation processor**: Prompt → parse → store pipeline
4. **Claim embedding**: Embed extracted claims into vector index
5. **Query endpoint**: `POST /search/query` that retrieves claims + synthesizes answers
6. **Artifact extension**: Include claims/summaries in client-downloadable artifact
7. **Client integration**: Display summaries in search results, entity-based browsing
8. **Deduplication**: Cluster similar claims across notes
