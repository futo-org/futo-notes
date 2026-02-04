# FUTO Notes Server - Implementation Plan

## Vision

A self-hosted Linux server for FUTO Notes that provides:
- **E2EE Sync** - Zero-knowledge encrypted note synchronization
- **Semantic Search** - QMD-style hybrid search (BM25 + vector + reranking)
- **RAG Capabilities** - Ask questions about your notes, get intelligent answers
- **CPU-Only Inference** - Runs on mini PC without GPU, processes overnight

Architecture inspired by Immich (Docker-based, job queues, background workers).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     FUTO Notes Server Stack                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │
│  │  API Server │    │   Worker    │    │   ML Worker (Optional)  │ │
│  │  (FastAPI)  │    │  (BullMQ)   │    │   (Embeddings + RAG)    │ │
│  └──────┬──────┘    └──────┬──────┘    └───────────┬─────────────┘ │
│         │                  │                       │               │
│         └──────────────────┼───────────────────────┘               │
│                            │                                        │
│  ┌─────────────────────────┼─────────────────────────────────────┐ │
│  │                    Shared Infrastructure                       │ │
│  │  ┌──────────┐  ┌────────┴───────┐  ┌─────────────────────────┐│ │
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
  # API Server - handles REST/WebSocket
  futo-api:
    build: ./api
    ports: ["3000:3000"]
    environment:
      - WORKERS_INCLUDE=api
    depends_on: [postgres, redis]

  # Background Worker - sync, indexing, cleanup
  futo-worker:
    build: ./api
    environment:
      - WORKERS_INCLUDE=sync,index,cleanup
      - WORKERS_EXCLUDE=api
    depends_on: [postgres, redis]

  # ML Worker - embeddings, RAG (runs during off-peak)
  futo-ml:
    build: ./ml
    environment:
      - WORKERS_INCLUDE=embed,rag
      - SCHEDULE=0 2 * * *  # 2 AM daily
    depends_on: [postgres, redis]
    deploy:
      resources:
        limits:
          memory: 8G  # For CPU inference

  # PostgreSQL with pgvector
  postgres:
    image: pgvector/pgvector:pg16
    volumes: ["./data/postgres:/var/lib/postgresql/data"]
    environment:
      - POSTGRES_DB=futo_notes
      - POSTGRES_USER=futo
      - POSTGRES_PASSWORD=${DB_PASSWORD}

  # Redis for job queues
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
  password_hash TEXT NOT NULL,  -- Argon2id (server auth only)
  encryption_salt TEXT NOT NULL, -- For client-side key derivation
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Encrypted Notes (server stores ciphertext only)
CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  encrypted_content BYTEA NOT NULL,  -- XChaCha20-Poly1305 ciphertext
  encrypted_title BYTEA NOT NULL,
  content_hash TEXT NOT NULL,  -- For change detection (hash of plaintext)
  version INTEGER DEFAULT 1,
  device_id TEXT,  -- Which device made this change
  server_timestamp TIMESTAMPTZ DEFAULT NOW(),
  client_timestamp BIGINT,  -- Client's local timestamp
  is_deleted BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, id)
);

-- Sync tracking
CREATE TABLE sync_tokens (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  token TEXT NOT NULL,  -- Cursor for delta sync
  last_sync TIMESTAMPTZ DEFAULT NOW()
);

-- Note versions for conflict resolution
CREATE TABLE note_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  encrypted_content BYTEA NOT NULL,
  version INTEGER NOT NULL,
  device_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client-encrypted search index (blind index)
CREATE TABLE search_index (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  term_hash TEXT NOT NULL,  -- HMAC(term, user_search_key)
  UNIQUE(user_id, note_id, term_hash)
);

-- Vector embeddings (encrypted at rest, decrypted for search)
-- This is the ONE exception to zero-knowledge: embeddings are server-readable
-- User must opt-in to semantic search (privacy tradeoff)
CREATE TABLE note_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  note_id UUID REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index INTEGER DEFAULT 0,
  embedding vector(768),  -- all-MiniLM-L6-v2 dimension
  chunk_text TEXT,  -- Plaintext chunk (requires user opt-in)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON note_embeddings USING hnsw (embedding vector_cosine_ops);
