# FUTO Notes Server - Implementation Plan

## Vision

A self-hosted Linux server for FUTO Notes - **"Immich for your notes"**.

**Target audience:** People who self-host Immich, use Obsidian, and want:
- Full control over their data
- Semantic search across all notes
- AI-powered RAG ("ask your notes")
- Background processing that actually works (server runs 24/7)

**Key insight:** Self-hosters already trust their server. That's why they run Immich instead of Google Photos. We don't need complex E2EE - we need a server that's **yours**, with full capabilities.

**Features:**
- **Sync** - Real-time sync across all devices
- **Semantic Search** - QMD-style hybrid search (BM25 + vector + reranking)
- **RAG** - Ask questions, get answers from your notes
- **Overnight Processing** - Server does heavy ML work while you sleep (reliable, unlike mobile background tasks)
- **CPU-Only** - Runs on a mini PC, no GPU required

Architecture inspired by Immich (Docker-based, job queues, background workers).

---

## Architecture Overview

**Hybrid Go + Python Design:**
- **Go** - API server, sync, auth, WebSockets (fast, low memory, single binary)
- **Python** - ML worker only (embeddings, RAG inference)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     FUTO Notes Server Stack                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────────┐    ┌────────────────────────────┐│
│  │         Go Services          │    │      Python ML Worker      ││
│  │  ┌────────┐  ┌────────────┐  │    │  ┌──────────────────────┐  ││
│  │  │  API   │  │   Worker   │  │    │  │  Embeddings + RAG    │  ││
│  │  │ Server │  │  (Asynq)   │  │    │  │  (sentence-transformers││
│  │  └────────┘  └────────────┘  │    │  │   + llama-cpp)       │  ││
│  └──────────────┬───────────────┘    └───────────┬────────────────┘│
│                 │                                │                  │
│                 └────────────┬───────────────────┘                  │
│                              │                                      │
│  ┌───────────────────────────┴───────────────────────────────────┐ │
│  │                    Shared Infrastructure                       │ │
│  │  ┌──────────┐  ┌────────────────┐  ┌─────────────────────────┐│ │
│  │  │ PostgreSQL│  │     Redis      │  │      Filesystem         ││ │
│  │  │ + pgvector│  │   (Job Queue)  │  │  (Encrypted Notes)      ││ │
│  │  └──────────┘  └────────────────┘  └─────────────────────────┘│ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                              HTTPS + WSS
                                    │
                    ┌───────────────┴───────────────┐
                    │      FUTO Notes Clients       │
                    │   (iOS / Android / Web)       │
                    └───────────────────────────────┘
