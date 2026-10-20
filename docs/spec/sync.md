# Sync — Spec

E2EE sync. **All sync logic lives in the Rust `futo-notes-sync` crate**; every
shell only drives it. Native (iOS/Android) goes through the `futo-notes-ffi`
`SyncClient`; Tauri desktop goes through the `e2ee_*` Tauri commands (a thin
`apps/tauri/src-tauri/src/sync/tauri_commands.rs` wrapper) +
`syncServiceE2ee` + coordinator — both now drive the **same** `SyncSession`.
The session owns connection state, push-first cycles, and its live task; the
shells do not assemble those pieces themselves. Internally the crate is grouped
by ownership: `server/` owns the HTTP protocol; `checkpoint.rs` owns persisted
state and disconnect ancestry; `session/` owns connection lifecycle, cycle
serialization, live scheduling, and SSE framing; `sync/` owns the visible
push-first sequence and delegates vault I/O, push, pull, conflict resolution,
collision resolution, tombstones, encrypted-note conversion, transfer chunking,
batch download, and outcome composition to named modules. The client uploads
opaque encrypted blobs — note
content is encrypted before upload. Desktop sync module ownership and
serialization boundaries are fixed by [desktop-rust.md](desktop-rust.md).

- [Connect / run](sync/connect-and-run.md)
- [Hosted sync — Log in with FUTO](sync/hosted-sync.md)
- [Live sync (SSE)](sync/live-sync.md)
- [Conflict & data safety](sync/conflict-and-data-safety.md)
- [Instance journal](sync/instance-journal.md)
- [Polling](sync/polling.md)
