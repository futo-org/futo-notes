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
- Server-contract change: `just test-sync-integration` (`node tests/sync-integration.mjs`). It
  starts isolated servers on this worktree's own ports, runs `server_integration` + `sse_live`
  against them, and stops them by PID — never the `:3005` demo server, never elitedesk, never
  production. Extra arguments go to the test binary.

  `server_integration.rs` needs TWO servers, because its two families need two modes that cannot
  be one process:

  | Family | Server | Variable |
  |---|---|---|
  | sync scenarios (dev login) | `AUTH_MODE=dev` | `$FUTO_TEST_SERVER` |
  | hosted scenarios (Log in with FUTO, billing) | `STANDIN_MODE=true` | `$FUTO_TEST_HOSTED_SERVER` |

  Against the wrong one the sync family fails `connect: Auth("unauthorized")` and the hosted family
  finds no routes. The runner starts both and sets both; by hand, set whichever family you want.
  A `$FUTO_TEST_HOSTED_SERVER` that is set and is NOT a stand-in server fails the run rather than
  skipping — unset it to skip deliberately.

- SSE changes are covered: the runner includes `sse_live`.
- Hosted-flow change: `cargo test -p futo-notes-sync --test hosted_setup` (an in-test stub of the
  hosted routes, which is what CI gets today), then the same scenarios against a real server:

  ```bash
  FUTO_NOTES_E2EE_SERVER_REPO=/path/to/futo-notes-server \
    FUTO_NOTES_E2EE_SERVER_STANDIN=1 just test-sync-integration
  ```

  A scenario lives once, in `tests/hosted_scenarios/`, and both runners call it. The hosted leg
  runs against a real server only when the resolved server can do stand-in test mode — the pinned
  release cannot yet, which is `"standinMode": false` in `scripts/sync-server-pin.json`, and the
  runner says so on every run. The stub goes away when the pin moves to a release carrying
  futo-notes-server#14-#17 (#185).
- Crypto, merge, conflict, or tombstone work uses `/sync-adversarial` and merits `/slow-review`.

Update `docs/spec/sync.md` with behavior and name the guarding test/scenario.