```

**Why this split:**
| Concern | Go | Python | Winner |
|---------|-----|--------|--------|
| HTTP/WebSocket | Excellent (stdlib) | Good (FastAPI) | Go |
| Concurrency | Goroutines, cheap | asyncio, complex | Go |
| Memory usage | ~10-30 MB | ~100-300 MB | Go |
| Deployment | Single binary | venv + deps | Go |
| ML ecosystem | Limited | Excellent | Python |
| Embeddings | CGO bindings (fragile) | Native (robust) | Python |
| LLM inference | Via Ollama API | Native llama-cpp | Python |

---

## Phase 1: Core Server Infrastructure

### 1.1 Docker Compose Setup (Immich-Style)

**Files to create:**
- `server/docker-compose.yml` - Production deployment
- `server/docker-compose.dev.yml` - Development with hot reload
- `server/.env.example` - Environment template

**Services:**
```yaml
services:
  # Go API Server - handles REST/WebSocket/Auth/Sync
  futo-api:
    build:
      context: ./go
      dockerfile: Dockerfile
    ports: ["3000:3000"]
    environment:
      - DATABASE_URL=postgres://futo:${DB_PASSWORD}@postgres:5432/futo_notes
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET}
    depends_on: [postgres, redis]
    deploy:
      resources:
        limits:
          memory: 128M  # Go is lightweight

  # Go Background Worker - sync queue, indexing, cleanup
  futo-worker:
    build:
      context: ./go
      dockerfile: Dockerfile
    command: ["/app/futo-server", "worker"]
    environment:
      - DATABASE_URL=postgres://futo:${DB_PASSWORD}@postgres:5432/futo_notes
      - REDIS_URL=redis://redis:6379
      - WORKER_QUEUES=sync,index,cleanup
    depends_on: [postgres, redis]
    deploy:
      resources:
        limits:
          memory: 128M

  # Python ML Worker - embeddings, RAG (runs during off-peak)
  futo-ml:
    build:
      context: ./ml
      dockerfile: Dockerfile
    environment:
      - DATABASE_URL=postgres://futo:${DB_PASSWORD}@postgres:5432/futo_notes
      - REDIS_URL=redis://redis:6379
      - EMBEDDING_MODEL=all-MiniLM-L6-v2
      - LLM_MODEL=qwen2-1.5b-instruct-q4_k_m.gguf
    depends_on: [postgres, redis]
    deploy:
      resources:
        limits:
          memory: 8G  # For CPU inference
        reservations:
          memory: 4G

  # PostgreSQL with pgvector
  postgres:
    image: pgvector/pgvector:pg16
    volumes: ["./data/postgres:/var/lib/postgresql/data"]
    environment:
      - POSTGRES_DB=futo_notes
      - POSTGRES_USER=futo
      - POSTGRES_PASSWORD=${DB_PASSWORD}

  # Redis for job queues + pub/sub
  redis:
    image: redis:7-alpine
    volumes: ["./data/redis:/data"]
    command: redis-server --appendonly yes
```

### 1.2 Database Schema

**Tables:**
```sql
-- Users & Authentication
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,  -- Argon2id
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notes (plaintext - server can process for search/RAG)
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,           -- Markdown content
  content_hash TEXT NOT NULL,      -- SHA256 for change detection
  version INTEGER DEFAULT 1,
  device_id TEXT,                  -- Which device made this change
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_deleted BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, id)
);

-- Full-text search index
CREATE INDEX notes_fts_idx ON notes
  USING gin(to_tsvector('english', title || ' ' || content));

-- Sync tracking (cursor-based pagination)
CREATE TABLE sync_cursors (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  cursor TIMESTAMPTZ NOT NULL,     -- Last sync timestamp
  PRIMARY KEY (user_id, device_id)
);

-- Note versions for conflict resolution
CREATE TABLE note_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  device_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector embeddings for semantic search
CREATE TABLE note_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  chunk_seq INTEGER DEFAULT 0,     -- Chunk sequence within note
  chunk_start INTEGER,             -- Character offset for snippet extraction
  chunk_text TEXT NOT NULL,        -- The chunk content
  embedding vector(384),           -- all-MiniLM-L6-v2 dimension
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(note_id, chunk_seq)
);

