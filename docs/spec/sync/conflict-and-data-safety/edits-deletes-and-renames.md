### Edits, deletes and renames

- A dirty-merge (local edits plus a remote change to the same note) parks the
  local edits in a `note (conflict YYYY-MM-DD).md` copy rather than discarding
  them. → futo-notes-sync sync module
- **A local edit to a note a peer deleted is preserved, not discarded.** When a
  dirty local edit is pushed but the server object was tombstoned by a peer, the
  edit is re-POSTed as a fresh LIVE object at its own filename instead of being
  dropped. The server's DELETE keeps the object's blob_key and bumps its version,
  so the push PUT 409s with a blob present (not `None`) and the 3-way merge
  re-PUT "succeeds" — but the row is still `deleted: true` (a PUT does not
  un-delete). Mapping the note to that tombstone would let the same cycle's pull
  immediate-delete erase the merged edit. The resolver reads the `deleted` flag
  on the re-PUT response and, when set, re-POSTs the content as a fresh object;
  it also handles the degenerate `current_blob_key: None` shape the same way.
  Re-mapping the filename to the new object stops the tombstone (old object id)
  from matching any local file, so the pull cannot re-delete it, and the edit
  propagates back to the peer. Symmetric with the edit-wins delete-conflict (a
  peer edit to a note WE delete keeps the peer edit). The old code returned an
  `UnresolvedConflict` that wrote nothing / mapped the note to the tombstone, and
  the edit was silently lost. (F3) → futo-notes-sync sync module;
  cross-platform scenario "edit vs peer delete preserves edit"
- A direct PUT that "succeeds" onto a still-deleted server row (the server's
  DELETE bumps the version, so a concurrent editor's expected-version can
  collide and no 409 fires) is detected via the response's `deleted` flag and
  the edit is re-POSTed as a fresh live object — never mapped to the tombstone
  where the puller's own pull would delete it. → futo-notes-sync sync module
- **A tombstone park is a reported relocation, so the open editor follows it.**
  When a peer's tombstone arrives and the local file has diverged from the
  deleted version (the body autosave landed after this cycle's push phase, so
  push-first had nothing to send), the pull parks the local content in a
  `name (conflict <oid32>)` copy and reports the move in `SyncSummary.renamed`
  alongside the deletion — which ghost-stripping then removes from
  `deletedIds`/`peerDeletedIds`, because the note moved rather than vanished.
  Reporting only the deletion stranded the shell: a draft that had just reached
  disk is `draft == base`, so the open note classified as a peer delete with
  nothing to preserve (`Close`) and the editor closed with its buffer discarded
  while the text sat in the copy (disp-05, ~25% of runs). Following the rename
  is also the only F4-safe answer — the editor never stays bound to the deleted
  id, whose next save would resurrect it fleet-wide. Like every other reported
  relocation the follow is silent — the retitled editor is the only signal that
  the peer's delete landed and the local text became a copy. → futo-notes-sync
  `sync/tombstones.rs` `park_divergent_claim` (guarded by
  `tombstone_park_of_diverged_content_reports_rename_intent`,
  `tombstone_of_unchanged_content_reports_no_rename`, and
  `a_reported_rename_is_always_followed` in `open_note.rs`); desktop guarded by
  "follows a tombstone park onto the conflict copy holding the saved draft" in
  src/features/sync/syncManager.test.ts
- Pull-side filename collisions between byte-identical objects adopt silently
  (smallest object id stays canonical; the identical loser mints NO
  `(conflict <oid32>)` copy and its map entry is dropped without tombstoning
  the live server object) — only genuinely divergent content is parked. →
  futo-notes-sync sync module
- Renames are paired — a rename is not seen as delete + create. → migration plan
  Phase 5
