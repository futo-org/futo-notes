## Saving & rename

On desktop the editor host saves the attached note (lines tagged *(desktop)*). Native mobile
source ownership, checkpoints, merge adoption and leave handling follow
[portable recovery](portable-core/recovery.md) and [native exits](editor-exits.md).

- Every edit the user makes reaches the host, and clearing the whole note is one
  of them: select-all-delete is reported as a change to the empty document,
  however soon after the note was opened. → src/features/editor/desktop/applyViewChanges.ts,
  tests/note-never-emptied.spec.ts
- *(desktop)* A note that has content is never written back empty on the strength of an
  editor's word alone (CRITICAL). An empty document is only saved as a deletion
  when the user's edits emptied it; an editor that went blank on its own — a
  parse that threw, a replaced component — writes nothing. The desktop page
  never hands the host a body: the host writes only its own engine's source,
  which opens as the note's disk bytes and changes only by the edits the page
  sent, and a page holding no note saves nothing. →
  crates/futo-notes-store/src/editor_session/checkpoint.rs,
  src/features/editor/desktop/DesktopEditor.svelte `save`,
  src/features/notes/noteSessionSaveSafety.test.ts
- *(desktop)* Opening a note never adopts an EMPTY editor serialization as the save
  baseline for a note with content on disk. On desktop the baseline is the
  engine's source, which the host read from the file itself (its line endings
  included), so it is empty only for an empty note. → src/features/notes/
  createNoteLoader.ts `load`
- A desktop note switch commits only once the editor holds the incoming note:
  until then the session, its title and the tab stay on the outgoing note. The
  host opens the incoming note first and only then saves and releases the
  outgoing one, so an open or a save that fails leaves the outgoing note
  attached, all three on it, and fails the switch. _(desktop)_ →
  createNoteLoader.ts `load`, DesktopEditor.svelte `openNote`, editor_host.rs
  `switch`, noteSessionLoad.test.ts, editor_host/tests.rs
