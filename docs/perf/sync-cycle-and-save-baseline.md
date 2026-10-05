# Sync cycle and note save — baseline and first climb

Measured 2026-09-05 on `perf/hill-climb` (off `main` at `6d59965d`). Two
harnesses reproduce every number here:

- `crates/futo-notes-sync/tests/perf_cycle.rs` — idle sync cycles against a
  live isolated server: wall time, TCP connections opened per cycle, checkpoint
  rewrites. `FUTO_TEST_SERVER=http://127.0.0.1:3055 cargo test -p futo-notes-sync
--test perf_cycle -- --ignored --nocapture`
- `crates/futo-notes-store/tests/perf_save.rs` — `LocalNoteStore::save` /
  `create` / `startup_listing` / `bootstrap` on a synthetic vault.
  `FUTO_PERF_NOTES=10000 cargo test --release -p futo-notes-store --test
perf_save -- --ignored --nocapture`

## Where the numbers came from

The release app's own instance journal (`just journal type sync_run --release
--json`) held 18,574 sync cycles over 19.1 days for this machine's 2,557-note
vault — roughly 970 cycles a day. Grouped by trigger and whether the cycle
moved anything:

| cycle kind                              | n      | pull p50 | pull p90 | push p50   | total p50  |
| --------------------------------------- | ------ | -------- | -------- | ---------- | ---------- |
| safety poll, nothing to do              | 11,334 | 365 ms   | 493 ms   | 14 ms      | 399 ms     |
| desktop poll ("manual"), nothing to do  | 4,449  | 358 ms   | 440 ms   | 14 ms      | 390 ms     |
| SSE remote change, nothing left to pull | 955    | 350 ms   | 388 ms   | 13 ms      | 377 ms     |
| local edit pushed                       | 887    | 350 ms   | 383 ms   | **391 ms** | **765 ms** |
| remote change pulled                    | 367    | 354 ms   | 470 ms   | 393 ms     | 763 ms     |

Two facts fall out. A pull that fetches nothing costs ~360 ms, and the same
pull against a localhost server costs 8 ms — so ~350 ms of every cycle is the
network path, not the work. And pushing one edited note costs ~390 ms, so an
edit reaches a peer in ~765 ms plus the peer's own pull.

## Cause 1: a new TLS connection per cycle

`session::connect::client` built a fresh `Http` — two fresh `reqwest::Client`s,
each with an empty connection pool — for every push, every pull, and every SSE
reconnect. Every cycle therefore paid a TCP + TLS handshake to the server. A
fresh-vs-reused probe on this network with the same reqwest features (public
FUTO host, one GET, n=10) puts the per-connection tax at roughly 3×:

|                                   | p50     | p90     |
| --------------------------------- | ------- | ------- |
| fresh client per request          | 122 ms  | 148 ms  |
| reused client                     | 40 ms   | 47 ms   |
| `Client::builder().build()` alone | 0.00 ms | 0.02 ms |

**Fix:** one session-owned `reqwest::Client` per role (request / SSE), cloned
into every `Http` used by that `SyncSession` (`server/mod.rs` `HttpClients`). A
session therefore keeps its connections warm across connect, push, pull, and
SSE reconnects without sharing transport state with another session; every
per-request timeout is unchanged. Harness, 500 notes, 20 idle cycles:

|                                       | before | after |
| ------------------------------------- | ------ | ----- |
| TCP connections closed per idle cycle | 1.0    | 0.0   |
| pooled connection kept across cycles  | no     | yes   |

The field number to watch after this ships is the journal's `pull_ms` p50 for
`safety_poll` cycles: it should fall from ~365 ms toward one round trip.

Known trade-off: a server or proxy that closes idle keep-alive connections can
race a non-idempotent request (a PUT after a silent close). hyper drops a
connection it sees closed before reuse, `transport_error` already classifies a
reset pooled socket as transient, and the next trigger retries the cycle. The
45 s safety poll is inside reqwest's 90 s pool idle timeout, so the pooled
connection is normally warm when the poll fires.

## Cause 2: two full checkpoint rewrites per idle cycle

Every push and every pull ended in `checkpoint::save`, which pretty-printed
`.e2ee-state.json` (902 KB for 2,557 tracked objects), wrote a temp file,
fsynced it, renamed it, and fsynced the directory — twice per cycle, to land
bytes identical to the ones already there. At ~970 cycles a day that is about
1.8 GB of writes and ~1,900 fsyncs a day for nothing.

**Fix:** `save` reads the current file and returns early when the bytes match.
The comparison is against the file on disk, never the previous in-memory
state, so a torn, stale, or missing file is still rewritten (locked by
`save_leaves_an_identical_checkpoint_untouched_and_rewrites_any_difference`,
which fails against the old `save`). Harness: checkpoint rewritten on 20/20
idle cycles → 0/20.

## Cause 3: every note save walked the whole vault twice

`LocalNoteStore::save` → `write_raw` refuses a case/NFC-folded twin before
writing (`colliding_note`), and that check walked the entire vault and folded
every id (NFC + lowercase, two allocations per note) on every autosave;
`install_new` → `unique_note_id` repeated the walk for every create. A save cost
more than reading the whole vault. The position walk in `finish_mutation` is a
second full walk and is unchanged (it needs every note's mtime).

**Fix:** `vault::collision_candidates` walks with the same rules as `walk`
(hidden entries, depth cap, no symlinks, same safe-id filter) but prunes every
directory whose folded relative path does not match the wanted id's prefix —
one or two directory reads instead of one per folder plus one folded key per
note. Semantics are locked by
`collision_check_sees_folded_twins_behind_variant_folders_at_any_depth`, which
passes against the old walk too.

Release build, this machine (btrfs on NVMe, warm cache):

|                                | 2,500 notes before | after       | 10,000 notes before | after      |
| ------------------------------ | ------------------ | ----------- | ------------------- | ---------- |
| `save` existing note p50       | 3.79 ms            | **1.95 ms** | 16.2 ms             | **8.9 ms** |
| `create` new note p50          | 3.52 ms            | **1.95 ms** | 15.6 ms             | **8.7 ms** |
| `startup_listing` (stat-only)  | 2.9 ms             | 2.9 ms      | 12.7 ms             | 12.3 ms    |
| `bootstrap` (reads every note) | 3.6 ms             | 3.4 ms      | 13.4 ms             | 11.6 ms    |

Debug build at 2,500 notes: 15.4 → 6.5 ms. The win matters most where it was
not measured: Android's FUSE-backed device storage, where each directory read
is orders of magnitude slower than here, and the removed walk was ~30 of them
per save.

Tried and dropped: stat-ing in parallel with rayon in `listing` /
`note_order_and_folders` (as `snapshot` does). Warm-cache `statx` is
CPU-bound at ~1 µs, so the thread pool cost more than it saved (2,500 notes:
listing 7.0 → 13.6 ms debug). Worth re-trying only on a slow filesystem.

## What was measured and found healthy

- Desktop IPC surface (debug build, 2,493-note vault, from the webview):
  `startup_listing` 10 ms / 150 KB, `snapshot` 26 ms / 733 KB, `read` of an
  820 KB note 13 ms, small `read` <1 ms, `search` ~1 ms, `save` 14 ms.
- Desktop cold start (dev build, Vite): the first list frame lands 82 ms after
  the app asks for the listing; module loading before that is Vite's, not the
  app's. The Rust side is not on the startup critical path.
- Search: mtime-gated reconcile skips unchanged notes on a warm start;
  incremental upserts are debounced 200 ms with one commit per batch.
- Sync push: unchanged files skip by mtime + size before any read or hash.
- Both native shells pre-warm and reuse one editor WebView for the app's life.
- Server (Go, SQLite): `List` is indexed on `(collection_id, user_id,
change_seq)`, sessions are one SHA-256 + one indexed SELECT per request, and
  `http.ListenAndServe` keeps idle connections open (no `IdleTimeout`), so
  client-side pooling is honored.
- Frontend bundle: 1.9 MB / ~500 KB gzip, already split; the 549 KB CodeMirror
  chunk is being replaced by the Milkdown transition.

## Remaining hills (measured, not climbed)

1. **`finish_mutation`'s position walk** is now the whole remaining save cost
   (8.9 ms at 10k notes in release): a full walk plus one stat per note to
   report the saved note's list position. Avoiding it needs either an
   in-store index of `(id, mtime)` kept honest against sync's direct writes,
   or a stat-then-splice that risks an off-by-one position under a concurrent
   external writer. Neither is free; decide with a slow-filesystem number.
2. **Native first frame reads every note.** Desktop renders its first list
   from the stat-only `startup_listing` and hydrates previews afterwards; the
   FFI exposes only `bootstrap` (reads every note), so Android and iOS gate
   `hasBootstrapped` on the full read. Exposing `startup_listing` over UniFFI
   and adopting the two-phase load in both shells is a device-measured task.
3. **Field confirmation of cause 1.** The 350 ms was measured over Tailscale
   Funnel; the reused-connection number here is from a different host. Read
   `just journal type sync_run --release --json` again after a release carries
   these changes.