-- HNSW index for fast similarity search
CREATE INDEX note_embeddings_vec_idx ON note_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- Track embedding job status
CREATE TABLE embedding_jobs (
  note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending',   -- pending, processing, completed, failed
  error TEXT,
  queued_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

### 1.3 Go API Server

**Go Libraries:**
- **Router**: `chi` or `echo` (lightweight, fast)
- **Database**: `pgx` (PostgreSQL driver with pgvector support)
- **Job Queue**: `asynq` (Redis-based, similar to Sidekiq)
- **WebSocket**: `gorilla/websocket` or `nhooyr.io/websocket`
- **Auth**: `golang-jwt/jwt` for JWT handling
- **Crypto**: `golang.org/x/crypto` (Argon2id built-in)
- **Config**: `envconfig` or `viper`

**Structure:**
```
server/go/
├── cmd/
│   └── futo-server/
│       └── main.go          # Entry point (api/worker modes)
├── internal/
│   ├── api/
│   │   ├── server.go        # HTTP server setup
│   │   ├── middleware.go    # Auth, logging, CORS
│   │   └── routes.go        # Route registration
│   ├── auth/
│   │   ├── handler.go       # /auth/* handlers
│   │   ├── service.go       # Auth logic, JWT
│   │   └── models.go        # Request/response types
│   ├── notes/
│   │   ├── handler.go       # /notes/* handlers
│   │   ├── service.go       # CRUD operations
│   │   ├── repository.go    # Database queries
│   │   └── models.go        # Note types
│   ├── sync/
│   │   ├── handler.go       # /sync endpoint
│   │   ├── service.go       # Delta sync logic
│   │   ├── websocket.go     # Real-time notifications
│   │   └── conflict.go      # Conflict resolution
│   ├── search/
│   │   ├── handler.go       # /search endpoints
│   │   ├── fts.go           # PostgreSQL FTS (BM25)
│   │   └── hybrid.go        # Combines FTS + vector results
│   ├── worker/
│   │   ├── worker.go        # Asynq worker setup
│   │   ├── sync_task.go     # Process sync queue
│   │   ├── index_task.go    # Update search indexes
│   │   └── embed_task.go    # Queue embeddings for ML worker
│   └── db/
│       ├── postgres.go      # Connection pool
│       ├── redis.go         # Redis client
│       └── migrations/      # golang-migrate files
├── pkg/
│   └── crypto/
│       └── xchacha.go       # XChaCha20-Poly1305 helpers (for testing)
├── go.mod
├── go.sum
└── Dockerfile
```

**Key Endpoints:**
```go
// Authentication
POST /auth/register      // Create account
POST /auth/login         // Return JWT + refresh token
POST /auth/refresh       // Refresh JWT
POST /auth/logout        // Invalidate refresh token

// Notes
GET    /notes            // List notes (paginated, with search)
GET    /notes/{id}       // Get single note
POST   /notes            // Create note
PUT    /notes/{id}       // Update note
DELETE /notes/{id}       // Soft delete (tombstone for sync)

// Sync (cursor-based)
POST /sync               // Delta sync (bi-directional)
  // Request: { cursor, changes: [{id, title, content, version, ...}] }
  // Response: { cursor, changes: [...], conflicts: [...] }

WS /sync/live            // Real-time sync notifications

// Search
GET  /search?q=...       // Hybrid search (BM25 + vector)
POST /search/ask         // RAG query ("What did I write about X?")
GET  /search/status      // Index health, embedding progress
```

**Example Handler (Go):**
```go
// internal/sync/handler.go
func (h *Handler) Sync(w http.ResponseWriter, r *http.Request) {
    userID := auth.UserIDFromContext(r.Context())

    var req SyncRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    result, err := h.service.ProcessSync(r.Context(), userID, req)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    json.NewEncoder(w).Encode(result)
}
```

### 1.4 Python ML Worker

**Structure:**
```
server/ml/
├── main.py              # Worker entry point
├── config.py            # Environment config
├── worker.py            # Redis queue consumer (rq or asynq-compatible)
├── embeddings/
│   ├── service.py       # Embedding generation
│   ├── chunker.py       # Token-based chunking
│   └── models.py        # Model loading (sentence-transformers)
├── rag/
│   ├── service.py       # RAG pipeline
│   ├── retriever.py     # Hybrid search integration
│   └── llm.py           # llama-cpp-python wrapper
├── api/
│   └── server.py        # Optional: internal gRPC/HTTP for Go to call
├── requirements.txt
└── Dockerfile
```

**Communication between Go and Python:**

Option A: **Redis Queue** (recommended for batch jobs)
```
Go Worker → Redis (asynq) → Python ML Worker
         "embed:note:123"
```

Option B: **Internal HTTP API** (for real-time search)
```go
// Go calls Python ML service for vector search
resp, err := http.Post("http://futo-ml:8000/embed", "application/json", body)
```

Option C: **gRPC** (if latency matters)
```protobuf
service MLService {
  rpc Embed(EmbedRequest) returns (EmbedResponse);
  rpc Search(SearchRequest) returns (SearchResponse);
  rpc Ask(AskRequest) returns (AskResponse);
}
```

---

## Phase 2: Authentication & Sync

### 2.1 Security Model: Trust Your Server

**Same model as Immich** - you own the server, you trust the server.

```
┌─────────────────────────────────────────────────────────────────┐
│  WHAT WE PROTECT:                                               │
│  ✅ Notes encrypted in transit (HTTPS/TLS)                      │
│  ✅ Notes encrypted at rest (PostgreSQL + LUKS disk encryption) │
│  ✅ Strong auth (Argon2id passwords, JWT + refresh tokens)      │
│  ✅ No third parties ever see your data                         │
│  ✅ Full audit trail (who accessed what, when)                  │
│                                                                 │
│  WHAT THIS ENABLES (that E2EE would break):                     │
│  ✅ Server-side semantic search (embeddings)                    │
│  ✅ Server-side RAG (LLM can read your notes)                   │
│  ✅ Overnight background processing (reliable, no OS limits)    │
│  ✅ Full-text search indexing                                   │
│  ✅ Future: sharing, collaboration                              │
│                                                                 │
│  WHO THIS IS FOR:                                               │
│  - Immich users (already trust their self-hosted server)        │
│  - Obsidian users (want markdown + local-first + sync)          │
│  - Anyone who wants AI features on their notes                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Authentication

```go
// internal/auth/service.go
type AuthService struct {
    db        *pgx.Pool
    jwtSecret []byte
}

// Password hashing with Argon2id (same as Immich)
func (s *AuthService) Register(ctx context.Context, email, password string) (*User, error) {
    hash, err := argon2id.CreateHash(password, argon2id.DefaultParams)
    if err != nil {
        return nil, err
    }

    user := &User{
        ID:           uuid.New(),
        Email:        email,
        PasswordHash: hash,
        CreatedAt:    time.Now(),
    }

    _, err = s.db.Exec(ctx, `
        INSERT INTO users (id, email, password_hash, created_at)
        VALUES ($1, $2, $3, $4)
    `, user.ID, user.Email, user.PasswordHash, user.CreatedAt)

    return user, err
}

// JWT (15 min) + Refresh Token (7 days, rotated on use)
func (s *AuthService) Login(ctx context.Context, email, password string) (*TokenPair, error) {
    user, err := s.getUserByEmail(ctx, email)
    if err != nil {
        return nil, ErrInvalidCredentials
    }

    match, err := argon2id.ComparePasswordAndHash(password, user.PasswordHash)
    if err != nil || !match {
        return nil, ErrInvalidCredentials
    }

    return s.issueTokenPair(user)
}
```

### 2.3 Sync Protocol

**Cursor-based Delta Sync:**
```
1. Client: POST /sync {
     cursor: "2024-01-15T10:30:00Z",  // Last sync time
     device_id: "iphone-abc123",
     changes: [
       { id: "uuid", title: "...", content: "...", version: 3, updated_at: "..." },
       { id: "uuid", is_deleted: true, version: 2 }  // Tombstone
     ]
   }

2. Server:
   - Validate JWT
   - For each client change:
     - If client.version > server.version: accept, queue embedding job
     - If client.version == server.version: conflict (concurrent edit)
     - If client.version < server.version: reject (stale)
   - Get all server changes since cursor
   - Return {
       cursor: "2024-01-15T10:35:00Z",
       changes: [...],
       conflicts: [{ note_id, client_version, server_version, server_content }]
     }

3. Client:
   - Apply remote changes to local storage
   - For conflicts: show diff UI or auto-merge (last-write-wins)
   - Update local cursor
```

**Conflict Resolution:**
- **Default**: Last-write-wins (by updated_at timestamp)
- **Optional**: Keep-both (create "Note (conflict copy)")
- **UI**: Show diff view for manual resolution

---

## Phase 3: Semantic Search & RAG

### 3.1 Search Architecture (QMD-Inspired)

```
User Query: "What did I write about React hooks?"
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│              Query Expansion (Optional)                  │
│  LLM generates 3 variants:                              │
│  - lex: "React hooks useState useEffect"                │
│  - vec: "React state management lifecycle methods"      │
│  - hyde: "I wrote about using React hooks for..."       │
└─────────────────────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│  BM25    │  │  Vector  │  │  Vector  │
│  Search  │  │  Search  │  │  Search  │
│  (FTS)   │  │  (lex)   │  │  (vec)   │
└──────────┘  └──────────┘  └──────────┘
        │           │           │
        └───────────┼───────────┘
                    ▼
┌─────────────────────────────────────────────────────────┐
│         Reciprocal Rank Fusion (RRF)                    │
│  rrfScore = Σ(weight / (k + rank + 1))                  │
│  k = 60 (tuned constant)                                │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│              LLM Reranking (Optional)                   │
│  Cross-encoder scores relevance 0-1                     │
│  Position-aware blending:                               │
│  - Top 3: 75% RRF + 25% rerank                         │
│  - 4-10:  60% RRF + 40% rerank                         │
│  - 11+:   40% RRF + 60% rerank                         │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
              Top 10 Results
```

### 3.2 Embedding Pipeline

**Chunking Strategy:**
```python
CHUNK_SIZE_TOKENS = 800
CHUNK_OVERLAP_TOKENS = 120  # 15% overlap

def chunk_note(content: str) -> list[dict]:
    """Split note into chunks for embedding."""
    # Use token-based chunking for accuracy
    tokens = tokenizer.encode(content)
    chunks = []
    pos = 0

    while pos < len(tokens):
        chunk_tokens = tokens[pos:pos + CHUNK_SIZE_TOKENS]
        chunk_text = tokenizer.decode(chunk_tokens)
        chunks.append({
            'text': chunk_text,
            'pos': pos,
            'seq': len(chunks)
        })
        pos += CHUNK_SIZE_TOKENS - CHUNK_OVERLAP_TOKENS

    return chunks
```

**Embedding Model Selection (CPU-Optimized):**

| Model | Size | Speed (CPU) | Quality | Recommendation |
|-------|------|-------------|---------|----------------|
| all-MiniLM-L6-v2 | 33 MB | 100ms/embed | Good | **Default** |
| nomic-embed-text | 137 MB | 200ms/embed | Better | If quality matters |
| UAE-Small-V1 | 28 MB | 80ms/embed | Good | Minimum footprint |

### 3.3 RAG Pipeline

**File: `server/ml/rag/service.py`**

Go handles the HTTP request, forwards to Python ML worker:

```go
// Go: internal/search/handler.go
func (h *Handler) Ask(w http.ResponseWriter, r *http.Request) {
    var req AskRequest
    json.NewDecoder(r.Body).Decode(&req)

    // Forward to Python ML service
    resp, err := h.mlClient.Post("http://futo-ml:8000/ask", req)
    if err != nil {
        http.Error(w, "ML service unavailable", http.StatusServiceUnavailable)
        return
    }

    io.Copy(w, resp.Body)  // Stream response
}
```

```python
# Python: ml/rag/service.py
from llama_cpp import Llama

llm = Llama(model_path="./models/qwen2-1.5b-instruct-q4_k_m.gguf", n_ctx=4096)

def ask_notes(query: str, user_id: str) -> str:
    """Answer questions using notes as context."""

    # 1. Retrieve relevant chunks (call internal search)
    chunks = hybrid_search(query, user_id, limit=10)

    # 2. Build context
    context = "\n\n---\n\n".join([
        f"From '{c['note_title']}':\n{c['chunk_text']}"
        for c in chunks
    ])

    # 3. Generate answer
    prompt = f"""Answer the question based on the user's notes below.
If the answer isn't in the notes, say "I couldn't find information about that in your notes."

Notes:
{context}

Question: {query}

Answer:"""

    response = llm(prompt, max_tokens=512, stop=["Question:", "\n\n\n"])
    return response["choices"][0]["text"].strip()
```

### 3.4 LLM Options (CPU-Only, Mini PC)

All ML runs in the Python worker container.

**For Embeddings (Python):**
- **sentence-transformers** with all-MiniLM-L6-v2
- ~100ms per embedding on CPU
- Batch processing: 50-100 notes/second

**For RAG/Reranking (Python):**

| Model | Size | RAM Needed | Speed | Quality |
|-------|------|------------|-------|---------|
| Phi-3-mini (4-bit) | 2.3 GB | 4 GB | 30 tok/s | Good |
| Qwen2-1.5B (4-bit) | 1.1 GB | 2 GB | 50 tok/s | Good |
| Mistral-7B (4-bit) | 4.1 GB | 6 GB | 15 tok/s | Best |
| Llama-3.2-3B (4-bit) | 2.0 GB | 4 GB | 25 tok/s | Good |

**Recommendation:** Start with **Qwen2-1.5B** for balance of speed/quality on mini PC.

**Runtime:** **llama-cpp-python** (Python bindings to llama.cpp)

**Alternative:** Call **Ollama** as external service (simpler setup, Go can call it directly too):
```yaml
services:
  ollama:
    image: ollama/ollama:latest
    volumes: ["./data/ollama:/root/.ollama"]
    deploy:
      resources:
        limits:
          memory: 8G
```
Then both Go and Python can call `http://ollama:11434/api/generate`.

---

## Phase 4: Background Processing

### 4.1 Job Queue Architecture (Go + Python)

**Go Worker (Asynq)** - Fast, lightweight tasks:
```go
// internal/worker/worker.go
func NewWorker(redisAddr string) *asynq.Server {
    return asynq.NewServer(
        asynq.RedisClientOpt{Addr: redisAddr},
        asynq.Config{
            Concurrency: 10,
            Queues: map[string]int{
                "critical": 6,  // sync operations
                "default":  3,  // indexing
                "low":      1,  // cleanup
            },
        },
    )
}

// Task types handled by Go worker
const (
    TypeSyncProcess   = "sync:process"
    TypeIndexUpdate   = "index:update"
    TypeCleanup       = "cleanup:orphans"
    TypeEmbedRequest  = "embed:request"  // Forwards to Python
)
```

**Python ML Worker** - Heavy compute tasks:
```python
# ml/worker.py
QUEUES = {
    'embed': {
        'concurrency': 1,      # Memory-intensive
        'priority': 'low',
    },
    'rag': {
        'concurrency': 1,      # LLM inference
        'priority': 'low'
    }
}

# Listens on same Redis, different queue prefix
```

### 4.2 Overnight Processing Strategy

**The "Thinking Overnight" Pattern:**

Go schedules the job, Python executes:

```go
// internal/worker/embed_task.go (Go - scheduler)
func (w *Worker) ScheduleNightlyEmbeddings() error {
    // Run at 2 AM daily
    scheduler := asynq.NewScheduler(w.redisOpt, nil)

    task := asynq.NewTask(TypeEmbedBatch, nil)
    _, err := scheduler.Register("0 2 * * *", task)
    return err
}

func (w *Worker) HandleEmbedBatch(ctx context.Context, t *asynq.Task) error {
    // Get notes needing embeddings
    notes, err := w.db.GetNotesWithoutEmbeddings(ctx)
    if err != nil {
        return err
    }

    // Queue each note for Python ML worker
    for _, note := range notes {
        if !note.User.SemanticSearchEnabled {
            continue
        }

        // Forward to Python worker via Redis queue
        task := asynq.NewTask("ml:embed",
            json.Marshal(EmbedRequest{
                NoteID:    note.ID,
                UserID:    note.UserID,
                Content:   note.DecryptedContent, // User's session key
            }),
        )
        w.client.Enqueue(task, asynq.Queue("ml"))
    }
    return nil
}
```

```python
# ml/worker.py (Python - executor)
from rq import Worker, Queue
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('all-MiniLM-L6-v2')

def process_embed_task(note_id: str, user_id: str, content: str):
    """Generate embeddings for a single note."""

    # Chunk content
    chunks = chunk_note(content)

    # Generate embeddings (batched for efficiency)
    texts = [c['text'] for c in chunks]
    embeddings = model.encode(texts, batch_size=32, show_progress_bar=False)

    # Store in PostgreSQL
    with get_db() as db:
        for chunk, embedding in zip(chunks, embeddings):
            db.execute("""
                INSERT INTO note_embeddings (note_id, user_id, chunk_index, embedding, chunk_text)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (note_id, chunk_index) DO UPDATE SET
                    embedding = EXCLUDED.embedding,
                    chunk_text = EXCLUDED.chunk_text
            """, (note_id, user_id, chunk['seq'], embedding.tolist(), chunk['text']))

    return {"note_id": note_id, "chunks": len(chunks)}
```

### 4.3 Resource Management

**Memory Constraints (16-32 GB Mini PC):**
```yaml
# docker-compose.yml resource limits
services:
  futo-ml:
    deploy:
      resources:
        limits:
          memory: 8G   # Max for ML worker
        reservations:
          memory: 4G   # Guaranteed
    environment:
      - EMBEDDING_BATCH_SIZE=32
      - LLM_CONTEXT_SIZE=4096
      - LLM_MAX_TOKENS=512
```

---

## Phase 5: Client Integration

### 5.1 New Client Files

```
src/lib/
├── sync.ts          # Sync service
├── api.ts           # HTTP client (fetch wrapper with auth)
└── auth.ts          # Authentication state (JWT storage)

src/screens/
├── Settings.ts      # Server URL, login, sync toggle
└── Login.ts         # Login/register screen
```

### 5.2 Sync Service

**File: `src/lib/sync.ts`**
```typescript
export class SyncService {
  private cursor: string | null = null;
  private deviceId: string;
  private ws: WebSocket | null = null;

  constructor(private api: ApiClient) {
    this.deviceId = this.getOrCreateDeviceId();
  }

  async sync(): Promise<SyncResult> {
    // 1. Get local changes since last sync
    const localChanges = await getLocalChangesSinceCursor(this.cursor);

    // 2. Send to server (plaintext over HTTPS)
    const response = await this.api.post('/sync', {
      cursor: this.cursor,
      device_id: this.deviceId,
      changes: localChanges.map(note => ({
        id: note.id,
        title: note.title,
        content: note.content,
        version: note.version,
        updated_at: note.updatedAt,
        is_deleted: note.isDeleted
      }))
    });

    // 3. Apply remote changes
    for (const remote of response.changes) {
      await saveNoteLocally(remote);
    }

    // 4. Handle conflicts (show UI or auto-resolve)
    for (const conflict of response.conflicts) {
      await this.handleConflict(conflict);
    }

    // 5. Update cursor
    this.cursor = response.cursor;
    await saveSyncCursor(this.cursor);

    return { synced: true, conflicts: response.conflicts.length };
  }

  connectWebSocket() {
    this.ws = new WebSocket(`wss://${this.api.baseUrl}/sync/live`);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'note_changed' && msg.device_id !== this.deviceId) {
        this.sync(); // Sync when another device makes changes
      }
    };
  }
}
```

### 5.3 Settings Screen

**New route: `/#/settings`**
- Server URL input (e.g., `https://notes.myserver.com`)
- Login/register forms
- Sync toggle (enable/disable)
- Last sync status + timestamp
- Manual sync button
- Account info (email, logout)

