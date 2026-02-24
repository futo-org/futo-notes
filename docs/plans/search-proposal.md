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

**Model selection**: Based on benchmark score, not device category. On first index trigger, the server downloads bge-small-en-v1.5 (~37MB), embeds a 256-token passage 5 times, takes the median, and selects the best model from the registry:

```
Benchmark model: bge-small-en-v1.5 (Q8_0 GGUF, ~37MB download)
Metric: median of 5 timed runs (after 1 warmup)

< 10ms  → Qwen3-Embedding-8B  (4096d native → 1024d MRL, best quality, 100+ languages)
< 30ms  → Qwen3-Embedding-4B  (2560d native → 1024d MRL, great quality, 100+ languages)
< 100ms → Qwen3-Embedding-0.6B (1024d native, great quality, 100+ languages)
< 500ms → bge-small-en-v1.5    (384d, good quality)
≥ 500ms → skip Level 2
```

All Qwen3 models use Matryoshka Representation Learning (MRL) to truncate to 1024 dims for uniform artifact size. bge-small stays at native 384d (no MRL support). Qwen3 models use an instruction prefix on queries: `Instruct: Given a user search query, retrieve the most relevant personal notes\nQuery: ` — documents are embedded as-is. bge-small uses its own query prefix. The prefix is stored in `search_config` and included in the artifact's `search_model_card` table so clients know how to prepare queries.

The benchmark runs once (lazy — on first index trigger, not at startup) and caches the result in `search_config`. User can override model choice via `EMBEDDING_MODEL` env var (registry ID or direct GGUF file path).

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

-- sqlite-vec extension for vector storage (cosine distance)
CREATE VIRTUAL TABLE search_vectors USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[N] distance_metric=cosine
);
```

**Artifact pushed to client**: A separate SQLite file containing the chunks table + sqlite-vec virtual table. Clients use this for local semantic search — embed the query on-device (same small model, single inference) and find nearest neighbors.

If embedding the query on-device is too slow for some platforms, the artifact can also include a pre-computed "term → approximate vector" lookup table that enables lightweight semantic expansion without running a model at query time.

**Index size estimates** (float32, 1024d Qwen3 / 384d bge-small):

| Vault size | Chunks (~3/note) | 1024d vectors | 384d vectors | int8 quantized (1024d) |
|------------|-------------------|---------------|--------------|------------------------|
| 1,000 notes | 3,000 | 12 MB | 4.6 MB | ~3 MB |
| 5,000 notes | 15,000 | 60 MB | 23 MB | ~15 MB |
| 10,000 notes | 30,000 | 120 MB | 46 MB | ~30 MB |

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

# Override embedding model (auto-selected via benchmark if not set)
# Can be a registry ID (e.g. "qwen3-embedding-0.6b") or a direct GGUF file path
# EMBEDDING_MODEL=qwen3-embedding-0.6b

# Where to store downloaded GGUF model files (default: data/models)
# MODELS_PATH=data/models

# Level 3: LLM model (auto-selected if not set) — not yet implemented
# LLM_MODEL=llama-3.2-3b

# Scheduling
INDEX_IDLE_START=02:00
INDEX_IDLE_END=06:00

# Resource limits
INDEX_MAX_MEMORY_MB=512
INDEX_BATCH_SIZE=50
```

**Auto-detection**: On first index trigger, benchmark → select model → enable levels. User can override everything. The goal is zero-config for most users. Server starts instantly — model download and benchmark happen lazily when there are dirty notes to index.

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

### Phase 1: CoreSearch Upgrade — COMPLETE

Shipped and tested. MiniSearch on-device with:
- Structured field indexing (title 5x, headings 3x, body 1x)
- Fuzzy matching (0.2) + prefix search
- Recency boost (30-day decay window)
- Persistent index (`.search-index-v1.json`) with incremental rebuild on startup
- Contextual snippets (120-char window centered on match) with term highlighting
- Full keyboard navigation (arrow keys, enter, escape)
- Unit tests for snippets, highlights, heading extraction, persistence round-trip

### Phase 2: FTS5 Server Search — SKIPPED

MiniSearch handles lexical search well enough for a personal notes app. FTS5 adds stemming and BM25, but the real unlock is semantic search — finding notes by *meaning*, not keywords. Skipping FTS5 avoids building a second lexical search path and lets us focus on the qualitative leap that vectors provide.

FTS5 can be revisited later if stemming/phrase queries prove necessary. The server plumbing built for Phase 3 (artifact pipeline, dirty tracking, SSE events) would support adding FTS5 with minimal extra work.

