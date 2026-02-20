# Search Proposal: On-Device + Server Supersearch

## Philosophy

Search should always be local and instant. The server's job is to build a *better* index overnight and push it to clients — not to be a query endpoint clients depend on. If you unplug the server, search still works. If the server is running, search gets progressively smarter over time.

---

## Current Baseline

- MiniSearch in memory (`src/lib/searchIndex.ts`), fields: `noteId` + `content`.
- Index rebuilt from all note files on every app launch (`src/lib/notes.ts`).
- **Bug**: `search()` converts MiniSearch results to a `Set` then filters `notesCache` — this drops relevance ordering and returns results in mtime order.
- No persisted index, no snippets, no highlighting, no query syntax, no semantic search.
- Server stores note content as `.md` files on disk after sync, but does zero indexing.

---

## Part 1: On-Device Search (Always Available, No Server Required)

Client search uses MiniSearch. This is the baseline that works everywhere with no server.

### 1.1 Fix Relevance Ordering

The most impactful change is also the smallest. Currently in `notes.ts`:

```ts
export function search(query: string): NotePreview[] {
  if (!query.trim()) return getAllNotes();
  const matchingIds = new Set(searchNotes(query));
  return notesCache.filter(note => matchingIds.has(note.id)); // ← mtime order, not relevance
}
```

`searchNotes()` returns IDs in MiniSearch relevance order, but converting to a Set and filtering the mtime-sorted cache destroys that ordering. Fix: return results in the order MiniSearch ranked them.

### 1.2 Contextual Snippets

Results currently show `note.preview` (first 100 chars of the file). If you search "raspberry" and it appears on line 47, you see the unrelated first line.

Fix: when a search matches, extract the best matching passage. MiniSearch returns match info (which terms matched, in which fields). Use this to find the first occurrence in the content and show a ~120-char window centered on it, with `...` prefix/suffix and the matched terms marked for highlighting.

```
Before: "# Meeting Notes\nAttendees: Alice, Bob..."
After:  "...discussed the **raspberry** pi cluster for the homelab setup and..."
```

### 1.3 Structured Field Indexing

Currently we index two flat fields. Split the document into weighted zones:

| Field | Weight | Source |
|-------|--------|--------|
| `title` | 5x | Filename (note ID) |
| `headings` | 3x | All `#` headings extracted via regex |
| `body` | 1x | Full content |

### 1.4 Recency Boost

For equally relevant results, gently prefer recent notes via MiniSearch's `boostDocument`:

```ts
boostDocument: (id, term, storedFields) => {
  const daysSinceEdit = (Date.now() - storedFields.mtime) / 86_400_000;
  return 1 + Math.max(0, 1 - daysSinceEdit / 30);
  // today ~2x, a week ago ~1.5x, a month ago ~1.1x
}
```

### 1.5 Persistent Index

Serialize the MiniSearch index to disk (MiniSearch has built-in `exportJSON()`/`loadJSON()`). On startup, load the serialized index + a stored mtime map, diff against current file mtimes, and only reindex changed/new/deleted notes.

```
Startup:
1. Load .search/index-v1.json + .search/mtimes-v1.json
2. List all note files with current mtimes
3. Diff → changed/new/deleted set
4. Incremental add/remove
5. Save updated index + mtimes
```

Include a version tag in the filename so schema changes trigger a clean rebuild rather than silent corruption.

### 1.6 Query Parser

Support basic query syntax that power users expect:

- `"exact phrase"` — phrase matching
- `-excluded` — exclude term
- `prefix*` — explicit prefix (implicit prefix is already on by default)

### 1.7 Keyboard Navigation

- Arrow up/down to move selection through results
- Enter to open selected result
- Typing continues to filter

### 1.8 Priority Order

| Change | Effort | Impact |
|--------|--------|--------|
| Fix relevance ordering | Trivial | High — results actually ranked properly |
| Contextual snippets | Small | High — shows *why* a result matched |
| Keyboard navigation | Small | Medium — power users |
| Structured fields | Small | Medium — better ranking |
| Persistent index | Medium | Medium — matters at scale |
| Recency boost | Trivial | Small — nice touch |
| Query parser | Medium | Small — power users |

---

## Part 2: Server Supersearch

### 2.1 Core Idea: Index Push, Not Query Proxy

The server builds richer search indexes overnight, then **pushes compact index artifacts to clients**. Clients download these artifacts and use them locally. Search is always local — the server is never in the query path at runtime.

