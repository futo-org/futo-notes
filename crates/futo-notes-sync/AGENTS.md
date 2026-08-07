# AGENTS.md — Sync Engine

Root `AGENTS.md` and `docs/spec/sync.md` apply. This crate owns connection/session state,
push/pull planning, conflicts, checkpoints, and the SSE live loop.

## CRITICAL invariant

Every trigger is push-first: dirty local edits are PUT before any pull writes disk. Never weaken
this ordering to fix a test. `SyncSession` owns mutually exclusive cycles and live-sync lifecycle;
shells project it rather than reconstructing the protocol.

## Verification

- Any change: `cargo test -p futo-notes-sync`.
- Protocol/engine change: add a scenario to `tests/cross-platform-sync.mjs`, register it in
  `scenarios`, then run `just test-cross-platform`.
- Server-contract change: use an isolated server, never the `:3005` demo server:

  ```bash
  FUTO_TEST_SERVER=http://127.0.0.1:3055 cargo test -p futo-notes-sync \
    --test server_integration -- --ignored --test-threads=1
  ```

- SSE changes also run the ignored `sse_live` test against that isolated server.
- Crypto, merge, conflict, or tombstone work uses `/sync-adversarial` and merits `/slow-review`.

Update `docs/spec/sync.md` with behavior and name the guarding test/scenario.