- On desktop the editor's attachment is the one owner of which note is open.
  Every save that moves it — a rename's final id, or the copy any save parks
  (the host's timer, a checkpoint, the close, a rename) — and every move a store
  workflow makes (a move, a folder rename, a sync relocation, which move the
  attachment with the file, or a watcher-reported rename it follows) is reported
  once, and the session and its tab follow
  that report. Each report is stamped in the host's order and applied once, in
  that order, though an event and a reply can arrive in either order.
  _(desktop)_ → attachedNote.ts `arrive`, DesktopEditor.svelte `onnote`,
  noteSession.svelte.ts `followEditorNote`, attachedNote.test.ts
- The open note follows a rename made outside the app (Finder): as the file
  watcher reports it, the store moves the editor's attachment to the new id,
  under its gate, while the attachment is on the old one and the old file is
  gone, so its next save writes the new id and never recreates the old one. An
  old file back on disk because the attachment's own saves recreated it before
  the report came is adopted when it still holds what the attachment last wrote
  there and the renamed file holds what the old one held before: it is removed,
  and the next save fast-forwards the renamed file. Anything else stops the
  follow: a write by someone else, or no renamed file at all. A chain
  of renames follows in event order, even once its middle names are gone; one
  that ends on a missing note is then closed or kept as for a peer delete; a
  case-only rename is the same file. _(desktop)_ →
  `editor_session::follow_external_rename`, futo-notes-store
  `tests/editor_session/outside_rename.rs`, editor_host/tests.rs
- On desktop the host is the body's one writer. The session saves only the
  title's rename; its flush (leaving, renaming, syncing, quitting) renames when
  the title changed and otherwise asks the host to write now. Its saved baseline
  is the attachment's: the source the note opened with, then each save that
  landed at the draft's current revision, converged ones included. _(desktop)_ →
  attachedNote.ts `savedSource`, noteSession.svelte.ts `savedContent`,
  noteSessionLoad.test.ts, noteSessionSaveSafety.test.ts
- A failed desktop disk save blocks switching notes, going Home, and closing the
  outgoing tab. The outgoing draft stays open and dirty, its tab is restored,
  and a visible save-failure message permits retry. A converged or durably
  parked draft permits navigation. While the vault is locked (settings.md) no
  save can succeed, so a failed save does not hold the user: leaving the note
  discards its unsaved text (the host releases it without writing). A failed
  background save (the host's timer, a blur) shows the same message once per
  streak of failures, until a save lands. _(desktop)_ → `noteSaveQueue.ts`,
  `createNotePersistence.ts`, `createTabNoteTransition.ts`,
  `noteSession.svelte.ts` `flushBeforeLeaving`, DesktopEditor.svelte
  `saveFailed`
- *(desktop)* Editor rename and move send the body, saved baseline, and destination through
  one Rust workflow. A peer-changed source remains untouched; the local draft
  becomes a conflict copy at the requested destination, and the editor follows
  the engine's final id and title. Collision handling and backlink changes stay
  under the same vault guard; never a separately committed flush followed by a
  move. On desktop the page sends the typed title and the host's
  `editor_rename` names the destination in the folder it holds the note in when
  it runs, runs that workflow on the attached draft and moves the attachment
  with it, to the final id or to the copy it parks. →
  `LocalNoteStore::save_draft_as`, `move_draft`,
  `StoreEditorSession::rename_title`, DesktopEditor.svelte `rename`

- *(mobile)* A renderer that becomes blank without an accepted user edit cannot empty a note: the Rust attachment remains the source of document bytes and saves, including while a title rename runs. Clearing a note through accepted input saves the intended empty source. → crates/futo-notes-store/src/editor_session/, apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Saving.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineStorage.kt
- *(mobile)* Body edits stay in the Rust attachment and save 500 ms after the last edit, or at most 2 s after the first unsaved edit. A rename retargets that attachment, so a later save uses its current identity rather than recreating the old name. → crates/futo-notes-store/src/editor_session/{save,identity}.rs
- *(mobile)* A failed save leaves the exact draft and attachment dirty and retryable, with visible save-failure feedback; a durable write advances the engine's baseline. A checkpoint may merge an independent outside edit or park an ambiguous draft and follow the returned conflict identity. Native views apply the returned source, selection, history and complete mutation. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Saving.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineStorage.kt
- *(mobile)* Title edits debounce into a rename; iOS also offers a Rename dialog. Leaving settles a valid pending title immediately. A blank, illegal, duplicate or unchanged title leaves the body save independent; only an attempted rename that fails is a save failure. → apps/ios/Sources/Editor/TextFirst/{TextFirstNoteScreen,TextFirstTitle,TextFirstLeaves}.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt
- *(mobile)* Rename and move preserve the live attachment's unsaved input and follow the store's final identity and backlink changes. Destructive actions settle admitted input and pending title work first; a failed required save keeps the draft available. → apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt, crates/futo-notes-store/src/editor_session/identity.rs
- Leaving the editor flushes a pending save only if the content changed. The
  engine then decides whether the note is written, recreated, or parked.
- A dirty draft whose original parent folder disappeared never recreates a folder renamed or removed outside the app, including a folder moved between the save decision and installation. Native iOS checkpoints (autosave, background and Back) preserve the draft as a collision-safe `<title> (recovered)` note at the vault root, project it into the list, and follow that copy for further edits; the save banner shows the copy's id. If root recovery also fails, the draft remains pending with the save-failure message. Legacy draft flushes and same-folder title renames refuse the missing parent and remain pending. Filesystem aliases count as the same parent. A peer-deleted note whose parent still exists retains the ordinary edit-wins recreation rule; an explicit move to a different destination folder may create that requested folder. → crates/futo-notes-store/src/editor_session/checkpoint.rs, `flush.rs`, `commit.rs`, `editor_draft.rs`; `a_native_draft_survives_a_vanished_parent_at_a_collision_safe_root_id`, `a_native_close_recovers_when_the_parent_vanishes_inside_the_write_window`, `a_draft_does_not_recreate_an_externally_renamed_folder`, `a_folder_removed_inside_the_draft_install_window_stays_removed`, the `does_not_resurrect_a_moved_parent` regressions and `an_explicit_draft_move_can_create_its_requested_destination_parent`
- If a same-folder retitle already staged the note when its parent disappears, its failed rename or later crash recovery preserves the staged body as a collision-safe `<title> (recovered)` note at the vault root, never recreating the vanished folder or overwriting an existing root note. Recovery recognizes an already-installed copy, removes the staging artifact only after the body is durable, and preserves the final identity for sync when finishing a staged transaction. → crates/futo-notes-store/src/rename_journal/{moves,recovery}.rs; `a_retitle_whose_parent_moves_after_staging_recovers_visibly_without_recreating_it`, `recovery_of_a_retitle_with_a_missing_parent_keeps_one_visible_root_copy`
- *(mobile)* A confirmed local delete is the final editor mutation for that attachment. The store marks it terminal only after deletion commits; later input and checkpoints refuse rather than recreating the deleted note. A failed delete retains the attachment and draft. Native action coordination drains title and move work and checkpoints before deletion; presenting the iOS confirmation cover alone never retires the editor. → crates/futo-notes-store/src/notes.rs, apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt
- *(mobile)* Backgrounding requests a best-effort checkpoint at the first leave-foreground signal, including edits inside the autosave window. Failed saves remain owned and retryable; immediate process death can still precede persistence. iOS keeps background time for the attempt and retries retained leaves; Android requests the checkpoint on `ON_PAUSE`. → apps/ios/Sources/Editor/TextFirst/{TextFirstNoteScreen,TextFirstLeaves}.swift, apps/ios/Sources/Notes/Editor/EditorBackgroundTask.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt
- *(desktop)* Every editor host save (its timer and checkpoints) runs the store's
  save decision under the store gate and vault mutation guard: unchanged disk
  writes the draft, equal disk converges without rewriting, a missing note
  recreates at the original id, and a note changed outside merges three ways:
  the merge is written and offered to the page to adopt, and only overlapping
  edits park the draft without overwriting the peer. Recreation uses no-replace installation; a
  concurrently reappearing note parks instead. Conflict naming is
  collision-safe and parking is idempotent. A clean session never creates a
  conflict copy or resurrects an abandoned note. A parked disposition adds the
  conflict copy's returned mutation to the note projection and retargets the
  host's attachment to the copy; the editor follows the copy with the parked
  draft as its baseline, the original keeps the peer's bytes, and the copy
  appears in the list with no toast. → crates/futo-notes-store/src/flush.rs,
  `editor_session/checkpoint.rs` through `attachedNote.ts` and
  `noteSession.svelte.ts` `followEditorNote`,
  `noteSessionSaveSafety.test.ts`
- *(mobile)* The Rust session owns dirty state and the saved baseline; native screens do not publish a second whole-note snapshot register. Ownership tokens retire work on reset, and native leave owners keep failed attachments until retry or explicit discard. → apps/ios/Sources/Editor/TextFirst/TextFirstLeaves.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstController.kt, [native exits](editor-exits.md)
- An empty title shows the placeholder "Untitled"; the title field strips
  newlines. Leaving with an empty title keeps the note's current name: the body
  still saves and Back leaves normally.
- A refused title (empty, illegal, or a duplicate) is never a save failure; only
  a rename the store attempted and failed keeps the editor open with the
  "Couldn't save note" banner. → apps/android/app/src/main/java/com/futo/notes/ui/EditorTitleCommit.kt
  `commitEditorTitleSnapshot`
- A title that differs from the saved title only by leading or trailing
  whitespace leaves the session clean and skips the write. Only the saved-title
  comparison is normalized; the visible editor title keeps its whitespace.
- A duplicate title blocks the rename and shows the inline warning text
  "A note with this name already exists". Duplicates are judged as the store
  judges collisions — full Unicode case-folding and normalization-insensitively — so `Test`
  beside `test` warns rather than being saved as `Test-2`. The body still saves,
  under the note's current name (`Untitled` for a note never saved), and the
  field keeps the typed title until it is changed to a free one.
- The editor chrome shows **no word count** (or any other document
  statistic) — just the title and the document (spec decision 2026-06-10;
  Android native previously rendered an "N words" line under the title, no
  other platform ever did). → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditorScreen.kt
- On desktop Tauri the same contract holds via the shared shell: the title is a
  textarea above the tag bar; edits debounce into a file rename and rewrite
  backlinks (see "Wikilinks — navigation & integrity"). → src/features/notes/createNoteTitleController.svelte.ts
  - Title-only edits use an aggressive ~10 s debounce (body edits keep ~500 ms)
    so a rename round-trip never fires mid-typing and clobbers in-flight
    keystrokes.
  - That debounce is a **backstop, not the commit path**: **the title field
    losing focus commits the pending rename**, wherever focus goes — the body,
    another note, or inert chrome — so the list picks up the new name when the
    user is done naming rather than only as a side effect of the next body edit.
  - Enter commits too (it moves focus to the body).
  - A title left unchanged writes nothing.
  - The commit is **deferred until the pointer gesture that blurred the field is
    over**. `blur` fires on pointer-DOWN, and a rename re-sorts the list (the
    note jumps to the top on mtime): commit during the press and the row under
    the cursor changes before the click is delivered, so a click aimed at
    another note opens the wrong one — and the click, whose press and release
    now hit different rows, reaches no row at all.
  - A drag holds the commit past the drop, until `dragend`. The drop handler
    acts on the note id captured at `dragstart`, so a rename landing mid-drag
    would leave it moving a file that no longer exists and the move would be
    lost. A gesture that ends without a click or a drag drains on a short
    fallback instead.

  → `noteSession.svelte.ts` `debouncedSave`,
  `createNoteTitleController.svelte.ts` `handleBlur`,
  `$shared/dom/pointerGesture.ts` `runWhenPointerIdle`;
  tests/p2-regressions.spec.ts, src/shared/dom/pointerGesture.test.ts
- The shared attached editor follows a pulled rename. A file move sync makes (a
  peer's rename, a collision placement, a park) moves the attachment in the same vault-guard hold, so
  no save can recreate the old id. A peer's rename that arrived as a delete and a create moves no
  file: the local note engine follows it after the cycle once the old file is gone (or holds only the
  editor's own recreation, which it removes), but not when the same cycle deleted the new name — the draft stays and its next save recreates the old
  name. Retargeting preserves source, selection, composition, revision and Undo history; the original saved
  baseline remains available to merge or park against current disk at the final id on checkpoint.
  Failed saves retain the final attachment and draft for retry. A replay for an already-vacated
  attachment cannot redirect its current identity, and updated/deleted ids alone never imply a rename.
  A destination another editor holds leaves the draft on the old name. Portable page requests retain
  their token/sequence order and history; automatic portable saves merge, or park on overlap,
  preserving both versions. → futo-notes-core `note_moved`; crates/futo-notes-store/src/notes.rs
  `follow_sync_renames`, crates/futo-notes-store/src/editor_session/identity.rs
