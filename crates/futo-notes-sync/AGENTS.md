# AGENTS.md — Sync Engine

Root `AGENTS.md` and `docs/spec/sync.md` apply. This crate owns connection/session state,
push/pull planning, conflicts, checkpoints, the SSE live loop, and the hosted setup sequence
(`hosted/`: Log in with FUTO, billing, checkout, the three vault doors, and sign out). Shells
project all of it; they never hold an ordering rule of their own.

## CRITICAL invariant

Every trigger is push-first: dirty local edits are PUT before any pull writes disk. Never weaken
this ordering to fix a test. `SyncSession` owns mutually exclusive cycles and live-sync lifecycle;
shells project it rather than reconstructing the protocol.

## Verification

- Any change: `cargo test -p futo-notes-sync`.
- Protocol/engine change: add a scenario to `tests/cross-platform-sync.mjs`, register it in
  `scenarios`, then run `just test-cross-platform`.
- Server-contract change: use an isolated server — never the `:3005` demo server, never elitedesk,
  never production:

  ```bash
  FUTO_TEST_SERVER=http://127.0.0.1:3055 cargo test -p futo-notes-sync \
    --test server_integration -- --ignored --test-threads=1
  ```

- SSE changes also run the ignored `sse_live` test against that isolated server.
- Hosted-flow change: `cargo test -p futo-notes-sync --test hosted_setup` (an in-test stub of the
  hosted routes, which is what CI gets), then the same scenarios against a real server started in
  stand-in test mode:

  ```bash
  STANDIN_MODE=true DATABASE_URL="sqlite:$SCRATCH/standin.db" PORT=3077 futo-notes-server
  FUTO_TEST_SERVER=http://127.0.0.1:3077 cargo test -p futo-notes-sync \
    --test server_integration -- --ignored --test-threads=1
  ```

  A scenario lives once, in `tests/hosted_scenarios/`, and both runners call it. The stub goes away
  when the server pin bumps (#185).
- Crypto, merge, conflict, or tombstone work uses `/sync-adversarial` and merits `/slow-review`.

Update `docs/spec/sync.md` with behavior and name the guarding test/scenario.
