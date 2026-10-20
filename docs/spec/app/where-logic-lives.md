## Where logic lives

- Note CRUD, rules, sync, search, and indexing logic live in Rust
  (`crates/futo-notes-*`), exposed **once** via the `futo-notes-ffi` UniFFI
  facade (iOS/Android) and `#[tauri::command]`s (desktop). Svelte / Compose /
  SwiftUI are thin shells that call in and render. →
  AGENTS.md → "Where Logic Lives"
- Deterministic editor rules (filename/tag parsing) may keep a synchronous TS
  copy in `packages/editor` to avoid a per-keystroke IPC/FFI hop, but it is
  conformance-locked bit-for-bit against the Rust impl. → tests/conformance
- The Tauri desktop Rust shell is a named adapter, not another domain layer.
  Its final module names, ownership boundaries, stable command/event surface,
  compatibility commands, watcher suppression, and inline-test convention are
  specified in [desktop-rust.md](../desktop-rust.md).
- The frontend Tauri platform boundary is owned by `src/lib/platform/tauri/`:
  `adapter.ts` owns construction plus notes-root and watcher lifecycle state;
  `storage.ts` owns non-note filesystem I/O; `images.ts` owns image persistence,
  URL policy, and capability state; clipboard access is part of `PlatformFS`;
  the remaining capability files own config/root policies; and
  `src/lib/platform/tauri.ts` is only the stable public composition facade.
- License parsing, verification, expiry, and activation are one Rust crate
  (`futo-notes-license`) projected to every shell; see
  [license.md](../license.md).