---

## Implementation Roadmap

### Milestone 1: Go API Server
- [ ] Project scaffold (`go mod init`, directory structure)
- [ ] Docker Compose setup (PostgreSQL + Redis + Go)
- [ ] Database migrations (golang-migrate)
- [ ] Auth endpoints (register, login, refresh, logout)
- [ ] Notes CRUD endpoints
- [ ] Asynq worker setup

### Milestone 2: Sync
- [ ] Cursor-based delta sync endpoint (Go)
- [ ] Conflict detection and resolution
- [ ] WebSocket real-time notifications
- [ ] Client sync service (src/lib/sync.ts)
- [ ] Settings UI for server connection

### Milestone 3: Python ML Worker
- [ ] Python worker scaffold
- [ ] sentence-transformers embedding pipeline
- [ ] Redis queue integration (rq)
- [ ] Go → Python job forwarding
- [ ] Overnight batch scheduling (asynq cron)

### Milestone 4: Hybrid Search
- [ ] PostgreSQL FTS setup (Go)
- [ ] pgvector integration (Go)
- [ ] Hybrid search endpoint (RRF fusion)
- [ ] Internal API between Go and Python for vector search

### Milestone 5: RAG
- [ ] llama-cpp-python integration
- [ ] RAG query endpoint
- [ ] Query expansion (optional)
- [ ] Reranking (optional)

