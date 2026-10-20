### Remote edits to the open note

- A remote edit to the **currently-open note** is adopted into the open editor
  when the local draft is clean (`content == savedContent`); a dirty draft
  still wins and is never overwritten _(iOS/Android)_. Without this, the open
  editor kept showing a stale base and — worse — SAVED IT BACK on exit,
  silently clobbering the remote edit (observed 2026-06-04). Both native shells
  render the engine disposition from the completed cycle's per-id report. →
  iOS `OpenNoteReconciler`; Android `EditorSession.reconcileOpenNote` +
  `NoteEditorScreen.kt`
- The desktop adopt works for **every consecutive** remote edit, not just the
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

- The native unfocused clean-adopt **preserves the caret/selection and scroll**:
  the shells push remote content through the embed's `applyExternalContent`
  (bridge v2) rather than through the host `setContent` that also clears undo.
  Works for consecutive remote edits. Verified cross-device (simulator ↔
  emulator) 2026-06-09 on the CodeMirror editor: with the caret parked
  mid-document, a peer edit appeared in the open editor and the selection/caret
  held on both platforms.

  > **Gap:** the WYSIWYG editor does NOT apply an adopt as a minimal diff. Both
  > `applyExternalContent` and `setContent` go through one whole-document
  > `replaceAll`, so the caret and scroll are only whatever ProseMirror's
  > position mapping happens to preserve across a full replacement, and the
  > replacement is itself undoable (see the undo Gaps in
  > [editor.md](../../editor.md) "Interactive elements"). The CodeMirror editor
  > diffed and suppressed history (`editorContentSync.ts`, deleted with it).
  > Re-verify on device before treating the 2026-06-09 result as current. →
  > src/features/editor/milkdown/documentLoad.ts `applyExternal`,
  > src/editor-embed/createFutoEditorApi.ts `applyExternalContent`

  Neither shell invokes that bridge
  while the editor is focused: each remembers `DeferAdopt`, then waits for its mailbox to be current and
  classifies current disk content on blur. The blur edge every host settles on
  is ONE reported fact — the embed's `focus` bridge message, from the editor's
  own `hasFocus()` — and it means "the editor holds the caret", not merely
  "some node inside the editor is still `document.activeElement`". The lenient
  reading was iOS-only from the start (WKWebView reports a blurred document
  while its contenteditable really is focused); on Android that same shape IS
  the blur — dismissing the IME with Back, or tapping the native inline title,
  blurs the page while `activeElement` lags behind — so reporting it as focus
  meant the shell never saw a blur edge and the deferral was stranded
  indefinitely on superseded peer content (device-verified on
  emulator 2026-08-10). A deferral therefore always has an edge to settle on.
  → packages/editor bridge v2; milkdown/hostHandleView.ts `hasFocus` (guarded by
  tests/editor-focus-signal.spec.ts); iOS `EditorWebView` /
  `OpenNoteReconciler`; Android
  `EditorSession.settleDeferredAdoption` / `NoteEditorScreen.kt`
