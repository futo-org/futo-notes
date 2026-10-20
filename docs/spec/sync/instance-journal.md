## Instance journal

- **Every sync cycle writes one `sync_run` record to the instance journal
  _(desktop)_.** The record names why the cycle ran (`manual`, `live_catch_up`,
  `local_change`, `remote_change`, `safety_poll`), how long each phase took
  (bootstrap / push / pull / total), what it moved (pushed, pulled, deleted,
  conflicts, local writes, failures, renames, oversize skips, tombstones), the
  version watermarks either side of it (`max_version`, `pull_cursor`, tracked
  objects, oversize-skipped), and the per-file reconcile decisions with the
  reason each branch was taken. A cycle that fails is recorded too, with its
  error and the phases that did run. → futo-notes-sync `journal.rs` +
  `sync/mod.rs` (guarded by "a journaled cycle records one run with its trigger
  counts and decisions" and "a failed cycle is still journaled with its error
  and watermarks" in `session/cycle.rs`)
- **A decision line is only written where the cycle acted.** Unchanged files,
  no-op re-pushes, and already-current objects are not journaled: a vault-sized
  wall of no-ops would bury the lines that explain an incident. →
  futo-notes-sync `sync/outcome.rs` `ReconcileDecision`
- **Journaling never changes what sync decides and never blocks it.** The
  writer is a bounded queue plus one background thread; under pressure it drops
  events and reports the count as a `journal_drops` record rather than applying
  backpressure. Push-first ordering is untouched. → futo-notes-core
  `journal/`
- **The journal lives in the app data dir, never inside a vault, and is never
  uploaded.** Desktop resolves `<app data>/<bundle id>/journal`, so the
  dev/release split follows the bundle identifier and `FUTO_NOTES_DATA_DIR`
  redirects both; journal files must not sync and must not appear in the note
  list. Retention is a size-capped ring (~20 MB, oldest segment dropped). →
  futo-notes-tauri `instance_journal.rs`
- **Each run of the app writes one `app_launch` marker _(desktop)_.** It names
  the version and bundle identifier that wrote the ring and is the anchor every
  later event is read against: a `sync_run` record says how long its cycle took,
  and only the marker can answer how long after opening the app the first one
  started. It also separates sessions in a ring that spans many runs. →
  futo-notes-tauri `instance_journal.rs`
- Read it with `just journal` (`tail`, `type <event>`, `last-sync`, `startup`,
  `where`), or with `jq` over the JSONL directly. `startup` reports, per launch,
  how long until that session's first cycle started. → scripts/journal.mjs
  > **Gap:** Only the desktop shell opens a journal. iOS and Android run the
  > same sync crate, but `SyncSession::set_journal` is not exposed through
  > `futo-notes-ffi`, so a native shell's runs are not recorded and `just
journal --dir` has nothing to read from a phone.
  > **Gap:** The desktop scheduler's own triggers are not distinguishable in the
  > record. Launch, poll, and resume all reach Rust through the one
  > `e2ee_sync_run` command and are journaled as `manual`, so a cycle cannot be
  > told apart from a user pressing "Sync now"; only the live loop's four
  > triggers are recorded faithfully.
