# AGENTS.md - FUTO Notes Core

Shared Rust crate imported across the workspace — by the Tauri app and, via the `futo-notes-ffi` UniFFI facade, the native iOS/Android shells. Contains portable, stateless capabilities used by the note store and sync orchestrator.

**Do not reimplement logic that exists here.** The desktop Tauri adapter imports functions directly from this crate. If you need something this crate provides in TypeScript, check whether a TS equivalent already exists in `src/lib/` before adding one.

## Modules

- **`files/`**: Filename/title rules, path safety, timestamps, atomic writes, parked-backup recovery, blob transport, and case/normalization-safe renames. `mod.rs` is the public facade; focused child modules own each capability.
- **`hash.rs`**: SHA-256 content hashing for sync — `hash_sha256()` and `hash_sha256_bytes()`. Any hash change breaks sync protocol compatibility.
- **`merge.rs`**: Three-way text merge for conflict resolution when both client and server modified the same note.
- **`e2ee/`**: AES-GCM, PBKDF2 password keys, versioned note frames, and vault-key wrapping. `mod.rs` preserves the public crypto contract while child modules own the wire capabilities.
- **`conflict_names.rs`**: Deterministic and dated conflict-copy filenames.
- **`image.rs`**: Rust image-extension classification, conformance-locked to the editor package.

Durable vault/search/watcher state belongs to `futo-notes-store`. Connection, checkpoint, protocol, and live-task state belongs to `futo-notes-sync`; do not add those lifecycles here.

## Testing

Each module has inline `#[cfg(test)]` tests. Integration tests in `crates/futo-notes-core/tests/`. Run:

```bash
cargo test -p futo-notes-core
just test-rust-full
```

## Verification (Required)

| What changed | Run |
|---|---|
| File operations | `cargo test -p futo-notes-core` + `cargo test -p futo-notes-store` |
| E2EE, merge, or conflict behavior | `cargo test -p futo-notes-core` + `cargo test -p futo-notes-sync` + `just test-cross-platform` |
| Hash computation | `cargo test -p futo-notes-core` + `just test-cross-platform` — any hash change breaks sync protocol compatibility |
