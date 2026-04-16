# AGENTS.md - Stonefruit Core

Shared Rust crate imported by the Tauri app (`apps/tauri`). Contains performance-critical, platform-agnostic logic — hashing, sync payload computation, vector search, graph layout, and text merge.

**Do not reimplement logic that exists here.** Tauri's `core.rs` imports functions directly from this crate. If you need something this crate provides in TypeScript, check whether a TS equivalent already exists in `src/lib/` before adding one.

## Modules

- **`files.rs`**: Note file I/O — read/write/delete/list, atomic writes, path safety (`ensure_safe_note_id`), mtime handling. The Rust-side canonical layer for filesystem access to notes. (TypeScript equivalent: `src/lib/platform/` for most file ops, `packages/shared/src/filename.ts` for title sanitization.)
- **`hash.rs`**: SHA-256 content hashing for sync — `compute_hash()` and `compute_hash_from_content()`. Any hash change breaks sync protocol compatibility.
- **`sync.rs`**: Client-side sync payload preparation and delta application (`prepare_sync_payload_v2`, `apply_sync_delta_v2`). Computes inventory from disk, builds changed/new/deleted lists, applies server response. This is the hot path called from Tauri commands.
- **`merge.rs`**: Three-way text merge for conflict resolution when both client and server modified the same note.
- **`search.rs`**: On-device search utilities — UMAP dimensionality reduction and K-Means clustering for embedding layout. Used by the Tauri supersearch commands.
- **`graph.rs`**: Force-directed graph layout algorithm. Takes note similarity data, produces 2D positions for visualization. Includes community detection via K-Means.
- **`invariants.rs`**: Filesystem invariant checks — detects and repairs inconsistencies between notes on disk and sync state (orphaned files, missing hashes, stale entries).

## Testing

Each module has inline `#[cfg(test)]` tests. Integration tests in `crates/stonefruit-core/tests/`. Run:

```bash
just test-rust    # or: cargo test -p stonefruit-core
```

## Verification (Required)

| What changed | Run |
|---|---|
| File operations | `just test-rust` (Tauri tests also exercise file ops) |
| Sync logic | `just test-rust` + `just test-cross-platform` (end-to-end sync validation) |
| Hash computation | `just test-rust` — any hash change breaks sync protocol compatibility |
| Search / graph | `just test-rust` |
