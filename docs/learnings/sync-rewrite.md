# Rewriting Sync From Its Behavioral Contract

Historical rewrite lessons. Current behavior and ownership are defined by `docs/spec/` and
the implementation. Follow-ups below describe the state at the end of this rewrite, not a
current issue inventory. The original accounting and execution log are available with:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/sync-rewrite.md
```

## The central lesson

The old implementation mixed product behavior with implementation policy. It
had many planners, adapter closures, intermediate structs, and tests coupled to
those private seams. Editing it incrementally preserved most of the accidental
architecture.

The useful boundary was:

1. Product behavior is defined by black-box tests that exercise a real server
   and real application adapters.
2. Safety invariants from `docs/spec/sync.md` remain explicit requirements.
3. Private implementation structure is replaceable.
4. Old unit tests are evidence to translate, not APIs to preserve blindly.
5. A regression is fixed at the smallest shared ownership boundary, never in a
   platform-specific shell.

This is not “delete code until the compiler is green.” The real-server and
two-client suites are the product gate. They cover encryption, optimistic
versions, tombstones, cursor movement, conflicts, reconnect ancestry, SSE
recovery, watcher behavior, and convergence.


## Preserve transport lifetimes when simplifying clients

The rewrite incorrectly retired timeout scaling for known-size encrypted blob
transfers and also accidentally removed the baseline total-request deadline. A
connect timeout alone is insufficient: once TCP connects, a server can stall
response headers or a body forever. Because no shell imposes another deadline,
connect and sync then remain pending without surfacing an error or reaching
their existing retry paths. Conversely, applying the baseline 30 s deadline to
a maximum-size blob would require roughly 28 Mbps of sustained payload
throughput, turning a healthy slow connection into a deterministic failure.

Finite and streaming requests need different client policies. The auth-mode
probe has a 5 s total deadline, ordinary finite requests have a 30 s deadline,
and known-size encrypted blob transfers use that baseline plus one second for
each complete 128 KiB of expected payload. Uploads know the ciphertext body
length; pull downloads use the server object's `size_bytes`; an unknown size
retains the finite 30 s baseline. Clamp expected sizes to the server's 100 MiB
blob limit: wire metadata is untrusted, and accepting an arbitrary `u64` would
turn a corrupt size into an effectively unbounded deadline. SSE uses a separate
client without a total deadline because the successful stream body is
intentionally long-lived. The SSE response-header phase and any non-success
response body are still finite operations and each has a 30 s deadline; after
successful headers, stream liveness is owned by the live loop's read-idle
watchdog. Keep tests for every side of this split: ordinary requests,
unknown-size blobs, stalled SSE headers, and error bodies must time out;
known-size transfers must scale and clamp untrusted sizes; and a successful
event stream must survive beyond the finite-request deadline. Those tests live
in `server.rs` and prove each deadline in isolation; the sync flow above them
has its own guard in `sync/failure_boundary_tests.rs`, so a stalled server
surfaces a sync failure rather than a cycle that never returns.


## Follow-up queue — closed

The audit left seven boundary cases that no cheap test could reach, because
each one lives behind a specific server response or a specific process
interruption:

1. Failed blob download caps the cursor and retries on the next pull.
2. The same cap applies during empty-map reconciliation.
3. A pull failure wins over a push watermark advanced in the same cycle.
4. Tombstone permission/I/O failures preserve ancestry and cap the cursor.
5. Tombstone conflict cleanup failure still reports the already-parked note.
6. HTTP 500 during create appears in the public failure summary.
7. Restart between push-state persistence and pull still receives a peer
   change.

All seven are now covered by `sync/failure_boundary_tests.rs`, one test per
case, each driven through the real `pull`/`push`/`cycle` entry points. The
enabling seam is `fault_injection` — a `#[cfg(test)]` scripted server that
speaks the real protocol over a real socket, serves a seeded encrypted vault,
and replaces selected responses with an injected fault. It generalizes the
per-file `MutationServer` fixtures the crate had grown privately, and it did
not bring back the old mock client, batch planner, or orchestrator
decomposition. Faults target three axes: the phase (a route belongs to push or
pull), the request (`When::Nth` fails one occurrence, so the next cycle meets a
healthy server), and the process boundary (a fault that aborts a cycle leaves
exactly the checkpoint the client persisted, which `restart_from_checkpoint`
reloads the way reconnecting does).

Two limits are worth knowing before reaching for it. An injected `Status(409)`
answers with an error body, so it produces a 409 transport error rather than
the structured optimistic-version conflict the real server sends; conflict
resolution stays owned by the real-server suite. And the tombstone-cleanup case
fails a counted directory `fsync` (`vault_fs::fail_directory_sync_on_call`),
so it is unix-only and its call index moves if the park path gains a sync.

Each case was mutation-verified red-capable before landing: disabling
`cap_cursor` reddens 1-5, clearing ancestry despite failures reddens 4,
dropping the create failure's status reddens 6, not reporting a parked
divergent note reddens 5, and making `push` advance the pull cursor — the F32
crash-window regression — reddens 7.


## Carry-forward audit of Tier-1 data-safety invariants

An independent audit checked whether each data-loss invariant fixed during the
architecture-hardening effort survived the rewrite with a test that can go red.

Result: all twelve invariants are implemented, and each has at least one
red-capable test. None is fully absent. Six were mutation-verified (break the
code, watch the named test fail, revert): cursor capping, tombstone
claim-and-park, stale-claim crash recovery, ancestry demotion, and
identical-content dedup.

Two invariants had **no test that runs in any automated pipeline**. Both are now
covered by offline crate-level unit tests in `sync/push/` (each proven
red-capable against the exact regression before finalizing):

- **413 oversize blobs.** The only prior test
  (`oversize_blob_is_surfaced_skipped_and_recovers`) gates on
  `FUTO_TEST_SMALL_BLOB_SERVER`, which CI never sets — CI boots only the 100 MiB
  `FUTO_TEST_SERVER`, so that test always early-returns. Added
  `push_skips_an_oversize_flagged_file_without_uploading_or_deleting_it` and
  `push_retries_an_oversize_flagged_file_after_its_mtime_changes`, covering the
  skip-while-unchanged and retry-on-mtime-change halves of the `oversize_skip`
  state machine (and that a skipped note is never tombstoned). The insert-on-413
  arm itself needs a real 413 response and remains covered only by the
  server-gated `oversize_blob_*` integration test — reproducing it offline would
  require a mock HTTP layer, which the rewrite deliberately removed.

- **F32 crash-window.** The design is safe — `push()` never advances
  `pull_cursor`; only a completed `pull()` does — but nothing asserted it. Added
  `push_preserves_the_pull_cursor`: a crash after push and before the following
  pull must re-deliver peer changes on restart. That is the push-side half of
  boundary case 7; the full restart-injection case is now covered too, by
  `restart_between_push_persistence_and_pull_still_receives_the_peer_change`.
  Both go red when `push` is made to advance the pull cursor. `cap_cursor`
  (failed download) and the 0-seed migration were already tested.

Three invariants remain red-capable only through the server or cross-platform
suites, with no cheap crate-level guard, and were **not** given offline tests:
push-first ordering inside `cycle()`, the merge-onto-tombstone local write in
`resolve_update_conflict`, and the `Mutation::Written if write.object.deleted`
branch of the rename-vs-edit case. Each is reachable only after a specific HTTP
response, so an offline test would require reintroducing the mock HTTP client the
rewrite removed. They run in CI on sync changes via `test:cross-platform-sync`;
restoring them offline is deferred rather than forced.
