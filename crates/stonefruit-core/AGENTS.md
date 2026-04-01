# AGENTS.md - Stonefruit Core

Shared Rust crate imported by both the Tauri app (`apps/tauri`) and the server (`crates/stonefruit-server`). Contains all platform-agnostic logic — file operations, hashing, sync, search, graph layout, merge.

**Do not reimplement logic that exists here.** Tauri's `core.rs` and the server import functions directly from this crate.

## Modules

- **`files.rs`**: Note file I/O — read/write/delete/list notes, atomic writes, path safety (`ensure_safe_note_id`), mtime handling, `note_id_from_filename()`. The canonical layer for all filesystem access to notes.
- **`hash.rs`**: SHA-256 content hashing for sync — `compute_hash()` and `compute_hash_from_content()`. Used by both client (sync payload prep) and server (content verification).
- **`sync.rs`**: Client-side sync payload preparation and delta application (`prepare_sync_payload_v2`, `apply_sync_delta_v2`). Computes inventory from disk, builds changed/new/deleted lists, applies server response.
- **`merge.rs`**: Three-way text merge for conflict resolution. Used when both client and server modified the same note.
- **`search.rs`**: Server-side search utilities — UMAP dimensionality reduction and K-Means clustering for graph layout. Not used client-side.
- **`graph.rs`**: Force-directed graph layout algorithm. Takes note similarity data, produces 2D positions for visualization. Includes community detection via K-Means.
- **`invariants.rs`**: Filesystem invariant checks — detects and repairs inconsistencies between notes on disk and sync state (orphaned files, missing hashes, stale entries).

## Testing

Each module has inline `#[cfg(test)]` tests. Run:

```bash
cargo test -p stonefruit-core
```

## Verification (Required)

| What changed | Run |
|---|---|
| File operations | `cargo test -p stonefruit-core` + `just test-rust` (Tauri tests exercise file ops) |
| Sync logic | Above + `just server-test` (server integration tests use sync functions) |
| Hash computation | Above — any hash change breaks sync protocol compatibility |
| Graph / search | `cargo test -p stonefruit-core` + `just server-test` |