```
                        OVERNIGHT
┌─────────────┐   sync   ┌─────────────────────┐
│   Client    │ ◄──────► │      Server          │
│             │          │                      │
│  notes on   │          │  notes on disk       │
│  disk       │          │       │              │
│             │          │       ▼              │
│             │          │  ┌────────────────┐  │
│             │          │  │ Indexer Pipeline│  │
│             │          │  │ L0 → L1 → L2   │  │
│             │          │  └───────┬────────┘  │
│             │          │          │           │
│             │          │          ▼           │
│             │          │  ┌────────────────┐  │
│             │          │  │ Compact index  │  │
│             │          │  │ artifacts      │  │
│             │          │  └───────┬────────┘  │
│             │          │          │           │
│             │  SSE:    │          │           │
│             │ ◄─ supersearch_ready            │
│             │          │                      │
│  GET /search│/index    │                      │
│  ◄─────────────────────│ download artifact    │
│             │          │                      │
│  ┌────────┐ │          └─────────────────────┘
│  │Local   │ │
│  │search  │ │   ← MiniSearch for real-time
│  │engine  │ │     + server FTS5 SQLite artifact
│  └────────┘ │     + vector index artifact
│             │     ALL QUERIES ARE LOCAL
└─────────────┘
```

**Why push instead of query?**
- Offline-first: search works identically with no server connection.
- Zero latency: no network round-trip on every keystroke.
- Privacy: query text never leaves the device.
- Simplicity: the client has one search path, not two merge strategies.

### 2.2 Progressive Index Levels

The indexer pipeline runs in the background. Each level is independently useful and builds on the previous. The server runs whichever levels its hardware can handle.

#### Level 0: Full-Text Search (SQLite FTS5)

**Runs on**: Everything (Pi included)
**Time**: Seconds for thousands of notes
**Trigger**: Immediately after any sync that modifies notes

SQLite FTS5 with Porter stemming gives us proper linguistic search that MiniSearch can't match:
- Stemming: "running" matches "run", "runner", "runs"
- BM25 ranking (better than TF-IDF for longer documents)
- Phrase queries: `"project meeting"`
- Boolean: `raspberry AND pi`, `grocery NOT walmart`
- Column weighting: title 5x, headings 3x, body 1x

```sql
CREATE VIRTUAL TABLE search_fts USING fts5(
  uuid UNINDEXED,
  title,
  headings,
  body,
  tokenize='porter unicode61'
);
```

**Artifact pushed to client**: A SQLite `.db` file containing the FTS5 virtual table. The client downloads it, opens it read-only, and queries it directly. Capacitor has SQLite plugins that can open a pre-built database file; Electron can use `better-sqlite3`. Zero index-building on client — instant search on launch. The server rebuilds the file after each sync, so the client never manages the index lifecycle.

**Multi-language note**: Porter stemming is English-only. The `unicode61` tokenizer handles Unicode word boundaries correctly for all languages (CJK, accented Latin, Cyrillic, etc.), so keyword matching works universally — only stemming is English-specific. Semantic embeddings (Level 2) handle cross-language matching.

#### Level 1: Metadata Extraction

**Runs on**: Everything
**Time**: Minutes for thousands of notes
**Trigger**: Background, after Level 0

Parse each note and extract structured metadata using patterns (no ML):

- **Dates**: ISO dates, natural language dates, relative references
- **Links**: Markdown links, bare URLs
- **Tasks**: `- [ ]` and `- [x]` with counts
- **Entities**: Simple pattern extraction (capitalized phrases, @mentions, emails)
- **Structure**: Word count, heading count, has code blocks, estimated read time

```sql
-- Included in the same SQLite artifact as FTS5
CREATE TABLE search_metadata (
  uuid TEXT PRIMARY KEY,
  dates TEXT,              -- JSON array of {value, context}
  link_count INTEGER,
  task_count INTEGER,
  task_done_count INTEGER,
  word_count INTEGER,
  note_type TEXT,         -- 'list', 'prose', 'code-heavy', etc. (heuristic)
  extracted_at INTEGER,
  content_hash TEXT       -- hash when extracted (dirty tracking)
);
```

**Artifact**: Included in the same SQLite file as Level 0. No separate download. This enables filter queries like "notes with unfinished tasks" or "notes mentioning dates in March".

#### Level 2: Semantic Embeddings

**Runs on**: Anything that scores high enough on the benchmark (including Pi with quantized models — just slower)
**Time**: First run takes a while; incremental updates are fast
**Trigger**: Overnight / idle hours, or on-demand