- **Sync reports rename intent; shells never infer renames from id patterns.**
  Every relocation the sync engine performs — paired local moves, mapping
  relocations, merge-target moves, and collision placements that relocate a
  locally-mapped note (the loser's move to `name (conflict <oid32>)`) — is
  reported in the locally-computed `SyncSummary.renamed` (no sync payload or
  protocol change; a byte-identical collision loser adopts silently and
  reports no rename). The desktop follows the open tab/editor through a
  reported rename verbatim; its former id-pattern inference
  (`findActiveSyncRename` / `isCollisionVariantId`) is deleted. →
  futo-notes-sync `sync/collision_resolution.rs` (guarded by
  `collision_placement_reports_the_relocated_local_note_as_a_rename` and
  `identical_content_collision_dedup_reports_no_rename` in
  `sync/behavior_tests.rs`); desktop `reconcileSyncCompletion.ts` (guarded by
  the cross-platform scenario "collision placement follows open note" in
  tests/cross-platform-sync.mjs)
- **Following a reported rename is one atomic retarget of route AND editor**
  _(desktop)_. A single helper moves the tab/route and — while the session is
  still bound to the old id — the open editor's id and title, whether the
  retarget comes from the classifier's `FollowRename` verdict or from sync
  completion projecting a rename the classifier never answered for (a failed or
  unavailable `e2ee_classify_open_note`; the browser dev/test lane has no engine
  to ask at all). Projecting the tab alone left the URL and tab on the new title
  while the title input kept the old one. Applying a reported rename without a
  verdict cannot disagree with the engine: a reported rename outranks every
  other fact and always yields `FollowRename`. →
  src/features/sync/syncManager.svelte.ts `applyReportedRename` (guarded by
  tests/remote-rename.spec.ts "open note stays open when sync reports a
  rename", which runs on the browser lane that has no classifier; the
  engine side by "a reported rename outranks …" in
  `every_reachable_fact_combination_has_one_verdict`)
- **Every shell family is handed the same cycle report.** The desktop IPC
  contract and the UniFFI contract both project the engine summary losslessly —
  the four counters plus `updatedIds`, `deletedIds`, `peerUpdatedIds`,
  `peerDeletedIds` and the reported `renamed` pairs — so no shell has to
  re-derive what changed from counts (ADR-0001). Each projection destructures a
  fully populated engine summary in its own test, so a new engine field cannot
  reach one shell family while silently skipping the other. →
  apps/tauri/src-tauri/src/sync/frontend_contract.rs and
  crates/futo-notes-ffi/src/sync/contract.rs (both guarded by
  `projection_carries_every_engine_field`)
  Both native shells act on that report directly: their list projections apply
  the engine's complete scoped mutation (canonical positions and folders
  included), and their open-note executors follow reported renames before
  reading the target. → `NoteStore.refresh_external_changes`;
  iOS `SyncManager.onLocalTreeChanged` / `NotesStore.localTreeChanged` /
  `OpenNoteReconciler`; Android `SyncManager.kt`, `NotesStore.kt`,
  `NoteEditorScreen.kt`
- **A relocation the ENGINE performs never hides a real update OR deletion of
  its target.** Summary ghost-stripping removes only the rename's from-side from
  `deletedIds`/`peerDeletedIds` (the "delete at the old name" byproduct every
  relocation records); nothing is recorded against the target side, so an id
  recorded there — an update OR a deletion — is always a real, subsequent
  same-cycle event and stays shell-visible. A same-cycle peer edit to a
  collision-relocated note keeps its entry in `updatedIds`/`peerUpdatedIds`, so
  the shell that followed the rename reloads the peer's content instead of
  keeping the stale relocated draft (whose next save would overwrite the peer
  edit on every client); a same-cycle tombstone of it keeps its entry in
  `deletedIds`/`peerDeletedIds`, so the shell runs its deleted-during-sync
  close/keep-draft flow instead of leaving the editor bound to a nonexistent
  note. Consequently a relocation records its byproduct against the SOURCE id
  only — the "delete at the old name" plus the rename pair — never a synthetic
  update against the target. This holds for the relocations the engine performs
  itself — collision placements, mapping relocations, merge-target moves, and
  paired same-basename local moves — because those keep the note's OBJECT
  identity across the move (`mapped_name`), so a same-cycle change to the target
  side still has an object to be reported against. **An `mv` performed outside
  the app is a different case and is NOT covered.** Pairing there is by CONTENT
  identity: `derive_renames` pairs an object-map removal with an addition of the
  same hash (and `detect_local_renames` claims a push-side rename only on same
  hash AND same basename, i.e. a folder move), so a pure external `mv` does pair
  and the open editor follows it in place, while an external `mv` PLUS a content
  change in the same cycle pairs with nothing — there is no surviving identity to
  pair by, the engine honestly reports a delete at the old id and a create at the
  new one, and the open editor runs the deleted-during-sync close/keep-draft
  flow. Verified on device 2026-08-10: pure `mv` → `renamed=["A->A2"]` and the
  editor followed in place; `mv` + content change → `renamed=[]`,
  `deletedIds=["B"]` and the editor closed. That is correct engine behavior, not
  a divergence — it has been filed as a bug twice. → futo-notes-sync
  `sync/outcome.rs` `remove_rename_ghost_ids` + `derive_renames`,
  `sync/push/local_changes.rs` `detect_local_renames`,
  `sync/pull/apply_remote.rs` `relocate_existing_mapping`, and
  `sync/collision_resolution.rs` `move_collision_loser` (guarded by
  `same_cycle_update_of_a_collision_relocated_note_survives_ghost_stripping`
  and
  `same_cycle_tombstone_of_a_collision_relocated_note_survives_ghost_stripping`
  in `sync/behavior_tests.rs`); desktop guarded by "reloads a followed rename
  target that also received a real update in the same cycle" and "closes the
  open note when a followed rename target was tombstoned in the same cycle" in
  src/features/sync/syncManager.test.ts
