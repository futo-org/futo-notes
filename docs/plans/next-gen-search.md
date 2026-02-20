# Next-Gen Search: Reranking + Query Expansion

Future enhancements that build on the base search proposal. These require running models at query time (not just overnight indexing), so they have different latency and hardware tradeoffs.

See `search-proposal.md` for the foundation this builds on.

---

## Reranking

### What It Is

After initial retrieval (FTS5 + vector search) returns ~30 candidate results, run them through a **cross-encoder reranker model** that scores each (query, document) pair together. Cross-encoders are dramatically better at judging relevance than bi-encoders (embeddings) because they see the query and document at the same time — they can reason about the relationship rather than comparing pre-computed vectors.

This is the single biggest "black magic" ingredient. It's what makes mediocre retrieval results look brilliant.

### How It Works

```
User query: "that pasta recipe"

Step 1: Retrieval (existing pipeline)
  FTS5 returns: [Cacio e Pepe, Italian Groceries, Pasta Machine Review, ...]
  Vectors return: [Cacio e Pepe, Sunday Dinner Notes, Lemon Vinaigrette, ...]
  RRF merge → top 30 candidates

Step 2: Reranking (NEW)
  For each of the 30 candidates, score:
    reranker("that pasta recipe", "# Cacio e Pepe\nClassic Roman pasta...") → 0.94
    reranker("that pasta recipe", "# Pasta Machine Review\nBought the...") → 0.71
    reranker("that pasta recipe", "# Lemon Vinaigrette\nGreat on...") → 0.12
  Re-sort by reranker scores

Step 3: Position-aware blending
  Don't let the reranker fully override high-confidence retrieval matches.
  If FTS5 ranked something #1 with a strong BM25 score, cap how far
  the reranker can demote it (e.g., no lower than rank 5).
  This protects against reranker hallucinations.
```

### Model

[Qwen3-reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) — only 600M parameters. It doesn't generate text, it just scores a pair. On a Raspberry Pi 5, scoring one (query, document) pair takes ~50-100ms. For 30 candidates: 1.5-3 seconds. That's at the edge of acceptable for interactive search but workable, especially if we show initial results immediately and re-sort when reranking finishes.

On a mini PC: ~10-30ms per pair → 300-900ms for 30 candidates. Feels snappy.

Runs via `node-llama-cpp` (same runtime as embeddings and LLM generation — no new dependency).

### Where It Runs

**Option A: Server-side (query endpoint)**

Add an optional `POST /search/query` endpoint that accepts a query string, runs retrieval + reranking on the server, and returns reranked results. The client still has local search as primary, but when online, it fires this in parallel and blends server-reranked results in when they arrive.

Pros: No model on the client device. Server has the full index locally, no round-trip per candidate.
Cons: Requires server connectivity. Adds a query-time server dependency (breaks the "push only" philosophy for this feature specifically).

**Option B: Client-side (downloaded model)**

Client downloads the reranker GGUF model (~400MB for 0.6B Q4) and runs reranking locally. Only practical on devices with enough RAM and CPU (desktops, capable phones, tablets).

Pros: Fully offline. Consistent with push philosophy.
Cons: 400MB model download. RAM usage. Slow on low-end devices.

**Option C: Hybrid**

Rerank on server when online (Option A), fall back to no reranking when offline. Client never runs the reranker model itself. This is probably the pragmatic choice — reranking is a nice-to-have enhancement, not a core requirement, so degrading gracefully when offline is fine.

### Implementation Notes

- Reranking only activates when the user pauses typing for ~300ms (debounce). Don't rerank on every keystroke.
- Show retrieval results immediately, then re-sort in place when reranking completes. Animate the position changes subtly.
- Cap reranking to top 30 retrieval results. Beyond that, retrieval quality is too low to be worth reranking.
- Position-aware blending formula (from qmd):
  ```
  final_score = α(rank) × retrieval_score + (1 - α(rank)) × reranker_score
  where α decreases with rank (high-confidence top results keep more retrieval weight)
  ```

---

## Query Expansion

### What It Is

Before searching, generate 2-3 alternative phrasings of the user's query using a small language model. Search all variants independently, then fuse the results. This dramatically improves recall — the system finds documents the user's exact wording wouldn't match.

### How It Works

