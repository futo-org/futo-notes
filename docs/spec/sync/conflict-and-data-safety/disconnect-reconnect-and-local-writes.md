### Disconnect, reconnect and local writes

- **Disconnect demotes sync state to ancestry; it never just deletes it.**
  Disconnect (all three clients) replaces `.e2ee-state.json` with
  `.e2ee-ancestry.json` — filename → {objectId, last-synced content hash} —
  and the same demotion runs when a persisted state is dropped because the
  collection identity changed. The live cursor/object map is still discarded,
  so a reconnect can never propagate while-disconnected deletions as
  fleet-wide tombstones (missing local files are re-downloaded, as before).
  → futo-notes-sync `checkpoint.rs`, ffi `SyncClient::disconnect`, desktop
  `e2ee_disconnect`
- **Disconnect attempts to revoke the current bearer session before forgetting
  it.** All three shells reach `SyncSession::disconnect`, which sends
  `POST /api/auth/logout` with the bearer token. A failed or offline request
  cannot prevent local disconnect; in that case the server token may remain
  valid until its seven-day expiry or a password change. → futo-notes-sync
  `session/mod.rs` (`disconnect_revokes_the_bearer_session_before_forgetting_it`)
- **A reconnect after fleet drift does not mint conflict copies for notes the
  device never edited.** The bootstrap pull from cursor 0 consults the ancestry
  file: for the same objectId, local hash == last-synced hash ⇒ only the remote
  moved/renamed ⇒ fast-forward to the remote path and remove the stale local
  path (no park, no duplicate object); remote hash == last-synced hash ⇒ only
  local was edited while disconnected ⇒ keep local and push it as an update to
  the SAME object (no park, no duplicate object). Both sides changed, or no
  ancestry (fresh install, notes copied in without dotfiles) ⇒ the conservative
  F6 park above. This closes the July 2026 incident where a
  password re-login on a device that had been disconnected for days parked a
  stale `(conflict <oid32>)` copy of every note edited elsewhere in the
  meantime and synced the copies to the whole fleet. → futo-notes-sync store +
  sync modules; reconnect scenarios in the server integration suite
- **A reconnect honors peer deletes made while this device was disconnected —
  it does not resurrect them.** The bootstrap pull from cursor 0 inspects server
  TOMBSTONES (deleted objects), not just live ones. For each tombstone it
  matches the ancestry (object_id → last-synced filename + hash): if the local
  file is unchanged since the last sync it is deleted (the peer's delete wins);
  if it diverged (edited while disconnected) the local edit is preserved in a
  deterministic `name (conflict <oid32>).md` copy that push re-uploads as its own
  new object, and the tombstoned name is removed; a tombstone with no ancestry
  entry is left alone. Before the fix the `live`-only filter dropped every
  tombstone, so the local file survived and the next push re-POSTed it as a
  brand-new object — resurrecting the deleted note on every device permanently.
  The reconcile deletes are folded into the summary (deleted count + deletedIds)
  so the client rescan gate fires. (F1) → futo-notes-sync sync module;
  cross-platform
  scenario "peer deletes while disconnected"
- `write_atomic_text` overwrites a destination that differs only in **filename
  case** from an existing file instead of failing. On case-insensitive
  filesystems (default APFS on macOS/iOS, NTFS) `fs::rename` returns EEXIST for
  a case-variant destination; before the fix one colliding note aborted the
  _entire_ sync apply mid-download. The recovery PARKS the colliding entry as
  a hidden `.sf-bak-…` file (restored if the retry fails, deleted on success)
  rather than deleting it first — a crash mid-recovery leaves the old bytes
  recoverable on disk instead of losing them. → futo-notes-core
  `files/{atomic_write,parked_backup}.rs`; regression tests
  `recover_restores_a_note_stranded_in_a_parked_backup` and
  `recover_returns_a_divergent_backup_as_terminal`

- A save may only persist content read from a **live** editor view. The desktop
  shell's editor read returns `undefined` (never `''`) when no editor component
  is mounted, and every save path treats `undefined` as "no editor — skip". An
  empty string from a dead view is indistinguishable from "the user deleted
  everything": a stale flush firing against a torn-down editor saved `''` over
  the open note and sync propagated the truncation to every connected device
  (observed 2026-06-04 via a dev HMR swap; the same teardown race exists on
  note-switch/quit). → NotesShell.svelte `getEditorContent`,
  NoteWorkspace.svelte `EditorApi.getContent`, milkdown/hostHandleContent.ts `getContent`

- A note's modified time is **server-authoritative** so note-list ordering is
  identical on every device: a real push restamps the local file to the
  server's `updated_at`, every pull/download stamps it, and a
  content-identical local touch (editor re-save, relink rewrite, `touch`) is
  corrected back to the recorded server timestamp on the next sync rather
  than adopted. The bootstrap pull from cursor 0 likewise converges
  matching-content files to the server timestamp. An `updated_at` the client
  cannot parse stamps nothing: the file keeps its current time rather than
  becoming 1970 (→ `vault_fs::set_mtime_ms`, the one stamping owner).
  (Observed 2026-06-05: a
  content-identical rewrite on the Mac left `Markdown demo` sorted minutes
  newer than on Android/iOS.) → futo-notes-sync sync module

- **Closed (2026-06-05):** reconciliation of two _distinct_ notes whose
  filenames collide only by case (`welcome.md` vs `Welcome.md`) or by Unicode
  normalization (NFC vs NFD) on a case/normalization-insensitive FS no longer
  double-tombstones or loses a note. The original failure (observed 2026-06-04,
  mac ↔ iOS sim ↔ Android emu: the rename/hash reconciliation tombstoned
  **both** objects, deleting the note from every client) is replaced by the
  deterministic conflict-copy policy above: winner = smallest `object_id` keeps
  the canonical name, every other colliding object is materialized at `name
(conflict <oid32>).md`. The collision detector ranks the union of the current
  pull batch, the persisted object_map, and on-disk files, so the rival being
  already-present (not in the incremental batch) is handled — the exact
  double-tombstone path is gone. → futo-notes-sync sync module; F4/F5
  cross-platform scenarios.