### Phase 3: Semantic Search (server complete, client next)

MiniSearch + vectors. Two complementary signals: lexical (exact keywords, real-time edits) and semantic (meaning, "find notes about cooking" when none say "cooking"). Server-side pipeline (3.1–3.3) is shipped. Next: client-side artifact download, on-device vector search, and hybrid fusion (3.4–3.6).

#### 3.1 Server: Indexer Pipeline Skeleton — COMPLETE

Shipped and tested. Core infrastructure for server-side indexing:

- **Dirty tracking table**: `search_index_state (uuid, level, content_hash, indexed_at)` — knows which notes need reprocessing per level. `dirtyTracker.ts` marks notes dirty after sync, `getDirtyUuids()` finds notes needing re-index.
- **Job management table**: `search_jobs (job_id, level, status, checkpoint, notes_total, notes_processed, error_message)` — tracks running/interrupted/completed jobs with JSON checkpoint for resume.
- **Sync hook**: `markDirtyAfterSync()` called after `/sync` processes changes.
- **Indexer scheduler**: `scheduler.ts` checks every 60s. Runs during idle window (default 2am–6am) or after 3 hours of inactivity with dirty notes. On-demand via `POST /search/reindex`. Jobs checkpoint after each batch.
- **Config**: `SEARCH_ENABLED=true`, `INDEX_IDLE_START`, `INDEX_IDLE_END`, `INDEX_MAX_MEMORY_MB`, `INDEX_BATCH_SIZE`, `MODELS_PATH`.

#### 3.2 Server: Embedding Pipeline — COMPLETE

Shipped and tested. Dense vector embeddings via `node-llama-cpp` with GGUF models.

- **Model registry** (`modelRegistry.ts`): Static registry of 4 supported models with HF URIs, native/output dims, download sizes, and query/document prefixes. Models auto-download from HuggingFace via `resolveModelFile()`.
- **Hardware benchmark** (`benchmark.ts`): On first index trigger (lazy — not at startup), downloads bge-small-en-v1.5 (~37MB), embeds sample text 5 times, takes median. Selects model by threshold:
  - `< 10ms` → qwen3-embedding-8b (4096d → 1024d MRL)
  - `< 30ms` → qwen3-embedding-4b (2560d → 1024d MRL)
  - `< 100ms` → qwen3-embedding-0.6b (1024d native)
  - `< 500ms` → bge-small-en-v1.5 (384d native)
  - `≥ 500ms` → skip (hardware too slow)
- **Instruction prefixes**: Qwen3 models use `Instruct: Given a user search query, retrieve the most relevant personal notes\nQuery: ` for queries, documents embedded as-is. bge-small uses its own query prefix. Prefixes stored in `search_config` and artifact's `search_model_card` table.
- **MRL truncation**: All Qwen3 models output 1024d vectors (truncated from native dims via `.slice(0, dims)`). Uniform artifact size regardless of model.
- **Cosine distance**: sqlite-vec configured with `distance_metric=cosine` (significantly better retrieval than default L2 for normalized embeddings).
- **Lazy startup**: Server starts instantly. Model download, benchmark, and loading all happen inside the scheduler's first indexing trigger via `ensureProcessor()`.
- **Chunking**: Notes > ~512 tokens split at heading/paragraph boundaries into ~900-token chunks with 15% overlap. Notes with fewer than 10 words are filtered out to avoid polluting the vector space with near-empty content.
- **Storage**: `search_chunks` table + `search_vectors` via sqlite-vec (cosine distance). Chunk IDs use `bigint` throughout to avoid precision loss from `Number()` cast on SQLite rowids.
- **Incremental**: Only re-embed chunks whose content_hash changed. Store per-chunk hash for fine-grained dirty tracking.

#### 3.3 Server: Artifact Build & Serve — COMPLETE

Shipped and tested. Packages the vector index into downloadable artifacts.

- **Electron artifact**: SQLite `.db` file containing `search_chunks` + `search_vectors_raw` (raw blobs) + `search_model_card` tables. `search_model_card` contains `model_id`, `dims`, `query_prefix`, `doc_prefix`, `distance_metric` — clients read this to know how to prefix queries and interpret vectors.
- **Mobile artifact**: Binary `.bin` file containing raw vectors as a `Float32Array` dump, plus a JSON manifest mapping chunk IDs to note UUIDs, chunk text, and offsets.
- **Versioning**: Both artifacts include a version tag (`supersearch-v1`) so schema changes trigger clean rebuild on client.
- **Endpoint**: `GET /search/index?format=sqlite|bin|manifest` → streams the appropriate file. Response headers include artifact version + ETag for cache validation.
- **Capabilities endpoint**: `GET /search/capabilities` → `{ levels, model, dims, query_prefix, chunk_count, last_indexed_at, artifact_version, artifact_hash }`.
- **Status endpoint**: `GET /search/status` → `{ current_job, last_run }`.
- **SSE event**: TODO — emit `supersearch_ready` on the existing SSE infrastructure when a new artifact build completes.