Generate dense vector embeddings for semantic similarity search.

**Model selection**: Based on benchmark score, not device category. On first enable, the server times a single embedding inference and selects the best model it can run within a time budget:

```
Benchmark: embed one 256-token passage, measure wall time.

< 50ms  → Qwen3-Embedding-8B (1024 dims via Matryoshka, best quality, 100+ languages)
< 200ms → Qwen3-Embedding-0.6B (512 dims, great quality, 100+ languages)
< 500ms → bge-small-en-v1.5 (384 dims, good quality)
< 2s    → all-MiniLM-L6-v2 quantized (384 dims, still useful)
> 2s    → skip Level 2 (or user can force-enable if they're patient)
```

The benchmark runs once and stores the result. User can override model choice in config.

**Runtime**: `node-llama-cpp` with GGUF models. One dependency handles everything — embeddings (Level 2), LLM generation (Level 3), and potentially reranking (see `next-gen-search.md`). GGUF models auto-download. Runs on CPU (ARM and x86) with optional GPU backend. No Python, no second Docker container — it's native Node.js bindings to llama.cpp, running in the same server process.

**Chunking**: Notes longer than ~512 tokens are split at heading/paragraph boundaries into overlapping chunks (~900 tokens, 15% overlap). Each chunk gets its own embedding. This lets us find the specific *passage* that matches.

```sql
CREATE TABLE search_chunks (
  chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);

-- sqlite-vec extension for vector storage
CREATE VIRTUAL TABLE search_vectors USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[384]
);
```

**Artifact pushed to client**: A separate SQLite file containing the chunks table + sqlite-vec virtual table. Clients use this for local semantic search — embed the query on-device (same small model, single inference) and find nearest neighbors.

If embedding the query on-device is too slow for some platforms, the artifact can also include a pre-computed "term → approximate vector" lookup table that enables lightweight semantic expansion without running a model at query time.

**Index size estimates** (float32):

| Vault size | Chunks (~3/note) | Vector data | With metadata | int8 quantized |
|------------|-------------------|-------------|---------------|----------------|
| 1,000 notes | 3,000 | 4.6 MB | ~6 MB | ~3 MB |
| 5,000 notes | 15,000 | 23 MB | ~30 MB | ~13 MB |
| 10,000 notes | 30,000 | 46 MB | ~60 MB | ~25 MB |

Easily downloadable over LAN. With int8 quantization, even large vaults stay reasonable.

#### Level 3: LLM-Augmented Index