- A **dirty draft against a real remote change** is never replaced. Each
  executor renders the engine's `KeepDraft`: it cancels/drains the pending
  debounce, leaves the live buffer untouched, assigns the verdict's `base`
  verbatim as its saved baseline, and resumes persistence through the ordinary
  `flush_draft` workflow rather than a raw write. For `Diverged` that baseline
  is the PRE-pull one, which is what makes the following flush park the draft
  under the engine's dated conflict name and leave the peer's bytes on disk —
  rebasing it onto the pulled content instead made the flush a fast-forward
  that destroyed them (#89). `PeerDeleted` likewise keeps the pre-pull baseline
  and recreates the note at its original id, and `Converged` is the one arm
  that advances the baseline onto disk. →
  futo-notes-store `flush_draft`; desktop
  `createExternalChangeCoordinator`; iOS `OpenNoteReconciler`; Android
  `EditorSession.reconcileOpenNote` / `NoteEditorScreen.kt`
- A peer **deleting the currently-open note** closes the open session (route →
  home, deletion toast) instead of adopting its content; an unsaved local draft
  is kept open with a deletion/draft-kept toast rather than closed _(desktop,
  iOS, Android)_. On desktop the one Tauri classification command reads an
  `Option<String>` directly from the local note store, so an empty file is an
  adoptable `Some("")` while a missing file is `None`; this prevents the old
  adopt-`""` path from blanking the editor while leaving it bound to a deleted
  id, whose next keystroke re-created the file and undid the delete fleet-wide
  (F4). iOS atomically distinguishes an existing empty note from a
  missing note with `NoteStore.read_if_exists`, asks `classify_open_note`, and
  applies `Close` only to the visible editor (a buried wikilink editor must not
  pop the stack top). A hidden editor re-gathers on return, and the queued save
  is cancelled and drained before the read so a clean note cannot be
  resurrected after the close. Android uses the same atomic distinction,
  renders `Close` through `EditorSession` for a clean deletion, and renders
  `KeepDraft(PeerDeleted)` for a dirty deletion; its close latch plus clean
  baseline prevents `onDispose` from resurrecting the note.
  The dirty-keep path is edit-wins: the debounced save re-creates the note
  with the local edits, and a leave/background flush of the kept draft
  converges on the same home via the verb's Recreated arm.
  → desktop createExternalChangeCoordinator `reconcileOpenNote` (guarded by
  "peer delete of open note closes editor" in tests/cross-platform-sync.mjs +
  the executor cases in createExternalChangeCoordinator.test.ts); iOS
  `OpenNoteReconciler`; Android `NoteEditorScreen.kt`.
- **One engine verb decides what happens to the open note.** `Leave`, `Adopt`,
  `DeferAdopt`, `FollowRename`, `KeepDraft` (peer-deleted / diverged /
  converged) and `Close` are the whole vocabulary (CONTEXT.md: open-note
  disposition). A shell gathers the facts — its editor state plus one disk read
  — asks once, and applies the answer with a single re-validation that it is
  still on the same note; it never decides (ADR-0001, the pattern flush
  dispositions proved). Two invariants live in the classifier rather than in
  each shell: unsaved work is never replaced (persist-or-park at the open-note
  seam — a peer-deleted note with a draft stays open for the flush verb's
  Recreated arm), and the baseline a kept draft is handed is whichever one makes
  its next flush do the right thing. Those two `KeepDraft` baselines point in
  OPPOSITE directions, and reading them as one rebase rule is what destroyed a
  peer's edit (#89). `Converged` rebases onto disk: the draft is already there,
  so a stale baseline is all that is left to repair, and leaving it stale is what
  let a later save clobber a peer's merged-in edit (F2). `Diverged` keeps the
  baseline it had: `flush_draft` parks exactly when `current != base`, so the
  PRE-pull base is what parks the draft as a conflict copy and leaves the peer's
  bytes on disk — handing back the pulled content instead put the next flush on
  its `current == base` fast-forward arm and overwrote the peer with no copy
  anywhere in the vault. A kept draft is therefore never baselined on disk
  content it disagrees with. **A focused editor is never
  interrupted on any surface**: the verdict is `DeferAdopt` and the content is
  applied on the next blur, whether or not that host's adopt could have
  preserved the caret. Host adopt capability is deliberately NOT an input — one
  answer for all three shells, so a caret never moves under a typist.
  `KeepDraft.base` does two jobs with ONE value, because every shell assigns it
  to the same saved-content baseline it later hands `flush_draft` as the
  expected-previous: it decides whether the editor reads as dirty AND what the
  next write is conditioned on. A shell therefore never needs a second value and
  must not synthesise one — assign `base` to the baseline, pass that same
  baseline to the flush verb (desktop `updateNote({ base })`, iOS/Android
  `PendingDraft(base:)`), and let the returned disposition rebind the editor when
  it parks. A shell whose debounced save writes UNCONDITIONALLY instead destroys
  the peer's bytes whatever the verdict said, which is why the native autosave
  routes through the flush verb. Every surface keeps that baseline today: the
  verb, desktop's single executor (which renders the verb rather than holding a
  copy of the decision — its sync-completion and watcher paths both delegate to
  it), iOS `OpenNoteReconciler` (likewise a renderer of the verb), and Android —
  all of them hand `flush_draft`
  the pre-pull base, so all of them park (#89, closed 2026-08-11; the loss had
  been reproduced between two real desktop clients on 2026-08-10 and is now
  pinned by the cross-platform scenario "dirty draft survives a peer edit then
  settles").
  → futo-notes-sync `open_note.rs` (guarded by
  `every_reachable_fact_combination_has_one_verdict`,
  `a_dirty_draft_is_never_replaced`, `a_reported_rename_is_always_followed`,
  `a_converged_draft_rebases_onto_what_is_actually_on_disk`,
  `a_diverged_draft_keeps_the_baseline_that_makes_the_next_flush_park` and
  `no_reachable_fact_combination_can_discard_unsaved_work`), the
  verdict→flush composition guarded end to end on a real vault by futo-notes-ffi
  `tests/open_note_flush.rs`, projected by `e2ee_classify_open_note` (desktop)
  and `classify_open_note` (UniFFI).
  Desktop gathers disk and classifies in one Tauri round trip, then
  createExternalChangeCoordinator applies every verdict after one compound
  identity/edit-version/draft/title re-validation; sync completion and watcher
  events both delegate to that executor, so desktop holds no copy of the
  decision to keep in step — the baseline it hands the flush is the verdict's
  `base`, assigned verbatim (guarded by the executor cases in
  createExternalChangeCoordinator.test.ts, the editor-reconciliation matrix in
  syncManager.test.ts, and the cross-platform scenario "dirty draft survives a
  peer edit then settles"). iOS gathers disk with the atomic `read_if_exists`
  FFI verb, performs one post-read identity/visibility validation, follows a
  reported rename before delete handling, re-gathers a deferred adopt on blur,
  and likewise assigns the verdict's `base` verbatim before resuming its flush.
  → iOS `OpenNoteReconciler`.
  Android renders every arm through `EditorSession.reconcileOpenNote`, with one
  identity revalidation, deferred adoption owned until blur, and the verdict's
  `base` likewise assigned verbatim. → Android EditorSession.kt,
  NoteEditorScreen.kt
  **No background projection may overrule that verdict for the open note**:
  desktop completion's deleted-tab pruning skips the id the session is still
  bound to (a `close` has already unbound it), so a file that vanishes between
  the classification and the existence probe cannot prune the live tab and route
  home behind the engine's back. → reconcileSyncCompletion (guarded by "never
  prunes the tab of a note the engine left open" in
  src/features/sync/syncManager.test.ts)
