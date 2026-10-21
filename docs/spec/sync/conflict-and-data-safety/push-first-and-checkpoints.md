### Push-first, checkpoints and the pull cursor

- A push checkpoint is written every 50 objects. → migration plan Phase 5
- A legacy `.app-state.json` is migrated on first run. → migration plan Phase 5
- **Concurrent-move dedup keys on OBJECT IDENTITY, never on (content-hash,
  basename).** When the SAME server object surfaces under two on-disk filenames
  in one cycle, it collapses to the highest-`change_seq` name and the redundant
  local copy is removed (local file + map entry only — no server DELETE, since
  the object survives under the winner and a DELETE would tombstone it). Two
  LEGITIMATELY DISTINCT notes that merely share a basename and content (e.g. two
  empty `Untitled.md` in different folders) are different objects and BOTH
  survive — the old (content-hash, basename) key deleted one of them on
  server+disk when a same-content delete happened in the same cycle (F9). →
  futo-notes-sync sync module; cross-platform
  scenario "distinct same basename survives move dedup"
- **Sync is push-first on every client and every trigger.** The native (iOS /
  Android) FFI `sync_now`, the SSE live loop, and the debounced auto-push all
  run the same full push-first cycle as desktop. A
  locally-edited-but-unpushed note is therefore PUT before any
  pull writes to disk, so a peer edit arriving via SSE can never silently
  overwrite it (the push 409 path runs the 3-way merge / conflict-copy, and the
  subsequent pull starts from the pre-push cursor so the just-pushed edit is
  never re-downloaded). The pre-fix native path ran pull-then-push, so a pulled
  peer edit clobbered the unpushed local edit on disk before push could detect
  the conflict — silent data loss, `conflicts == 0` (F1). → futo-notes-ffi
  `SyncClient::sync_now` + `SyncSession::start_live`; server/cross-platform
  integration suites
