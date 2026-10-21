### Poll loop and external file changes

- Desktop auto-sync poll interval is intentionally short (the SSE live stream is
  the push replacement; the poll remains the desktop fallback) — don't lengthen
  it. → project decision
- Native shells do not run a foreground poll loop; the SSE live task's
  ~45 s safety poll covers liveness even when the stream is down (see "Live sync (SSE)"). → futo-notes-sync
  `session/`
- **An idle cycle is cheap.** A cycle that finds nothing to push or pull opens
  no new connection while the server's certificate stays trusted (one
  connection pool belongs to the `SyncSession` and serves its connect, push,
  pull, and SSE reconnect requests, so the TLS
  handshake is paid once per session rather than once per cycle) and writes
  nothing to disk (`checkpoint::save` leaves `.e2ee-state.json` alone when its
  bytes already match; a changed, torn, or missing file is still written).
  Independent sessions never share a pool, so unrelated async runtimes do not
  accidentally share transport state. The release journal measured the old
  per-cycle handshake at ~350 ms p50 over 17k cycles, and the old double
  checkpoint rewrite at ~1.8 MB per idle cycle on a 2.5k-note vault.
  Regression-guarded by `one_http_owner_reuses_its_connection`,
  `independent_http_owners_do_not_share_connections`, and
  `save_leaves_an_identical_checkpoint_untouched_and_rewrites_any_difference`.
  → futo-notes-sync `server/mod.rs` (`HttpClients`), `checkpoint.rs`; historical
  measurement in `docs/perf/sync-cycle-and-save-baseline.md`

- **External filesystem changes to the open note mirror disk, IDE-style
  _(desktop)_.** A watcher `change` whose disk content differs from the
  session's last-saved baseline is adopted immediately when the session is
  clean; a dirty draft is protected first and the adoption is deferred until
  the draft settles (blur, composition end, or one scheduled settle pass when
  the deferral arises while the editor is already blurred — a deferral is
  retained, never dropped, when a save races the disk read). Equality with the
  live editor is still adopted as a zero-diff apply so the saved baseline
  advances. Active-note `change` events bypass
  recent local/sync-write TTL suppression — including events buffered during a
  manual sync — so content comparison, not event timing, decides whether they
  are genuine external edits. An active IME composition defers before any
  flush or open-note disk read, refreshes the storage projection, and re-drives
  reconciliation when composition ends (or on blur); the deferred pass flushes
  safely and re-reads current disk content. Only
  content matching the saved baseline is a self-write echo and is dropped by
  comparison rather than event counting. The session is
  re-checked after each asynchronous disk read: a note switch drops the stale
  adopt. Every non-composing active-note `change` flushes the session before
  reading, so a timer-scheduled or in-flight dirty draft first runs through
  `flush_draft` and either writes or parks against the current disk base.
  Reconciliation never adopts over a save scheduled during the asynchronous
  read; that save settles through the same path, and only the guarded post-park
  reconcile re-reads and adopts while the save queue is still technically in flight. If validation or
  a write failure leaves the forced flush dirty, the watcher refreshes storage
  and defers adoption; the final adopt gate also refuses to replace any dirty
  session outside the guarded post-park path. That path carries the exact body
  and title parked by the save and adopts only while the live editor still
  matches both, including across its asynchronous disk read. The save itself is
  conditional against the session's saved-content base:
  matching disk is written, identical disk converges without a rewrite, and a
  stale draft against diverged disk is parked as a conflict copy instead of
  clobbering it. After a park, desktop projects the copy and explicitly
  reconciles the open note from disk (no toast), so the peer/external bytes are
  adopted while the draft survives in the list. The store and sync share one
  process-wide mutation guard across their check/write spans, closing the
  remaining read→compare→write interleaving window. A `change` that reads empty
  content closes the session as an external deletion only when the note no longer
  exists; an existing empty note adopts normally, and either path still emits the change's
  save notification exactly once. A watcher `unlink` always closes the open
  session and shows "Note was deleted externally"; if an already-started save
  completes afterward, its disk write still notifies sync but cannot restore
  the cleared session. → createExternalChangeCoordinator.ts (guarded by
  createExternalChangeCoordinator.test.ts and the cross-platform scenario
  "external watcher protects dirty draft then settles")
- **A watcher-reported desktop rename remains one rename through debounce,
  bulk refresh, and post-sync draining.** Rename chains are applied in event
  order, so the open note follows each engine `FollowRename` disposition and
  the resulting local change schedules one auto-push. A rename from `.md` to a
  non-note extension is handled as an unlink, a rename into `.md` is handled as
  an add, and renames between non-note files are ignored. → desktop
  `watcherBatch` + `createExternalChangeCoordinator` (guarded by their paired,
  bulk-chain, post-sync, and extension-transition tests)
