# Query Embedding: How the Client Gets a Vector at Search Time

See `search-proposal.md` Phase 3 for context. The server embeds all documents overnight with a large model (up to Qwen3-Embedding-8B). At search time, the client needs a vector for the user's query that lives in the **same embedding space** as the document vectors. This doc covers the options.

---

## The Problem

Embedding models produce vectors in their own learned space. A vector from Qwen3-8B and a vector from all-MiniLM-L6-v2 are not comparable — cosine similarity between them is meaningless. So whatever model embeds the documents must also embed the queries, or the models must be explicitly trained to share a space.

The server embeds documents with the best model the hardware can run (potentially 8B parameters). The client needs to produce a compatible query vector. Options:

---

## Option 1: Server-Side Query Embedding (Hybrid Round-Trip)

Client sends the query string to the server. Server embeds it with the same large model used for documents. Server sends the vector back. Client does the nearest-neighbor search locally against its downloaded vector index.

```
Client                          Server
  │                               │
  │  POST /search/embed           │
  │  { query: "pasta recipe" }    │
  │  ─────────────────────────►   │
  │                               │  embed with Qwen3-8B
  │   { vector: [0.12, ...] }    │
  │  ◄─────────────────────────   │
  │                               │
  │  local cosine search          │
  │  against downloaded vectors   │
  │                               │
```

**Pros:**
- Best quality — same model for queries and documents, no approximation
- Tiny payload (~4KB for 1024d float32 vector)
- Fast server-side (~5-20ms for a single short query on any hardware running the model)
- No model download on client
- Simple to implement — one new endpoint

**Cons:**
- Requires server connectivity for semantic search (lexical MiniSearch still works offline)
- Query text leaves the device (privacy consideration, though it's the user's own server)
- Adds a network round-trip to the search path (~50-200ms LAN, more on WAN)
- Breaks the "push only, never query" philosophy for this one feature

**Verdict:** Pragmatic starting point. Semantic search already requires a server (to build the index), so requiring it for query embedding is a small incremental dependency. Offline graceful degradation: MiniSearch lexical results only.

---

## Option 2: Client-Side Small Model (Current search-proposal.md Plan)

Client downloads a small embedding model and embeds the query on-device. The search-proposal.md currently specifies all-MiniLM-L6-v2 (~23MB int8 ONNX) via transformers.js.

**The catch:** This only works if the server also uses the same small model. If the server uses Qwen3-8B (4096d) and the client uses MiniLM (384d), the vectors are incompatible. So this approach forces the server down to the client's model quality, losing the whole point of server-side hardware.

**Pros:**
- Fully offline semantic search
- No query-time server dependency
- Privacy: query text never leaves the device

**Cons:**
- Server must use the same (small) model, wasting server hardware
- Lower retrieval quality across the board
- 23MB model download on client (one-time)
- ~100-200ms embedding latency on mobile (acceptable with debounce)

**Verdict:** Only viable if we're OK with a single small model everywhere. Defeats the purpose of the server running better hardware.

---

## Option 3: Asymmetric Embedding Models (Shared Space, Different Sizes)

Some model families are trained so that models of different sizes produce vectors in the same embedding space. A large model embeds documents with high quality; a tiny model embeds queries with lower compute; cosine similarity between them is valid.

### Voyage Embeddings (Voyager 4)

Voyage AI (now part of Anthropic) ships models where different sizes share a space — but these are **proprietary API-only** models. No local weights available. Not usable for our on-device, offline-first architecture.

If an open-source model family achieves this:
- Server embeds documents with the large model (best quality)
- Client embeds queries with the tiny model (fast, low memory)
- Vectors are directly comparable

**Pros:**
- Best of both worlds: server quality for documents, client speed for queries
- Fully offline
- No query-time server dependency

**Cons:**
- No open-source model family currently offers this
- Would need a model family with: (a) shared embedding space across sizes, (b) GGUF/ONNX availability, (c) good multilingual support
- Unproven for personal notes use case

**Verdict:** Ideal solution. Does not exist yet in open-source. Worth watching for — if someone builds an open Voyager 4 equivalent, this becomes the obvious choice.

---

## Option 4: LEAF Distillation (Train a Compatible Tiny Model)

LEAF (Lightweight Embeddings via Asymmetric Fine-tuning) is a framework for distilling a tiny student model that produces vectors **compatible with a large teacher model**. The student learns to approximate the teacher's embedding space, not its own.

Published results show a ~23M parameter student achieving **97.7% of teacher quality** in asymmetric mode (student embeds queries, teacher embeds documents).

### How It Works

```
Training phase (one-time, offline):
  Teacher: Qwen3-Embedding-8B (frozen)
  Student: ~23M params (trained)
  Loss: minimize distance between student(query) and teacher(query)
         for a large corpus of query-document pairs

Deployment:
  Server: Qwen3-Embedding-8B embeds documents (unchanged)
  Client: 23M student embeds queries (~2-5ms on phone)
  Cosine similarity between student(query) and teacher(doc) is valid
```

### What It Would Take

- **Training data:** Need query-document pairs representative of personal notes search. Could bootstrap from the notes corpus itself (use note titles/headings as pseudo-queries, note content as documents). ~100K pairs should suffice.
- **Training compute:** ~100 GPU-hours on an A100 or equivalent. One-time cost. ~$150-300 on cloud GPU.
- **Student architecture:** Small transformer (~23M params). Output trained to match teacher's embedding space.
- **Output:** A tiny ONNX model (~5-10MB int8) that runs on any device via transformers.js or WASM.

### Pros

- Tiny client model (~5-10MB vs 23MB for MiniLM)
- Near-teacher quality (97.7% published)
- Fully offline
- Extremely fast query embedding (~2-5ms on phone)
- Server gets to use its best model for documents
- One-time training cost, then the student is frozen

### Cons

- Requires ML training work — no off-the-shelf model available
- Need to build a training pipeline and curate training data
- Student quality depends on training data distribution matching real queries
- If we change the server embedding model, we need to retrain the student
- Published 97.7% was on standard benchmarks — may differ on personal notes

**Verdict:** The most promising long-term path. Near-teacher quality with a model small enough for any device. The training cost is modest but it's real engineering work, not just plugging in a library.

---

## Recommendation: Start with Option 1, Aim for Option 4

### Phase A: Ship with server-side query embedding (Option 1)

- Add `POST /search/embed` endpoint to the server
- Client sends query text, gets vector back, does local search
- MiniSearch still works offline for lexical results
- Semantic search requires server connectivity (acceptable tradeoff)
- Gets us to a working hybrid search fast

### Phase B: Investigate LEAF distillation (Option 4)

- Once search is shipping and we have real query patterns from usage, build training data
- Train a student model against whatever teacher the server is using
- Ship the student model as a ~5-10MB download on client
- Client now embeds queries locally — fully offline semantic search
- Server round-trip becomes unnecessary; `POST /search/embed` can be deprecated or kept as fallback

### Watch for: Open asymmetric model families (Option 3)

- If an open-source model family ships shared-space embeddings at multiple sizes, evaluate it as a drop-in replacement for both server and client models
- This would give us Option 4's benefits without the training work

---

## References

- LEAF: [Lightweight Embeddings via Asymmetric Fine-tuning](https://arxiv.org/abs/2410.01878)
- Voyage embeddings: proprietary shared-space model family (Anthropic/Voyage AI)
- Matryoshka Representation Learning: truncating dimensions for size flexibility (different problem — same model, fewer dims, not different model sizes)