### Milestone 6: Polish
- [ ] Settings UI in client
- [ ] Error handling and retries
- [ ] Health checks and monitoring
- [ ] Documentation

---

## Technology Stack Summary

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **API Server** | Go (chi/echo) | Fast, low memory, single binary |
| **Job Queue** | Go (asynq) | Redis-backed, similar to Sidekiq |
| **ML Worker** | Python | Best ML ecosystem |
| **Database** | PostgreSQL + pgvector | Reliable, vector search built-in |
| **Cache/Queue** | Redis | Shared between Go and Python |
| **Encryption** | XChaCha20-Poly1305 | Modern, fast, secure |
| **Key Derivation** | Argon2id | Memory-hard, GPU-resistant (Go stdlib) |
| **Embeddings** | all-MiniLM-L6-v2 | Small, fast, good quality |
| **LLM** | Qwen2-1.5B (4-bit) | Best CPU performance |
| **LLM Runtime** | llama-cpp-python | Optimized CPU inference |
| **Container** | Docker Compose | Immich-style deployment |

### Go Packages
```go
// go.mod dependencies
require (
    github.com/go-chi/chi/v5        // HTTP router
    github.com/jackc/pgx/v5         // PostgreSQL driver
    github.com/hibiken/asynq        // Job queue (Redis)
    github.com/golang-jwt/jwt/v5    // JWT auth
    github.com/gorilla/websocket    // WebSocket
    golang.org/x/crypto             // Argon2id
    github.com/pgvector/pgvector-go // Vector type
)
```