**Runs on**: Only hardware that scores well on a generation benchmark
**Time**: Minutes to hours depending on note count (days on very slow hardware — that's fine, it checkpoints)
**Trigger**: Nightly batch

Use a small local LLM via `node-llama-cpp` (Llama 3.2 1B/3B, Phi-3 Mini, etc.) to generate:
- 1-2 sentence summaries per note
- Inferred topic categories
- Entity extraction: people, places, projects
- Cross-note connections: "same topic", "continuation", "contradicts"

**Hardware reality**: A Raspberry Pi 5 8GB ($80) runs Llama 3.2 3B at ~3-6 tok/s. Summarizing a 500-word note (~50 output tokens) takes ~10-15 seconds. For 1,000 notes, that's ~4-5 hours — one overnight run. For 5,000 notes, it spreads across several nights. Job checkpointing means it picks up where it left off.

```sql
CREATE TABLE search_ai (
  uuid TEXT PRIMARY KEY,
  summary TEXT,
  generated_topics TEXT,   -- JSON array
  entities TEXT,           -- JSON array of {name, type}
  note_type TEXT,          -- 'meeting_notes', 'journal', 'recipe', etc.
  model_id TEXT,
  generated_at INTEGER,
  content_hash TEXT
);

CREATE TABLE search_connections (
  uuid_a TEXT NOT NULL,
  uuid_b TEXT NOT NULL,
  connection_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  explanation TEXT,
  PRIMARY KEY (uuid_a, uuid_b)
);
```

**Artifact pushed to client**: Included in the FTS5 SQLite artifact alongside the metadata tables. The client can show "Related notes" and LLM-generated summaries without any runtime LLM — the server pre-computed it all.

### 2.3 Hybrid Search (Client-Side)

When the client has both MiniSearch and downloaded supersearch artifacts, it fuses results using Reciprocal Rank Fusion:

```
score(doc) = Σ 1/(k + rank_i(doc))     where k = 60
```

Run in parallel:
1. MiniSearch lexical search (always available, includes real-time edits)
2. FTS5 query against downloaded SQLite artifact (stemming, BM25, phrase search)
3. Semantic search (vector similarity against downloaded embeddings)
4. Metadata filter (date/task filters against downloaded metadata)

Fuse the ranked lists. MiniSearch covers notes edited since the last artifact download; FTS5 covers everything with better quality. Together they handle the "freshness gap" naturally.

### 2.4 Server API

```
GET /search/capabilities
→ { levels: [0, 1, 2], benchmark_score: 142, model: "Qwen3-Embedding-0.6B",
    index_version: 3, last_indexed_at: 1706140800000, note_count: 1234 }

GET /search/status
→ { current_job: { level: 2, progress: 0.73, notes_remaining: 312 },
    last_run: { finished_at: ..., duration_ms: ..., notes_indexed: ... },
    queue_depth: 0 }

GET /search/index?since=<timestamp>&level=<0|1|2|3>
→ SQLite database file download for the requested level.
  Level 0+1 are in one file (FTS5 + metadata).
  Level 2 is a separate file (chunks + vectors).
  Level 3 data is included in the Level 0+1 file.
  Response headers include index version + content hash for cache validation.
```

**SSE extension**: Emit `supersearch_ready` event when a new index build completes, so clients know to download the updated artifact.

### 2.5 Indexer Pipeline

```
sync event → dirty queue → ┬─→ Level 0 (FTS5)        immediate
                           ├─→ Level 1 (metadata)     minutes
                           ├─→ Level 2 (embeddings)   overnight
                           └─→ Level 3 (LLM)          overnight
```

**Dirty tracking**: Each level stores `(uuid, content_hash)` for every note it has indexed. When a sync changes a note's hash, it becomes dirty for all levels.

```sql
CREATE TABLE search_index_state (
  uuid TEXT NOT NULL,
  level INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, level)
);
```

**Job management**: Jobs are tracked with checkpointing so interrupted runs resume where they left off.

```sql
CREATE TABLE search_jobs (
  job_id TEXT PRIMARY KEY,
  level INTEGER NOT NULL,
  status TEXT NOT NULL,          -- 'running', 'completed', 'interrupted', 'failed'
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  checkpoint TEXT,               -- JSON: last processed uuid, batch state
  notes_total INTEGER,
  notes_processed INTEGER
);
```

**Scheduling**: Level 0 runs immediately after sync. Level 1 runs after Level 0. Levels 2-3 run during configured idle hours (default 2am-6am local time), or manually via API. All jobs respect a configurable memory cap and can be paused/resumed.

### 2.6 Server Configuration

```env
SEARCH_ENABLED=true

# Levels to run (auto-detected if not set, based on benchmark)
# SEARCH_LEVELS=0,1,2

# Override embedding model (auto-selected if not set)
# EMBEDDING_MODEL=Qwen3-Embedding-0.6B

# Level 3: LLM model (auto-selected if not set)
# LLM_MODEL=llama-3.2-3b

# Scheduling
INDEX_IDLE_START=02:00
INDEX_IDLE_END=06:00

# Resource limits
INDEX_MAX_MEMORY_MB=512
INDEX_BATCH_SIZE=50
```

**Auto-detection**: On first run, benchmark → select model → enable levels. User can override everything. The goal is zero-config for most users.

### 2.7 What "Black Magic" Feels Like

With all levels built and artifacts downloaded to the client, these queries work locally and instantly:

| Query | What happens |
|-------|-------------|
| `grocery list` | Lexical match — title hit, ranked first |
| `that pasta recipe` | Semantic search finds "Cacio e Pepe" even though "pasta" never appears in the note |
| `raspberry pi` | Lexical match + semantic expansion finds notes about "ARM SBC", "home server", "k3s cluster" |
| `notes from last week` | Metadata date filter on modified_at |
| `meetings with Sarah` | Entity metadata (Level 1/3) + keyword match |
| `unfinished tasks` | Metadata filter: task_count > task_done_count |
| `what was I working on in January` | Date range filter + recency ranking |
| *(viewing a note)* → "Related notes" | Vector similarity against current note's embedding |

All local. All instant. The server did the hard work overnight.

---

## Part 3: Implementation Roadmap

### Phase 1: CoreSearch Upgrade (1-2 weeks)

1. Fix relevance ordering bug (trivial but high-impact)
2. Contextual snippets with term highlighting
3. Structured field indexing (title/headings/body weights)
4. Recency boost
5. Keyboard navigation in search popup
6. Persistent index with incremental startup updates

Ship as default for all platforms. No server dependency.

### Phase 2: Server Foundations (1-2 weeks)

1. FTS5 table + Level 0 indexing triggered after sync
2. Metadata extraction (Level 1)
3. `/search/capabilities` + `/search/status` endpoints
4. SQLite artifact packaging + `GET /search/index` download endpoint
5. `supersearch_ready` SSE event
6. Client: download SQLite artifact, open read-only, query alongside MiniSearch
7. RRF fusion of MiniSearch + FTS5 results

### Phase 3: Semantic Search (2-4 weeks)

1. Hardware benchmark + model auto-selection
2. node-llama-cpp integration for embedding generation
3. Chunking pipeline (heading/paragraph boundaries, ~900 tokens, 15% overlap)
4. sqlite-vec for vector storage
5. Overnight scheduling with job checkpointing
6. Client: on-device query embedding + vector search against downloaded index
7. RRF fusion of MiniSearch + FTS5 + vector results
8. "Related notes" UI feature

### Phase 4: LLM Augmentation (stretch)

1. LLM generation via node-llama-cpp (same runtime as embeddings)
2. Summary generation, auto-categorization, entity extraction
3. Cross-note connection discovery
4. Client: display LLM summaries and connections from downloaded artifact

---

## Technical Decisions

**MiniSearch on-device, FTS5 from server**: MiniSearch is zero-dependency and handles real-time updates well. FTS5 is strictly superior for search quality (stemming, BM25, phrase search) but requires SQLite. By building FTS5 on the server and shipping a read-only `.db` file to clients, we get the best of both: instant local search via MiniSearch for fresh edits, plus high-quality FTS5 for the full corpus, with no client-side index management.

**node-llama-cpp for everything**: One dependency handles embeddings (Level 2), LLM generation (Level 3), and potential future reranking. GGUF models auto-download, work on CPU (ARM + x86) with optional GPU. No Python, no ONNX, no second Docker container. Proven in production by [qmd](https://github.com/tobi/qmd).

**SQLite FTS5 over Elasticsearch/Meilisearch**: Zero infrastructure. Already have SQLite on the server. FTS5 has stemming, BM25, phrase search, column weights. For a personal notes server, it's plenty.

**sqlite-vec over pgvector/Pinecone**: Same zero-infrastructure rationale. ~500KB SQLite extension. Exact + approximate nearest neighbor. Fast enough for personal note collections.

**Benchmark-based, not device categories**: A Raspberry Pi 5 with 8GB RAM is more capable than a 10-year-old NUC with 2GB. Device categories are misleading. Measure actual performance, select accordingly.

**Index push over query proxy**: Keeps search fully local. No latency, no privacy leakage, no degraded experience when offline. The server is a build system for better indexes, not a runtime dependency.

**Reciprocal Rank Fusion**: Parameter-free hybrid ranking. No need to calibrate BM25 scores against cosine similarity. Robust across model/index changes.

**Chunk-level embeddings**: A single embedding for a long note averages multiple topics into mush. Chunk by heading/paragraph for passage-level precision.

---

## Privacy and Trust

- No cloud dependency. All processing on user-owned hardware.
- Local search is primary and always complete.
- Query text never leaves the device (index push model, not query proxy).
- Supersearch can be toggled off without data loss.
- Model downloads and compute-heavy features are explicit opt-in.
- All search data stored alongside existing note data — no separate telemetry or analytics.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Weak hardware struggles with embeddings | Benchmark-based model selection; quantized models; skip Level 2 if too slow; user can force-enable |
| Index schema/model changes break artifacts | Version tag in artifact format; client validates version before loading; clean rebuild on mismatch |
| Client index artifact grows too large | Incremental downloads (`since` parameter); compress vectors; prune old chunks |
| Interrupted nightly jobs waste work | Job checkpointing; resume from last processed note |
| On-device query embedding too slow on phones | Fallback: pre-computed term→vector lookup table in artifact |
| Operational complexity for self-hosters | Zero-config defaults; single env var to enable; clear status page; auto-detection |

---

## Success Metrics

- Local search p95 latency under 50ms.
- Cold-start indexing time reduced >70% via persistent index.
- Nightly job success rate >95%.
- Top-3 result click-through improves over current baseline.
- "No results" rate decreases for semantically related queries.
- Artifact download size stays under 10MB for typical note collections (excl. vectors).
