# AGENTS.md - FUTO Notes Core

Shared Rust crate imported across the workspace — by the Tauri app and, via the `futo-notes-ffi` UniFFI facade, the native iOS/Android shells. Contains performance-critical, platform-agnostic logic — hashing, E2EE crypto, sync payload computation, filesystem invariants, and text merge.

**Do not reimplement logic that exists here.** The desktop Tauri adapter imports functions directly from this crate. If you need something this crate provides in TypeScript, check whether a TS equivalent already exists in `src/lib/` before adding one.

## Modules

- **`files.rs`**: Note file I/O — read/write/delete/list, atomic writes, path safety (`ensure_safe_note_id`), mtime handling. The Rust-side canonical layer for filesystem access to notes. (TypeScript equivalent: `src/lib/platform/` for most file ops, `packages/editor/src/filename.ts` for the sanctioned title hot path.)
- **`hash.rs`**: SHA-256 content hashing for sync — `hash_sha256()` and `hash_sha256_bytes()`. Any hash change breaks sync protocol compatibility.
- **`sync.rs`**: Client-side sync payload preparation and delta application (`prepare_sync_payload_v2`, `apply_sync_delta_v2`). Computes inventory from disk, builds changed/new/deleted lists, applies server response. This is the hot path called from Tauri commands.
- **`merge.rs`**: Three-way text merge for conflict resolution when both client and server modified the same note.
- **`e2ee.rs`**: End-to-end-encrypted sync primitives — salt/IV/vault-key generation, PBKDF2 password-key derivation, AES-GCM encrypt/decrypt. Runtime crypto is Rust-only; there is no TS twin.
- **`invariants.rs`**: Filesystem invariant checks — detects and repairs inconsistencies between notes on disk and sync state (orphaned files, missing hashes, stale entries).

## Testing

Each module has inline `#[cfg(test)]` tests. Integration tests in `crates/futo-notes-core/tests/`. Run:

```bash
just test-rust    # or: cargo test -p futo-notes-core
```

## Verification (Required)

| What changed | Run |
|---|---|
| File operations | `just test-rust` (Tauri tests also exercise file ops) |
| Sync logic | `just test-rust` + `just test-cross-platform` (end-to-end sync validation) |
| Hash computation | `just test-rust` — any hash change breaks sync protocol compatibility |