### Python Packages
```python
# requirements.txt
sentence-transformers==2.2.2    # Embeddings
llama-cpp-python==0.2.50        # LLM inference
pgvector==0.2.4                 # PostgreSQL vector
redis==5.0.0                    # Job queue
rq==1.15.1                      # Redis Queue worker
psycopg[binary]==3.1.0          # PostgreSQL
```

---

## Security Considerations

**Trust Model: Same as Immich**

You own the server, you trust the server. This enables full ML capabilities.

1. **Transport Security**
   - HTTPS/TLS required (Let's Encrypt or self-signed)
   - WebSocket over TLS (WSS)
   - Optional: Certificate pinning for mobile apps

2. **Data at Rest**
   - Recommend LUKS full-disk encryption on server
   - PostgreSQL TDE (Transparent Data Encryption) optional
   - Backups should be encrypted

3. **Authentication**
   - Argon2id password hashing (memory-hard, GPU-resistant)
   - JWT access tokens (15 min expiry)
   - Refresh tokens (7 days, rotated on use)
   - Rate limiting on auth endpoints

4. **Access Control**
   - Single-user or multi-user (family/team)
   - Notes are private per-user by default
   - Future: sharing with specific users

5. **Deployment Hardening**
   - Run behind reverse proxy (Caddy, Traefik, nginx)
   - Firewall: only expose 443
   - Regular security updates
   - Docker security best practices (non-root user, read-only fs)

---

## Resource Requirements

**Minimum (10K notes):**
- CPU: 4 cores
- RAM: 8 GB
- Storage: 20 GB SSD
- Network: 10 Mbps

**Recommended (100K notes):**
- CPU: 8 cores
- RAM: 16-32 GB
- Storage: 100 GB SSD
- Network: 100 Mbps

**Expected Performance:**
- Sync latency: <100ms
- Search latency: <200ms
- RAG response: 2-5 seconds
- Embedding throughput: 50-100 notes/second (overnight)
