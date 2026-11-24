### Remote edits to the open note

Native mobile consumes the attached-session [saving and outside-writer contract](../../editor/portable-core/recovery.md). Desktop renders the engine classifier over its editor host below.

- *(mobile)* A sync cycle projects its affected ids and explicit rename pairs into the local store before notifying views. The Rust attachment follows the authoritative identity; the native renderer requests a checkpoint and drains returned coordinated changes rather than replacing its own buffer from a JavaScript snapshot. → crates/futo-notes-store/src/editor_session/identity.rs, apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt
- *(mobile)* A clean native attachment adopts an existing outside source on checkpoint. An unsaved local contribution is never overwritten: independent changes merge, while ambiguous overlap parks the draft and preserves the outside version. The engine owns the baseline, selection and history rebasing; failed persistence keeps the attachment and exact draft retryable. Consecutive outside edits follow the same path. → [portable recovery](../../editor/portable-core/recovery.md), apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Saving.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineStorage.kt
- *(mobile)* Adoption preserves the caret/selection and the reader's scroll position while applying the engine's changed window. A peer deletion closes only the visible clean note, with deletion feedback; a dirty note remains available and its edits survive through the session's edit-wins checkpoint. A covered editor never pops the screen above it. → apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt, [portable recovery](../../editor/portable-core/recovery.md)