```

### 1.3 API Server (Python/FastAPI)

**Structure:**
```
server/api/
├── main.py              # FastAPI app, lifespan, routers
├── config.py            # Environment config
├── auth/
│   ├── routes.py        # /auth/register, /auth/login, /auth/refresh
│   ├── service.py       # Auth logic
│   └── models.py        # Pydantic schemas
├── notes/
│   ├── routes.py        # /notes CRUD + sync endpoints
│   ├── service.py       # Note operations
│   └── models.py        # Note schemas
├── sync/
│   ├── routes.py        # /sync endpoint (delta sync)
│   ├── service.py       # Sync logic, conflict detection
│   └── websocket.py     # Real-time sync notifications
├── search/
│   ├── routes.py        # /search (keyword + semantic)
│   ├── service.py       # Hybrid search implementation
│   └── rag.py           # RAG query endpoint
├── workers/
│   ├── base.py          # Worker base class
│   ├── sync_worker.py   # Process sync queue
│   ├── index_worker.py  # Update search indexes
│   └── embed_worker.py  # Generate embeddings
├── db/
│   ├── connection.py    # Async PostgreSQL
│   └── migrations/      # Alembic migrations
└── queue/
    └── bullmq.py        # Redis job queue wrapper
```

**Key Endpoints:**
```python
# Authentication
POST /auth/register      # Create account, return encryption salt
POST /auth/login         # Return JWT + sync token
POST /auth/refresh       # Refresh JWT

# Notes (all content is encrypted by client)
GET    /notes            # List note metadata
POST   /notes            # Create encrypted note
PUT    /notes/{id}       # Update encrypted note
DELETE /notes/{id}       # Soft delete

# Sync
POST /sync               # Delta sync (bi-directional)
  # Request: { sync_token, changes: [...] }
  # Response: { new_sync_token, remote_changes: [...], conflicts: [...] }

WS /sync/live            # Real-time sync notifications

# Search (requires semantic search opt-in)
POST /search             # Hybrid search (BM25 + vector)
POST /search/ask         # RAG query
GET  /search/status      # Index health
```

---

## Phase 2: End-to-End Encryption

### 2.1 Key Architecture (Standard Notes Pattern)

```
User Password
      │
      ▼
┌─────────────────────────────────────────┐
│  Argon2id(password, salt)               │
│  Memory: 64MB, Iterations: 5            │
│  Output: 512 bits                       │
└─────────────────────────────────────────┘
      │
      ├────────────────┬────────────────┐
      ▼                ▼                ▼
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Master   │    │ Server   │    │ Search   │
│ Key      │    │ Password │    │ Key      │
│ (256bit) │    │ (256bit) │    │ (256bit) │ (optional)
└──────────┘    └──────────┘    └──────────┘
      │                │                │
      │                │                │
      ▼                ▼                ▼
 Encrypt         Server Auth       Blind Index
 Note Content    (never sees       (HMAC of terms)
                 master key)
```

### 2.2 Client-Side Encryption (Add to FUTO Notes)

**New file: `src/lib/crypto.ts`**
```typescript
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { argon2id } from '@noble/hashes/argon2';
import { randomBytes } from '@noble/hashes/utils';

interface DerivedKeys {
  masterKey: Uint8Array;      // For encrypting notes
  serverPassword: Uint8Array; // For server auth
  searchKey: Uint8Array;      // For blind index (optional)
}

export async function deriveKeys(password: string, salt: Uint8Array): Promise<DerivedKeys> {
  const rootKey = argon2id(password, salt, {
    t: 5,           // iterations
    m: 65536,       // 64 MB memory
    p: 1,           // parallelism
    dkLen: 96       // 768 bits = 3 x 256-bit keys
  });

  return {
    masterKey: rootKey.slice(0, 32),
    serverPassword: rootKey.slice(32, 64),
    searchKey: rootKey.slice(64, 96)
  };
}

