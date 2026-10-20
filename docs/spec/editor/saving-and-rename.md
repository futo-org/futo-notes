## Saving & rename

- Every edit the user makes reaches the host once the document settles (~200 ms
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
- A note that has content is never written back empty on the strength of an
  editor's word alone (CRITICAL). An empty document is only saved as a deletion
  when the editor REPORTED the emptying as a change; an editor that went blank
  on its own — a parse that threw, a replaced component — has notified nobody,
  and its `''` is refused. A rename typed alongside such a blank editor still
  lands, carrying the body the session last knew. → src/features/notes/
  noteSessionChanges.ts `editorLostTheNote`, createNotePersistence.ts,
  src/features/notes/noteSession.test.ts, tests/note-never-emptied.spec.ts
- Opening a note never adopts an EMPTY editor serialization as the save
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
- Editor rename and move send the body, saved baseline, and destination through
  one Rust workflow. A peer-changed source remains untouched; the local draft
  becomes a conflict copy at the requested destination, and the editor follows
  the engine's final id and title. Collision handling and backlink changes stay
  under the same vault guard. → `LocalNoteStore::save_draft_as`, `move_draft`

- Body edits autosave on a debounce (~400 ms). The save re-reads the current
  note id at fire time, so a save landing **after** a rename writes to the
  renamed note, not a stale id. → NoteEditorScreen.kt / NoteEditorView.swift
  `scheduleSave`
- Native saves return an explicit committed/failed outcome. A failed write does
  not advance the editor's saved snapshot, so the draft remains dirty and a
  visible message tells the user it is still pending. Rename and move stop
  before changing the note's identity when their required body flush fails;
  conflict adoption likewise waits until the local conflict copy is durable.
  A dirty native editor that leaves the screen retains its final draft registration
  until the asynchronous leave flush writes or parks it successfully. A later
  successful ordinary save clears only the exact retained revision it observed,
  so it cannot accidentally discard a newer retained edit. Identity mutations
  advance a store-owned draft generation before suspending: delete first commits
  every dirty editor snapshot and aborts visibly when that write fails, then
  discards the old identity's live and retained drafts only after the delete
  commits; rename/move retarget retained drafts to the authoritative final id.
  Failed identity mutations reopen a fresh generation. A queued or failed leave
  flush from the old generation therefore cannot resurrect a deleted note or
  create an old-id ghost after rename/move. Android Back commits a valid visible
  title immediately after the body rather than waiting for the rename debounce. The iOS move awaits the final posted editor document
  after destination selection, persists or parks it through the draft workflow,
  and moves the parked conflict identity when that is where the local draft was
  committed. _(iOS, Android)_ → `NotesStore.write`,
  NoteEditorScreen.kt / NoteEditorView.swift,
  NativeMutationOutcomeTest / NativeMutationOutcomeTests
- Android title edits debounce into a rename; iOS commits via the rename dialog.
  Both use the baseline-aware save-and-rename workflow after pending saves are
  cancelled/drained. Only an actual durable result advances the saved body
  snapshot; a no-op title never marks a dirty body saved.
  → NoteEditorScreen.kt / NoteEditorView.swift
- Leaving the editor flushes a pending save only if the content changed. The
  engine then decides whether the note is written, recreated, or parked.
- A confirmed local delete is the final editor mutation for that note. Android
  serializes body saves, title flush/rename, conflict adoption, the complete
  flush-and-move transaction (including its final id update), and delete through
  one editor session (see "Editor exits"). iOS cancellation chains own the
  actual committed move—not only presentation of its picker—and delete awaits
  the complete save/rename/adoption/move chain before removing the final id.
  Once closing starts, iOS blurs the WebView, quarantines late bridge changes,
  and never flushes that closing view on disappear. Its centered delete card is a
  transparent cover, and presenting that cover is explicitly excluded from the
  editor's navigation-disappear cleanup. A committed delete discards the
  quarantine; a failed delete restores and autosaves it, so the note is neither
  recreated after success nor stripped of a late edit after failure. An
  in-flight conflict flush, move, title debounce, or queued bridge callback
  therefore cannot recreate or rename a note after its delete commits. _(iOS,
  Android)_ → `EditorSession` (EditorSession.kt / EditorSession.swift),
  `EditorDraftCoordinator`, NoteEditorScreen.kt, NoteEditorView.swift,
  NativeMutationOutcomeTests
- Backgrounding the app makes a **best-effort** flush of the open editor's
  pending edit at the first leave-foreground signal, so an edit caught inside the
  autosave debounce is usually persisted before the OS jetsams the process. The
  flush is fire-and-forget, so an immediate process death can still beat the
  write — true on both native shells. → Android MainActivity `onPause` →
  `NotesStore.flushPendingEditor`; iOS FutoNotesApp scenePhase
  `.inactive`/`.background` → `NotesStore.flushPendingEditor`
- A native leave/background flush and the desktop editor's debounced body save
  go through the engine's ONE draft-saving verb (persist-or-park, ADR-0001):
  `flush_draft(id, base, content)` resolves every surprise itself under the
  store gate plus the process-wide vault mutation guard shared with sync, and
  returns one flush disposition plus the mutation to apply — **wrote** (the
  note still held `base`; content a live pull adopted since the editor's last read is never
  clobbered by a stale flush), **converged** (disk already equals the draft —
  explicit, no rewrite, no mtime bump; shells never read disk to compare),
  **recreated** (peer deleted; the edit wins at the ORIGINAL id — the same home
  the editor's resume autosave rewrites, so survive + jetsam converge with no
  duplicate copy; the install is no-replace on every filesystem — atomic where
  one offers the primitive, an exclusive create plus copy where none does (see
  app.md) — so a live-sync write that recreates the id outside the engine's
  serialization in the flush window is not clobbered — the draft is parked
  instead), or **parked** as a conflict
  copy (peer changed; both versions survive, the copy id reported). A dirty
  draft is never silently dropped; a clean editor never flushes, so a genuinely
  abandoned note is never resurrected. Conflict copies are named by the
  engine's one conflict-naming rule ("<title> (conflict YYYY-MM-DD)", counter
  suffix on a same-day collision), and parking is idempotent — a crash-window
  double-park mints ONE copy. On desktop, a parked disposition adds the
  conflict copy's returned mutation to the note projection, leaves the draft
  baseline uncommitted, then re-reads and adopts the diverged original from
  disk through `reconcileOpenNote`; the copy appears in the list with no toast.
  On desktop, only a same-id body save uses `flush_draft`; a rename persists
  the title and body through the store's single save workflow, never as a
  separately committed flush followed by a move. _(desktop, iOS, Android)_ →
  `futo_notes_store::LocalNoteStore::flush_draft` via FFI `flush_draft`;
  desktop `notes.svelte.ts updateNote` through
  `createNotePersistence`/`noteSession.svelte.ts`; native
  `NotesStore.flushDraft`/`flushAsync`; conflict naming
  `futo_notes_core::conflict_names`. Guarded by the flush_draft unit tests in
  crates/futo-notes-store/src/tests.rs (all four dispositions, converged/park
  boundary, recreate-vs-reappeared window, park idempotency, recreate-arm
  mutation positioning, store-vs-sync serialization), desktop
  `notes.contract.test.ts` / `createNotePersistence.test.ts` /
  `createExternalChangeCoordinator.test.ts`, the FFI note_contract test, and
  apps/ios/Tests/Notes/Editor/FlushDraftVerbTests.swift and Android's
  `EditorLifecycleFlushTest`. Earlier behavior verified on iOS 2026-07-13
  (sim); iOS verb wiring verified via `just test-ios-native` 2026-07-21 and
  Android verb/adoption wiring via `just test-android-native` 2026-07-23.