- **A push may infer local deletions only from a complete vault scan.** Failure
  to read the vault root, any nested directory entry, or any file metadata
  aborts the cycle before the HTTP client is constructed and before any remote
  create, update, or tombstone. A partial scan is never treated as an
  authoritative list of missing files, because that could turn a transient
  local I/O failure into fleet-wide deletion of healthy remote objects.
  Likewise, a post-scan content-read failure while pairing a possible rename
  aborts before any HTTP mutation; the unreadable replacement is never skipped
  while its old mapped name continues into remote deletion. The
  scanner reads symlink metadata and never follows file or directory symlinks,
  so a vault link cannot upload content outside the selected root or recurse
  through a directory cycle. On Unix platforms, every later note/blob read,
  atomic write, remove, timestamp update, tombstone claim, and conflict
  relocation resolves each parent from an open vault-root directory descriptor
  with `NOFOLLOW`; a scan-to-use symlink swap therefore cannot escape the vault.
  Successful namespace writes/removes/renames fsync their affected parent
  directories and surface a directory-sync failure instead of reporting durable
  success. Because that error arrives after the namespace mutation, callers
  treat it as an uncertain commit and retry idempotently: the retry re-fsyncs
  even when the desired bytes already match, the removed leaf is already
  absent, or the rename has already reached its destination. Every newly
  created parent entry is also fsynced in its containing directory before use,
  including when retry finds an uncertain prior `mkdir` already present; only
  then may object-map/cursor checkpoints advance.
  Other platforms reject symlinks observed while resolving the path, but do not
  yet provide the same descriptor-relative race guarantee. On every platform, a
  vault-relative path whose parent folder is missing is ABSENT rather than a
  fault: existence checks answer no, removes and renames report nothing moved,
  and the write paths create the folders they need — so a note arriving for a
  folder this client has never had is written, not failed (github#48). Only a
  genuine obstacle — a symlink, a plain file where a folder belongs, no
  permission — is an apply failure. The same fallible
  scanner is used by conflict/tombstone copy naming; no sync call site receives
  a best-effort file list. → futo-notes-sync `sync/vault.rs`,
  `sync/vault_fs.rs`, and `sync/push/`, over futo-notes-core
  `files/vault_fs/{unix,fallback}.rs`; regression tests `scan_reports_*`,
  `scan_never_follows_*`, `content_*_never_follow_*`,
  `collision_placement_never_renames_*`,
  `incomplete_root_scan_stops_before_remote_deletion`,
  `files::vault_fs::contract_tests::*` (stamped over both implementations), and
  `a_note_in_a_folder_this_client_does_not_have_yet_is_written`
- **The persisted pull cursor never advances past changes we have actually
  pulled — even across a crash mid-push.** State carries TWO watermarks:
  `max_version` (the highest `change_seq` seen; push folds its uploads in and
  persists it mid-push via the interim checkpoint / tail flush / final persist)
  and `pull_cursor` (the `since` for the next pull). `run_sync` derives `since`
  from `pull_cursor`, and ONLY a completed `pull::pull_with_checkpoint`
  (incremental or bootstrap) advances it; push leaves it untouched. So a crash
  between a push state-persist and pull completion leaves `pull_cursor` at the
  last fully-reconciled position, and the restart still re-lists any peer object
  whose `change_seq` sat below our pushed seqs. Persisting only `max_version`
  (the pre-fix behavior) elevated the pull cursor past un-pulled peer changes,
  hiding them permanently until the peer re-touched the note or a disconnect
  forced a bootstrap pull from cursor 0 (F32). State-file compatibility +
  retroactive heal: `pull_cursor` is an additive serde-default field; a pre-field
  `.e2ee-state.json` (or a legacy `.app-state.json` import — the pre-port TS
  client folded its own pushes into `e2eeMaxVersion` the same way) may itself
  carry a crash-elevated cursor, so an absent `pull_cursor` is DISTRUSTED and
  seeded to 0. The first post-upgrade sync therefore re-lists from scratch —
  idempotent (`first_pass` hash/identity-dedupes, no re-downloads or conflict
  copies for already-synced notes) — and RETROACTIVELY heals any install already
  carrying hidden F32 damage. → futo-notes-sync `checkpoint.rs` + `sync/`
- **A final checkpoint write failure does not discard successful in-memory sync
  progress.** Push and pull return the updated `ConnectedState`, record one
  `FailureKind::Checkpoint` in the combined `SyncSummary`, and let
  `SyncSession` install that state. A retry in the same running session therefore
  retains uploaded object IDs and downloaded mappings/cursors instead of
  POSTing duplicate server objects. Pull ancestry is cleared only after its
  checkpoint is durably saved. This preserves the push-first sequence and both
  watermarks; it changes only how the local persistence failure is reported and
  installed. Guarded by
  `uploaded_state_survives_final_checkpoint_failure_in_the_running_session` and
  `downloaded_state_survives_final_checkpoint_failure_in_the_running_session`.
  A pull failure after a successful push preserves the same pushed state even
  when its interim checkpoint also failed; guarded by
  `uploaded_state_survives_when_checkpoint_and_following_pull_fail`.
  A fatal push-side delete-conflict recovery after earlier successful uploads
  likewise returns the partially advanced push state to the session; guarded by
  `uploaded_state_survives_a_later_fatal_delete_conflict`.
  If the process exits before a later checkpoint save succeeds, disk may still
  contain the older map/cursors. Creates are now safe across that window: their
  Mutation ID was checkpointed before dispatch, so restart replays the same
  retained server outcome and never mints another upgraded-server object.
  Updates and deletes
  retain their existing version-guarded retry behavior. Against a legacy server
  that ignores `Mutation-Id`, sync remains compatible but an ambiguous
  classic-create response retains the legacy duplicate risk. The visible
  checkpoint failure remains the signal that durable local state is behind. →
  futo-notes-sync `checkpoint.rs` + `sync/push/` + `sync/pull/` + `session/`