export function encryptNote(content: string, masterKey: Uint8Array): Uint8Array {
  const nonce = randomBytes(24); // 192-bit nonce for XChaCha20
  const cipher = xchacha20poly1305(masterKey, nonce);
  const encrypted = cipher.encrypt(new TextEncoder().encode(content));

  // Prepend nonce to ciphertext
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

export function decryptNote(encrypted: Uint8Array, masterKey: Uint8Array): string {
  const nonce = encrypted.slice(0, 24);
  const ciphertext = encrypted.slice(24);
  const cipher = xchacha20poly1305(masterKey, nonce);
  const decrypted = cipher.decrypt(ciphertext);
  return new TextDecoder().decode(decrypted);
}
```

### 2.3 Sync Protocol

**Delta Sync Flow:**
```
1. Client: POST /sync { sync_token, changes: [encrypted_notes] }

2. Server:
   - Validate JWT
   - For each change:
     - If note.version > server.version: accept
     - If note.version == server.version but timestamps differ: conflict
     - If note.version < server.version: reject (stale)
   - Get all server changes since sync_token
   - Return { new_sync_token, remote_changes, conflicts }

3. Client:
   - Apply remote_changes to local DB
   - For conflicts: show user both versions OR auto-merge (last-write-wins)
   - Update local sync_token
```

**Conflict Resolution Strategy:**
- **Default**: Last-write-wins (by client_timestamp)
- **Optional**: Keep-both (create "Note (conflict)" copy)
- **Future**: CRDT-based merge for real-time collaboration

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

**File: `server/api/search/rag.py`**
```python
async def ask_notes(query: str, user_id: str, llm_client) -> str:
    """Answer questions using notes as context."""

    # 1. Retrieve relevant chunks
    chunks = await hybrid_search(query, user_id, limit=10)

    # 2. Build context
    context = "\n\n---\n\n".join([
        f"From '{c.note_title}':\n{c.chunk_text}"
        for c in chunks
    ])

    # 3. Generate answer
    prompt = f"""Answer the question based on the user's notes below.
If the answer isn't in the notes, say "I couldn't find information about that in your notes."

Notes:
{context}

Question: {query}

Answer:"""

    response = await llm_client.generate(prompt)
    return response
```

### 3.4 LLM Options (CPU-Only, Mini PC)

**For Embeddings:**
- **sentence-transformers** with all-MiniLM-L6-v2
- Runs via Python, ~100ms per embedding on CPU
- Batch processing: 50-100 notes/second

**For RAG/Reranking:**

| Model | Size | RAM Needed | Speed | Quality |
|-------|------|------------|-------|---------|
| Phi-3-mini (4-bit) | 2.3 GB | 4 GB | 30 tok/s | Good |
| Qwen2-1.5B (4-bit) | 1.1 GB | 2 GB | 50 tok/s | Good |
| Mistral-7B (4-bit) | 4.1 GB | 6 GB | 15 tok/s | Best |
| Llama-3.2-3B (4-bit) | 2.0 GB | 4 GB | 25 tok/s | Good |

**Recommendation:** Start with **Qwen2-1.5B** for balance of speed/quality on mini PC.

**Runtime:** Use **llama-cpp-python** or **Ollama** for CPU inference.

---

## Phase 4: Background Processing

### 4.1 Job Queue Architecture (Immich Pattern)

**Queues:**
```python
QUEUES = {
    'sync': {
        'concurrency': 8,      # IO-bound
        'priority': 'high'
    },
    'index': {
        'concurrency': 4,      # CPU-bound
        'priority': 'medium'
    },
    'embed': {
        'concurrency': 1,      # Memory-intensive
        'priority': 'low',
        'schedule': '0 2 * * *'  # 2 AM daily
    },
    'rag': {
        'concurrency': 1,      # LLM inference
        'priority': 'low'
    },
    'cleanup': {
        'concurrency': 2,
        'schedule': '0 4 * * 0'  # 4 AM Sundays
    }
}
```

### 4.2 Overnight Processing Strategy

**The "Thinking Overnight" Pattern:**
```python
# Schedule embedding generation for off-peak hours
@scheduler.task('embed', cron='0 2 * * *')  # 2 AM daily
async def nightly_embedding_job():
    """Generate embeddings for all unprocessed notes."""

    # Get notes without embeddings
    notes = await db.fetch("""
        SELECT n.id, n.encrypted_content
        FROM notes n
        LEFT JOIN note_embeddings e ON n.id = e.note_id
        WHERE e.id IS NULL AND n.is_deleted = FALSE
    """)

    for note in notes:
        # User must have opted-in to semantic search
        if not await user_has_semantic_search_enabled(note.user_id):
            continue

        # Decrypt content (requires user's key - stored in session)
        content = await decrypt_with_session_key(note)

        # Chunk and embed
        chunks = chunk_note(content)
        for chunk in chunks:
            embedding = await embed_text(chunk['text'])
            await store_embedding(note.id, chunk, embedding)

        # Rate limit to avoid overloading mini PC
        await asyncio.sleep(0.5)
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
├── crypto.ts        # E2EE encryption/decryption
├── sync.ts          # Sync service
├── api.ts           # HTTP client
└── auth.ts          # Authentication state

src/screens/
└── Settings.ts      # Server URL, login, sync toggle
```

### 5.2 Sync Service

**File: `src/lib/sync.ts`**
```typescript
export class SyncService {
  private syncToken: string | null = null;
  private ws: WebSocket | null = null;

  async sync(): Promise<SyncResult> {
    // 1. Get local changes since last sync
    const localChanges = await getLocalChanges();

    // 2. Encrypt each change
    const encryptedChanges = await Promise.all(
      localChanges.map(note => ({
        id: note.id,
        encrypted_content: encryptNote(note.content, this.masterKey),
        encrypted_title: encryptNote(note.title, this.masterKey),
        version: note.version,
        client_timestamp: note.modificationTime
      }))
    );

    // 3. Send to server
    const response = await this.api.post('/sync', {
      sync_token: this.syncToken,
      changes: encryptedChanges
    });

    // 4. Apply remote changes
    for (const remote of response.remote_changes) {
      const content = decryptNote(remote.encrypted_content, this.masterKey);
      const title = decryptNote(remote.encrypted_title, this.masterKey);
      await saveNoteLocally({ ...remote, content, title });
    }

    // 5. Handle conflicts
    for (const conflict of response.conflicts) {
      await this.handleConflict(conflict);
    }

    // 6. Update sync token
    this.syncToken = response.new_sync_token;

    return { synced: true, conflicts: response.conflicts.length };
  }

  connectWebSocket() {
    this.ws = new WebSocket(`wss://${this.serverUrl}/sync/live`);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'note_changed') {
        this.sync(); // Trigger sync when remote changes detected
      }
    };
  }
}
```

### 5.3 Settings Screen

**New route: `/#/settings`**
- Server URL input
- Login/register forms
- Sync toggle (enable/disable)
- Semantic search opt-in (privacy notice)
- Last sync status
- Manual sync button