- A durable native autosave flush **always advances the open editor's saved
  baseline to the bytes that landed**. Rescheduling the debounce on the next
  keystroke may cancel the task, but it must never skip that post-flush record;
  only an editor identity that has already moved elsewhere may veto it. A
  parked disposition follows the returned copy and advances its baseline in
  the same step, so the next save cannot re-park against the original note.
  iOS makes this liveness-free decision in `settledFlush`; Android holds the
  flush-and-record span in `withContext(NonCancellable)`. _(iOS, Android)_ →
  NoteEditorView.swift / NotesStore.swift `settledFlush`, EditorSession.kt
  `NonCancellable`; guarded by `SettledFlushTests`,
  `EditorSessionTests.cancelledSaveStillResumes`, and Android
  `EditorSessionTest`.
- The open editor's unsaved-draft register is **derived** from the editor's live
  state (note id, buffer, saved content, loaded) rather than hand-synced, so it
  goes clean the instant a save completes or a remote is adopted (no stale draft
  clobbers the adopted content). It is owner-scoped so a screen leaving during a
  push/pop transition can't drop the incoming screen's draft. Android registers
  one derivation closure the flush pulls synchronously; iOS publishes the derived
  value both synchronously in the WebView change callback (so the register is
  current the instant before a background flush reads it) and reactively via
  `.onChange` for the clear-on-save / clear-on-adopt transitions — SwiftUI
  `@State` can't be pulled from an escaping closure the way Compose snapshot state
  can. _(iOS, Android)_ → NoteEditorScreen.kt / NoteEditorView.swift →
  `NotesStore.setDraftProvider`/`publishDraft` + `claimDraftOwnership`. Verified
  on iOS 2026-07-13 (sim: edit → immediate background before the debounce
  persisted; rename with a pending body edit preserved the edit under the new id
  with no ghost). NOTE: a simulator can't reproduce OS jetsam, so this validates
  the surviving-process flush path, not an actual jetsam-during-background kill.
- An empty title shows the placeholder "Untitled"; the title field strips
  newlines.
- A title that differs from the saved title only by leading or trailing
  whitespace leaves the session clean and skips the write. Only the saved-title
  comparison is normalized; the visible editor title keeps its whitespace.
- A duplicate title blocks the save and shows the inline warning text
  "A note with this name already exists".
- The editor chrome shows **no word count** (or any other document
  statistic) — just the title and the document (spec decision 2026-06-10;
  Android native previously rendered an "N words" line under the title, no
  other platform ever did). → NoteEditorScreen.kt
- On Tauri the same contract holds via the shared shell: the title is a
  textarea above the tag bar; edits debounce into a file rename and rewrite
  backlinks (see "Wikilinks — navigation & integrity"). Verified on Android
  Tauri 2026-06-09.
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