- *(desktop)* The adopt works for **every consecutive** remote edit, not just the
  first. The adopt itself (`takeOutsideEditorChange`: an adoption in place, or
  a reload) must never count as a user edit (`editVersion++`): it once echoed back through the editor's
  coalesced `onchange` and made `handleSyncComplete`'s edited-during-sync gate
  silently skip every subsequent adopt until the note was reopened (observed
  2026-06-04: iPhone edit #1 appeared in the open mac editor, edit #2 never
  did). The desktop editor's `onchange` reports only an edit its engine
  applied for the user, never an adoption, load or reload, so there is no echo
  to count. An edit
  that leaves the draft back at the baseline still counts, as `open_note.rs`
  intends. The adopt gate additionally checks `hasOpenDraftChanges()` (a
  synchronous live-doc read) so a keystroke whose coalesced report is still
  pending can never be clobbered by the initial adopt decision. When a draft is protected
  because it is dirty, was edited during the running cycle, or marked text is
  composing, sync completion leaves BOTH the editor and its saved-content
  baseline untouched (marked text defers the adopt to composition end). Keeping
  the pre-pull baseline is what makes the host's next save a three-way
  decision: independent changes merge, and overlap parks the draft as a
  conflict copy while the peer's pulled bytes stay at the note's own id. Re-basing that baseline onto the pulled content instead put
  the flush on its `current == base` fast-forward arm and destroyed the peer's
  edit with no copy anywhere in the vault (#89, fixed 2026-08-11); the desktop
  clean case still adopts immediately, focused or not, and a draft that disk
  already equals is rebased on purpose (the `Converged` case below).
  Rust live cycles advance their edit epoch only when a completion event
  arrives (synchronously, after that completion snapshots the previous epoch),
  never from an in-cycle start or connect signal: such signals reach the
  webview asynchronously, so an edit racing their dispatch could be captured
  as pre-cycle and adopted over. The epoch is therefore never meaningfully
  newer than the next cycle's true start — edits between live cycles, and all
  edits made while offline, are over-protected (the draft wins and is pushed)
  rather than ever under-protected. Live and JS-driven epochs are tracked
  separately and snapshotted when each completion arrives. Completion handlers
  are serialized, and each completion flushes a pending or in-flight save
  before the desktop adapter reads disk and returns the engine disposition;
  a parked save can therefore finish its guarded disk adoption before the
  completion chooses whether to adopt or rebase. Once an adopt is
  deferred for marked text, composition end re-reads current disk content through
  `reconcileOpenNote` and applies it silently if the same note is still open
  and it differs from the saved baseline; content already matching the editor
  is still applied as a zero-diff baseline advance. → DesktopEditor.svelte
  `reportChange` and `takeOutsideChange`, view.ts `showOutsideEdit`, noteSession
  `editorEdited`, createExternalChangeCoordinator `reconcileOpenNote` (guarded by
  the engine-verdict, stale-snapshot, and defer-on-composition cases in
  createExternalChangeCoordinator.test.ts)

- *(desktop)* A dirty draft against a remote change is never replaced. `KeepDraft` leaves the live buffer untouched and the editor host keeps its own baseline, which the verdict's `base` equals for divergence and peer deletion: both retain the pre-pull baseline, so the host's next save merges, parks or recreates. For convergence `base` is the draft, which disk already holds, and the host's next save records it as saved. Assigning a divergent peer's bytes as the baseline would fast-forward over its contribution. → crates/futo-notes-sync/src/open_note.rs, src/features/sync/createExternalChangeCoordinator.ts, crates/futo-notes-ffi/tests/open_note_flush.rs
- *(desktop)* A peer deletion closes a clean open note and gives deletion feedback; an unsaved local draft stays open with deletion/draft-kept feedback, from the save that recreates it or, when that save fails or is held, from the verdict. Classification distinguishes an existing empty file from a missing file, so deletion never becomes an empty-content adoption whose next edit resurrects the note. → src/features/sync/createExternalChangeCoordinator.ts, src/features/editor/desktop/attachedNote.ts `Landed.recreated`, tests/cross-platform-sync.mjs
- *(desktop)* The engine classifier's complete vocabulary is `Leave`, `Adopt`, `DeferAdopt`, `FollowRename`, `KeepDraft` (peer-deleted, diverged or converged) and `Close`. A reported rename outranks other facts. The adapter gathers disk and classifies in one Tauri round trip, then applies the verdict only after identity, edit-version, draft and title revalidation. Sync completion and watcher events use that same executor. → crates/futo-notes-sync/src/open_note.rs, src/features/sync/createExternalChangeCoordinator.ts
- *(desktop)* Marked text defers adoption until composition ends; focus does not, because the editor adopts in place, keeping the caret with its text and Undo. The deferred operation re-reads current disk rather than replaying an old snapshot. The baseline the host's save works against is its own, which a kept draft's verdict leaves as it was; the adapter never synthesizes another baseline or writes the draft unconditionally. → src/features/sync/createExternalChangeCoordinator.ts, crates/futo-notes-ffi/tests/open_note_flush.rs
- *(desktop)* Background list/tab projection cannot overrule the open-note verdict: completion pruning skips the id the session remains bound to, so a disappearance between classification and probing cannot prune a kept draft's tab. → src/features/sync/reconcileSyncCompletion.ts, src/features/sync/syncManager.test.ts

- A pull that **relocates the open note** (a peer's rename, a collision
  placement, a park) moves the editor's attachment in the same vault-guard
  hold as the file move, so no save can recreate the old id; the host reports
  the move, the session follows it, and sync completion classifies the note
  where it went. A peer's rename moves the note and its mapping first, then
  fast-forwards it to the pulled bytes: a save that lands in between makes the
  write refuse, for the next cycle's ordinary conflict handling, and a failure
  at either step leaves one mapped name holding the note, so no device gets it
  as a new note and none deletes it. A case-only rename on a volume that folds
  case renames the one file in place. A peer's rename that arrives as a delete
  and a create (sync pairs them by content) moves no file here: at the end of
  the cycle, before the page hears of it, the attachment follows each reported
  rename whose old file is gone, as for a rename the file watcher saw; a rename
  whose new name the same cycle deleted is not followed.
  _(desktop)_ → futo-notes-store `follow_sync_renames`; apps/tauri
  `NoteStoreState::follow_sync_renames`; futo-notes-core `note_moved`; futo-notes-sync `behavior_tests/note_moves.rs`;
  futo-notes-store `tests/editor_session/relocation.rs`;
  reconcileSyncCompletion.ts
  > **Gap:** a crash between a pulled rename's file move and the sync checkpoint leaves
  > the note at its new name unmapped, so the next push uploads it as a new object and
  > deletes the old one. Closing it would need push rename detection to pair a missing
  > mapped note with the one unmapped file of identical content, whatever its name; left
  > open on purpose (2026-11-04).