---

## Implementation Roadmap

### Milestone 1: Basic Server (2-3 weeks)
- [ ] Docker Compose setup with PostgreSQL + Redis
- [ ] FastAPI server with auth endpoints
- [ ] Basic CRUD for encrypted notes
- [ ] Database schema and migrations

### Milestone 2: E2EE Sync (2-3 weeks)
- [ ] Client-side encryption (crypto.ts)
- [ ] Delta sync protocol
- [ ] Conflict detection and resolution
- [ ] WebSocket real-time updates

### Milestone 3: Search (2-3 weeks)
- [ ] PostgreSQL FTS (BM25)
- [ ] pgvector embeddings
- [ ] Hybrid search endpoint
- [ ] Overnight embedding job

### Milestone 4: RAG (1-2 weeks)
- [ ] llama-cpp-python integration
- [ ] RAG query endpoint
- [ ] Query expansion (optional)
- [ ] Reranking (optional)

### Milestone 5: Polish (1-2 weeks)
- [ ] Settings UI in client
- [ ] Error handling and retries
- [ ] Health checks and monitoring
- [ ] Documentation

---

## Technology Stack Summary

| Component | Technology | Rationale |
|-----------|------------|-----------|
| API Server | FastAPI (Python) | Async, fast, great for ML |
| Database | PostgreSQL + pgvector | Reliable, vector search built-in |
| Job Queue | Redis + BullMQ pattern | Immich-proven, reliable |
| Encryption | XChaCha20-Poly1305 | Modern, fast, secure |
| Key Derivation | Argon2id | Memory-hard, GPU-resistant |
| Embeddings | all-MiniLM-L6-v2 | Small, fast, good quality |
| LLM | Qwen2-1.5B (4-bit) | Best CPU performance |
| LLM Runtime | llama-cpp-python | Optimized CPU inference |
| Container | Docker Compose | Immich-style deployment |

---

## Security Considerations

1. **Zero-Knowledge by Default**
   - Server never sees plaintext note content
   - All encryption/decryption happens client-side
   - Server password derived separately from master key

2. **Semantic Search Privacy Tradeoff**
   - Embeddings require server to see plaintext (opt-in only)
   - Clear user notice: "Enable AI search? Server will process your notes."
   - Alternative: Client-side embeddings (future enhancement)

3. **Transport Security**
   - HTTPS/WSS required
   - Certificate pinning recommended for mobile

4. **Authentication**
   - JWT with short expiry (15 min)
   - Refresh tokens with rotation
   - Rate limiting on auth endpoints

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
