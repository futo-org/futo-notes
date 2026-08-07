# crates/futo-notes-sync — sync engine

Read root `AGENTS.md` and `docs/spec/sync.md`. This crate owns session state, push/pull, conflicts,
checkpoints, and the SSE live loop.

## CRITICAL invariant

Every trigger is push-first: dirty local edits are PUT before any pull writes disk. Never weaken
this ordering to fix a test. `SyncSession` owns mutually exclusive cycles and live-sync lifecycle;
shells project it rather than reconstructing the protocol.

## Verification

- Any change: `cargo test -p futo-notes-sync`.
- Protocol/engine change: add and register a scenario in `tests/cross-platform-sync.mjs`, then run
  `just test-cross-platform`.
- Server-contract change: use an isolated server, never `:3005` or production:

  ```bash
  FUTO_TEST_SERVER=http://127.0.0.1:3055 cargo test -p futo-notes-sync \
    --test server_integration -- --ignored --test-threads=1
  ```

- SSE changes also run ignored `sse_live` tests there.
- Crypto, merge, conflict, or tombstone work uses `/sync-adversarial` and merits `/slow-review`.

Update `docs/spec/sync.md` with behavior and name the guarding test/scenario.