#### 3.4 Client: Artifact Download & Storage

Extend the platform abstraction to download and store the vector artifact.

- **Download trigger**: On `supersearch_ready` SSE event (or on app launch if stale/missing). Not on every sync — server rebuilds 1–3x/day, so downloads are infrequent.
- **Electron**: Downloads `supersearch-v1.db` (SQLite format). Opens via `better-sqlite3` + sqlite-vec in the main process.
- **Capacitor**: Downloads `supersearch-v1.bin` (raw vectors) + `supersearch-v1-manifest.json` (chunk metadata). Stores in app data directory via Filesystem API.
- **Web**: Skip — no sync, no supersearch.
- **Version check**: Compare local artifact version/hash against server's `/search/capabilities`. Skip download if up to date.
- **First-use model download**: On first search (or app startup), download the query embedding model (~23 MB int8 ONNX). Cached in IndexedDB (Capacitor/Web) or filesystem (Electron). One-time cost.

#### 3.5 Client: On-Device Vector Search

Query the downloaded vector artifact locally. No network round-trip at search time.

- **Query embedding**: Embed the user's search query on-device using `transformers.js` with `all-MiniLM-L6-v2` (int8 quantized ONNX, ~23 MB). Runs via WASM SIMD in a Web Worker to avoid blocking UI. Single-threaded (Capacitor WebViews lack SharedArrayBuffer), but a single short query takes ~100–200ms on mobile, which is acceptable with debounced search. On Electron, optionally use `onnxruntime-node` or `node-llama-cpp` for faster native inference (~5–20ms). Model is cached after first download.
- **Nearest neighbor (Electron)**: Open `supersearch-v1.db` read-only via `better-sqlite3` + sqlite-vec. Query `vec0` table for top-K nearest chunks. ~20–25ms for 30K vectors.
- **Nearest neighbor (Capacitor)**: Brute-force cosine similarity over a `Float32Array`. Load raw vectors from `.bin` file, pre-normalize to unit length so cosine similarity = dot product. Int8 quantization reduces memory from ~46MB to ~11.5MB for 30K × 384 vectors. ~30–100ms on mobile, zero dependencies. Simple enough to implement in ~50 lines of code. Run in a Web Worker to keep UI responsive.
- **Result mapping**: Map chunk hits back to note UUIDs. Deduplicate (multiple chunks from same note). Use chunk_text for snippet display.

#### 3.6 Client: Hybrid Fusion (MiniSearch + Vectors)

Combine lexical and semantic results using Reciprocal Rank Fusion (RRF):

```
score(doc) = Σ 1/(k + rank_i(doc))     where k = 60
```

Run in parallel:
1. **MiniSearch** — lexical search (always available, covers real-time edits since last artifact download)
2. **Vector search** — semantic similarity (covers meaning-based matches from downloaded artifact)

