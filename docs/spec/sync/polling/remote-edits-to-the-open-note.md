### Remote edits to the open note

Native mobile consumes the attached-session [saving and outside-writer contract](../../editor/portable-core/recovery.md). Desktop retains its Milkdown classifier and save workflow below.

- *(mobile)* A sync cycle projects its affected ids and explicit rename pairs into the local store before notifying views. The Rust attachment follows the authoritative identity; the native renderer requests a checkpoint and drains returned coordinated changes rather than replacing its own buffer from a JavaScript snapshot. → crates/futo-notes-store/src/editor_session/identity.rs, apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt
- *(mobile)* A clean native attachment adopts an existing outside source on checkpoint. An unsaved local contribution is never overwritten: independent changes merge, while ambiguous overlap parks the draft and preserves the outside version. The engine owns the baseline, selection and history rebasing; failed persistence keeps the attachment and exact draft retryable. Consecutive outside edits follow the same path. → [portable recovery](../../editor/portable-core/recovery.md), apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Saving.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineStorage.kt
- *(mobile)* Adoption preserves the caret/selection and the reader's scroll position while applying the engine's changed window. A peer deletion closes only the visible clean note, with deletion feedback; a dirty note remains available and its edits survive through the session's edit-wins checkpoint. A covered editor never pops the screen above it. → apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt, [portable recovery](../../editor/portable-core/recovery.md)

- *(desktop)* Adoption works for **every consecutive** remote edit, not just the
  first. The adopt's own programmatic `setEditorContent` echoes back through
  the editor's rAF-coalesced `onchange` one frame later — after the
  synchronous `suppressSaveOnChange` window has closed — and used to count as
  a user edit (`editVersion++`), which made `handleSyncComplete`'s
  edited-during-sync gate silently skip every subsequent adopt until the note
  was reopened (observed 2026-06-04: iPhone edit #1 appeared in the open mac
  editor, edit #2 never did). Echo deliveries (content identical to both the
  session and saved content) are now dropped before the edit bookkeeping, and
  the adopt gate additionally checks `hasOpenDraftChanges()` (a synchronous
  live-doc read) so a keystroke whose rAF delivery is still in flight can
  never be clobbered by the initial adopt decision. When a draft is protected
  because it is dirty, was edited during the running cycle, or the editor is
  focused, sync completion leaves BOTH the editor and its saved-content baseline
  untouched and defers the adopt to the next blur. Keeping the pre-pull baseline
  is what makes the next ordinary `flush_draft` a three-way decision the engine
  parks: the draft becomes a conflict copy and the peer's pulled bytes stay at
  the note's own id. Re-basing that baseline onto the pulled content instead put
  the flush on its `current == base` fast-forward arm and destroyed the peer's
  edit with no copy anywhere in the vault (#89, fixed 2026-08-11); the desktop
  clean-and-unfocused case still adopts immediately, and a draft that disk
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
  completion chooses whether to adopt or rebase. Once a focused-editor
  adopt is deferred, blur re-reads current disk content through
  `reconcileOpenNote` and applies it silently if the same note is still open
  and it differs from the saved baseline; content already matching the editor
  is still applied as a zero-diff baseline advance. → noteSession
  `isEditorChangeEcho`, createExternalChangeCoordinator
  `reconcileOpenNote` (guarded by the engine-verdict, stale-snapshot, and
  defer-on-blur cases in createExternalChangeCoordinator.test.ts)


- *(desktop)* A dirty draft against a remote change is never replaced. `KeepDraft` leaves the live buffer untouched and assigns the engine's `base` verbatim: divergence and peer deletion retain the pre-pull baseline, so the next `flush_draft` parks or recreates; convergence alone advances the baseline onto matching disk bytes. Assigning a divergent peer's bytes as the baseline would fast-forward over its contribution. → crates/futo-notes-sync/src/open_note.rs, src/features/sync/createExternalChangeCoordinator.ts, crates/futo-notes-ffi/tests/open_note_flush.rs
- *(desktop)* A peer deletion closes a clean open note and gives deletion feedback; an unsaved local draft stays open with deletion/draft-kept feedback. Classification distinguishes an existing empty file from a missing file, so deletion never becomes an empty-content adoption whose next edit resurrects the note. → src/features/sync/createExternalChangeCoordinator.ts, tests/cross-platform-sync.mjs
- *(desktop)* The engine classifier's complete vocabulary is `Leave`, `Adopt`, `DeferAdopt`, `FollowRename`, `KeepDraft` (peer-deleted, diverged or converged) and `Close`. A reported rename outranks other facts. The adapter gathers disk and classifies in one Tauri round trip, then applies the verdict only after identity, edit-version, draft and title revalidation. Sync completion and watcher events use that same executor. → crates/futo-notes-sync/src/open_note.rs, src/features/sync/createExternalChangeCoordinator.ts
- *(desktop)* A focused editor defers adoption until blur. The deferred operation re-reads current disk rather than replaying an old snapshot. `KeepDraft.base` is both the saved-content baseline and the expected-previous passed to `flush_draft`; the adapter never synthesizes another baseline or writes the draft unconditionally. → src/features/sync/createExternalChangeCoordinator.ts, crates/futo-notes-ffi/tests/open_note_flush.rs
- *(desktop)* Background list/tab projection cannot overrule the open-note verdict: completion pruning skips the id the session remains bound to, so a disappearance between classification and probing cannot prune a kept draft's tab. → src/features/sync/reconcileSyncCompletion.ts, src/features/sync/syncManager.test.ts

> **Gap:** *(desktop WYSIWYG)* External adoption replaces the whole ProseMirror document rather than applying a minimal diff. Caret and scroll preservation depend on ProseMirror position mapping, and replacement is undoable. The earlier CodeMirror device result does not establish current Milkdown behavior. → src/features/editor/milkdown/documentLoad.ts `applyExternal`, src/editor-embed/createFutoEditorApi.ts `applyExternalContent`