```
User query: "that pasta recipe"

Step 1: Expansion
  Model generates:
    - "Italian pasta dish recipe"
    - "noodle recipe cooking"

  Now we have 3 query variants.

Step 2: Search each variant
  "that pasta recipe"          → FTS5 results + vector results
  "Italian pasta dish recipe"  → FTS5 results + vector results
  "noodle recipe cooking"      → FTS5 results + vector results

  = 6 result lists total

Step 3: Reciprocal Rank Fusion across all 6 lists
  Documents appearing in multiple lists get boosted.
  The original query's results are weighted slightly higher.
```

### On-Device Feasibility

**This is the concern.** Query expansion requires running a language model at query time to generate the alternative phrasings. On older/weaker devices, this adds unacceptable latency:

| Device | Model | Expansion time (~30 output tokens) |
|--------|-------|------------------------------------|
| Modern desktop | Llama 3.2 1B Q4 | ~200ms |
| Mini PC / Beelink | Llama 3.2 1B Q4 | ~1-2s |
| Raspberry Pi 5 | Llama 3.2 1B Q4 | ~5-10s |
| Older phone | — | Not practical |

5-10 seconds of latency before results appear is too slow for interactive search. Options:

**Option A: Server-side only.** The server runs query expansion as part of the `POST /search/query` endpoint (same endpoint as reranking). When online, the client sends the raw query, the server expands + retrieves + reranks, and sends back results. When offline, no expansion — just normal retrieval.

**Option B: Pre-computed expansion index.** During the overnight indexing job, the server pre-generates expansion terms for common vocabulary in the user's notes. For example, if the corpus contains "Cacio e Pepe", the LLM generates associations: `["pasta", "Italian", "Roman", "recipe", "cheese", "pepper"]`. These are stored as a lookup table in the downloaded artifact. At query time, the client does a fast table lookup instead of running a model. Less flexible than live expansion but zero latency.

**Option C: Tiered approach.**
- Powerful devices: run expansion locally (< 2s budget)
- Moderate devices: use pre-computed expansion table from server
- Weak devices / offline: no expansion, just retrieval

**Recommendation**: Start with Option A (server-side), add Option B (pre-computed table) as a stretch goal for offline use. Live on-device expansion is a long-term aspiration for when phone hardware catches up.

### Model for Expansion

qmd uses a custom fine-tuned 1.7B model for this. We could start simpler:
- Llama 3.2 1B with a system prompt: "Generate 2 short alternative search queries for: {query}. Output only the queries, one per line."
- Or Qwen3-0.6B for a lighter option
- The fine-tuned approach (like qmd) is better but requires training data

### Implementation Notes

- Expansion is most valuable for vague/conceptual queries ("that pasta recipe", "the homelab thing"). For precise queries ("error code E1234"), it's useless or harmful. Detect and skip expansion for queries that look like exact lookups (quoted phrases, error codes, UUIDs, URLs).
- Limit to 2-3 expansions. More than that adds noise without improving recall.
- Weight the original query's results higher in RRF (e.g., 1.5x the rank contribution).

---

## Combined Pipeline (Future State)

When both features are implemented, the full query-time pipeline looks like this:

```
User types query
       │
       ▼
┌──────────────┐
│ Local search │ ← Immediate (< 50ms)
│ (MiniSearch + │    Show results now
│  FTS5 + vec) │
└──────┬───────┘
       │
       │  In parallel (if online):
       │
       ▼
┌──────────────────────┐
│ Server: POST /search │
│                      │
│  1. Query expansion  │ ← LLM generates 2-3 variants
│  2. Multi-retrieval  │ ← FTS5 + vector × 3 queries = 6 lists
│  3. RRF fusion       │ ← Merge into top 30
│  4. Reranking        │ ← Cross-encoder scores top 30
│  5. Return results   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Client merges:       │
│  - Local results     │ ← Shown immediately
│  - Server results    │ ← Blended in when they arrive
│  - Never blocks UI   │
└──────────────────────┘
```

Latency budget for the server pipeline: ~500ms-2s depending on hardware. The client shows local results instantly and upgrades them when the server responds.

---

## Dependency on Base Proposal

These features require:
- Level 0 (FTS5) and Level 2 (embeddings) from the base proposal
- node-llama-cpp already installed for Level 2/3
- The `POST /search/query` endpoint is new (the base proposal only has `GET /search/index` for artifact downloads)

Adding the query endpoint doesn't violate the "push, not proxy" philosophy — local search still works fully offline. The query endpoint is an optional enhancement that makes search better when the server is reachable.