Fuse the two ranked lists. MiniSearch handles the "freshness gap" (edits since last artifact build). Vectors handle the "vocabulary gap" (semantically related notes that don't share keywords).

#### 3.7 Priority Order

| Step | Effort | Dependency | Status |
|------|--------|------------|--------|
| 3.1 Indexer skeleton | Medium | None (server only) | COMPLETE |
| 3.2 Embedding pipeline | Large | 3.1 | COMPLETE |
| 3.3 Artifact serve | Small | 3.2 | COMPLETE |
| 3.4 Client download | Medium | 3.3 + platform work | Next |
| 3.5 On-device vector search | Medium | 3.4 | — |
| 3.6 Hybrid fusion (RRF) | Small | 3.5 | — |

### Phase 4: LLM Augmentation (stretch)

1. LLM generation via node-llama-cpp (same runtime as embeddings)
2. Summary generation, auto-categorization, entity extraction
3. Cross-note connection discovery
4. Client: display LLM summaries and connections from downloaded artifact

### Phase 5: FTS5 (if needed)

If stemming or phrase queries prove necessary after living with MiniSearch + vectors:
1. Add FTS5 virtual table to the server indexer (Level 0 — trivial with existing pipeline)
2. Include in artifact alongside vector tables
3. Add third signal to RRF fusion: MiniSearch + FTS5 + vectors

---

## Technical Decisions

**MiniSearch + vectors, skip FTS5 for now**: MiniSearch is zero-dependency, handles real-time updates well, and Phase 1 proved it's good enough for lexical search in a personal notes app. FTS5 adds stemming and BM25 but is a lateral improvement — same keyword-based paradigm. Vectors are a qualitative leap: finding notes by meaning, not vocabulary. Going straight to MiniSearch + vectors gives us two complementary signals (lexical + semantic) without building a redundant second lexical path. FTS5 can be added later to the same artifact pipeline if stemming proves necessary.

**node-llama-cpp for server embeddings**: One dependency handles embeddings (Phase 3), LLM generation (Phase 4), and potential future reranking. GGUF models auto-download, work on CPU (ARM + x86) with optional GPU. No Python, no ONNX, no second Docker container. Proven in production by [qmd](https://github.com/tobi/qmd).

**transformers.js for client query embedding**: Runs ONNX models via WASM SIMD in the browser/WebView. Works in Capacitor WebViews (Android + iOS) despite lacking SharedArrayBuffer and WebGPU — single-threaded WASM is fast enough for one short query (~100–200ms). The int8 quantized all-MiniLM-L6-v2 is ~23MB, cached in IndexedDB after first download. On Electron, `onnxruntime-node` provides faster native inference with the same ONNX model. This keeps query embedding fully client-side on all platforms — no server round-trip, no privacy leak.

**sqlite-vec for server + Electron, brute-force for mobile**: sqlite-vec is a SQLite extension — works perfectly on the server (better-sqlite3) and Electron (same stack), and the server's `.db` file can be opened directly on the Electron client with zero conversion. But Capacitor's SQLite plugins can't load native extensions without forking. For mobile, brute-force cosine similarity over a pre-normalized `Float32Array` is simple (~50 lines of code), has zero dependencies, and runs in ~30–100ms on mobile for 30K × 384 vectors. Int8 quantization cuts memory to ~11.5MB. This is fast enough with debounced search input, and avoids depending on immature WASM vector libraries. Can upgrade to a proper ANN library later if scale demands it.

**Benchmark-based, not device categories**: A Raspberry Pi 5 with 8GB RAM is more capable than a 10-year-old NUC with 2GB. Device categories are misleading. Measure actual performance, select accordingly. The benchmark uses a small proxy model (bge-small, 37MB) to avoid downloading a large model on slow hardware that won't use it.

**Cosine distance over L2**: sqlite-vec defaults to L2, but cosine distance produces significantly better retrieval for embedding models trained with cosine similarity objectives. All our models (bge-small, Qwen3) are trained this way.

**Instruction prefixes**: Qwen3 embedding models produce dramatically better retrieval when queries use an `Instruct:` prefix describing the task. Documents are embedded as-is. The prefix is stored in `search_config` and the artifact's `search_model_card` table so clients can apply it without hardcoding model-specific behavior.

**MRL truncation to 1024d**: Qwen3 models support Matryoshka Representation Learning — the first N dimensions of the embedding capture the most information. Truncating 4B (2560d) and 8B (4096d) to 1024d keeps artifacts a uniform size while retaining most retrieval quality. bge-small stays at native 384d since it doesn't support MRL.

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
| Client index artifact grows too large | Binary quantization (46MB → 1.4MB for 30K vectors); int8 vectors; prune old chunks |
| Interrupted nightly jobs waste work | Job checkpointing; resume from last processed note |
| On-device query embedding too slow on phones | transformers.js WASM SIMD measured ~100–200ms single-threaded; run in Web Worker so UI stays responsive; debounce search input |
| Brute-force vector search too slow at scale | 30K vectors is fine (~30–100ms); if note count grows to 100K+, upgrade to a WASM ANN library |
| 23MB model download on first use | Cache in IndexedDB; download in background on first app launch with sync enabled; show progress indicator |
| Capacitor WebView lacks SharedArrayBuffer | transformers.js falls back to single-threaded WASM; acceptable for single query embedding |
| Operational complexity for self-hosters | Zero-config defaults; single env var to enable; clear status page; auto-detection |

---

## Success Metrics

- Local search p95 latency under 50ms.
- Cold-start indexing time reduced >70% via persistent index.
- Nightly job success rate >95%.
- Top-3 result click-through improves over current baseline.
- "No results" rate decreases for semantically related queries.
- Artifact download size stays under 10MB for typical note collections (excl. vectors).
