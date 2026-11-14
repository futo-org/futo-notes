## Saving & rename

Desktop uses the Milkdown save path below. Native mobile source ownership, checkpoints,
merge adoption and leave handling follow [portable recovery](portable-core/recovery.md)
and [native exits](editor-exits.md).

- *(desktop)* Every edit the user makes reaches the host once the document settles (~200 ms
  debounce), and clearing the whole note is one of them: select-all-delete is
  reported as a change to the empty document, however soon after the note was
  opened. The editor knows an edit happened because it saw the TRANSACTION,
  never by comparing the settled document against a remembered one — a cleared
  note is byte-identical to the pristine empty document every editor starts
  from, so any such comparison reads the user's deletion as "nothing changed"
  and drops it. → src/features/editor/milkdown/documentChanges.ts,
  src/features/editor/milkdown/serializationLoop.ts `reportDocumentChange`,
  src/features/editor/milkdown/MilkdownEditor.test.ts,
  tests/note-never-emptied.spec.ts
- *(desktop)* A note that has content is never written back empty on the strength of an
  editor's word alone (CRITICAL). An empty document is only saved as a deletion
  when the editor REPORTED the emptying as a change; an editor that went blank
  on its own — a parse that threw, a replaced component — has notified nobody,
  and its `''` is refused. A rename typed alongside such a blank editor still
  lands, carrying the body the session last knew. → src/features/notes/
  noteSessionChanges.ts `editorLostTheNote`, createNotePersistence.ts,
  src/features/notes/noteSession.test.ts, tests/note-never-emptied.spec.ts
- *(desktop)* Opening a note never adopts an EMPTY editor serialization as the save
  baseline for a note that read non-empty from disk. The editor's own
  serialization is otherwise the baseline, because Milkdown normalizes syntax
  on parse — but an empty one is a failed load, not a normalization, and
  adopting it declares the note empty for every later save. → src/features/
  notes/createNoteLoader.ts
- A failed desktop disk save blocks switching notes, going Home, and closing the
  outgoing tab. The outgoing draft stays open and dirty, its tab is restored,
  and a visible save-failure message permits retry. A converged or durably
  parked draft permits navigation. While the vault is locked (settings.md) no
  save can succeed, so a failed save does not hold the user: leaving the note
  discards its unsaved text. _(desktop)_ → `noteSaveQueue.ts`,
  `createNotePersistence.ts`, `createTabNoteTransition.ts`,
  `noteSession.svelte.ts` `flushBeforeLeaving`
- *(desktop)* Editor rename and move send the body, saved baseline, and destination through
  one Rust workflow. A peer-changed source remains untouched; the local draft
  becomes a conflict copy at the requested destination, and the editor follows
  the engine's final id and title. Collision handling and backlink changes stay
  under the same vault guard. → `LocalNoteStore::save_draft_as`, `move_draft`

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
- *(desktop)* Same-id body saves use `flush_draft(id, base, content)` under the store gate and vault mutation guard: unchanged disk writes the draft, equal disk converges without rewriting, a missing note recreates at the original id, and divergence parks the draft without overwriting the peer. Recreation uses no-replace installation; a concurrently reappearing note parks instead. Conflict naming is collision-safe and parking is idempotent. A clean session never creates a conflict copy or resurrects an abandoned note. Rename persists title and body through one store workflow. → crates/futo-notes-store/src/flush.rs, src/features/notes/createNotePersistence.ts
- *(desktop)* A parked save applies the returned conflict-copy mutation, then re-reads and adopts the diverged original through `reconcileOpenNote`; the copy appears in the list without a toast. The saved baseline advances only to durable authoritative bytes. → src/features/notes/noteSession.svelte.ts, src/features/sync/createExternalChangeCoordinator.ts
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

- The shared attached editor follows explicit committed remote rename pairs through the local note
  engine's external-change projection, including its authoritative collision-resolved destination.
  Retargeting preserves source, selection, composition, revision and Undo history; the original saved
  baseline remains available to merge or park against current disk at the final id on checkpoint.
  Failed saves retain the final attachment and draft for retry. A replay for an already-vacated
  attachment cannot redirect its current identity, and updated/deleted ids alone never imply a rename.
  Destination read/attachment failure leaves drafts attached for retry. Portable page requests retain
  their token/sequence order and history; automatic portable saves preserve both versions by parking
  on divergence. → crates/futo-notes-store/src/notes.rs,
  crates/futo-notes-store/src/editor_session/identity.rs
