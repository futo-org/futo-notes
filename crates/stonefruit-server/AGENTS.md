# AGENTS.md - Stonefruit Server

Self-hosted Axum sync server. Hash-based sync via `POST /sync`, polling sync check, optional server-side semantic search (BM25 + vector) and graph layout. Deployed via Docker Compose (managed by the CLI).

**Stack**: Axum + rusqlite + sqlite-vec + Ollama (optional). Imports shared logic from `stonefruit-core`.

From the monorepo root, prefer `just server-test` for Rust tests and `just server-dev` for local development.

## Architecture

- **`sync_engine.rs`**: Core sync logic — inventory diffing, conflict detection, version tracking. Handles the full sync protocol: compare client inventory against server state, compute deltas, apply changes, advance version.
- **`db.rs`**: All SQLite operations — schema creation, migrations, note CRUD, session management, search config, vector storage. Uses `rusqlite` directly (no ORM).
- **`indexer.rs`**: Background search indexer — chunks notes, generates embeddings via Ollama, stores vectors in sqlite-vec. Runs as a tokio task, reports progress via `IndexerStatus`.
- **`embedder.rs`**: Ollama HTTP client for generating text embeddings. Manages model loading and health checks.
- **`middleware.rs`**: Auth middleware — validates Bearer tokens from session table. Applied to all authed routes.
- **`app.rs`**: Router construction — public routes (health, setup, login) + authed routes (sync, search, graph, blob, dashboard).
- **`startup.rs`**: Server initialization — reads env vars, opens DB, starts indexer task, binds HTTP listener.
- **`password.rs`**: Argon2 password hashing and verification.
- **`error.rs`**: `AppError` type for consistent JSON error responses.

### Routes

| Route | Method | Auth | Handler |
|---|---|---|---|
| `/health` | GET | No | Health check + setup status |
| `/setup` | POST | No | First-time password setup |
| `/login` | POST | No | Session token exchange |
| `/` | GET | No | Server dashboard HTML |
| `/sync` | POST | Yes | Full sync (inventory + deltas) |
| `/sync/check` | POST | Yes | Lightweight poll — changes available? |
| `/blob/{filename}` | PUT/GET | Yes | Binary blob upload/download |
| `/search` | POST | Yes | Hybrid keyword + vector search |
| `/search/status` | GET | Yes | Index status + capabilities |
| `/graph/layout` | POST | Yes | Force-directed graph layout |
| `/dashboard/status` | GET | Yes | Server metrics for dashboard |
| `/admin/reset-password` | POST | No (admin token) | Password reset via `.admin-token` file |

## Testing

Tests are in `tests/` as Rust integration tests that boot an in-process Axum server:

- **`routes.rs`**: Route-level tests — health, setup, login, sync, dashboard, blob, search.
- **`sync.rs`**: Multi-step sync scenarios — roundtrip, conflicts, deletes, renames, blobs.
- **`e2e_two_client.rs`**: Two-client sync scenarios — concurrent edits, conflict resolution, rename races.
- **`auth.rs`**: Auth edge cases — invalid tokens, expired sessions, rate limiting.
- **`proptest_sync.rs`**: Property-based sync convergence tests via proptest.
- **`sync_10k.rs`**: Performance tests — 10K note sync roundtrip.
- **`golden_vaults.rs`**: Snapshot tests against known vault states.

```bash
just server-test    # cargo test -p stonefruit-server
just server-dev     # Run locally with dev password and Ollama
```

## Verification (Required)

| What changed | Run |
|---|---|
| Any server code | `just server-test` |
| Sync logic | Above + check `e2e_two_client.rs` covers the scenario |
| Search / indexer | Above + `just server-dev` and hit `/search/status` |
| Docker / deployment | Above + `just server-up` → `just server-health` → `just server-down` |
| Auth / middleware | Above + check `auth.rs` covers the scenario |
