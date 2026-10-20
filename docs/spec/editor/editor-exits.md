## Editor exits — every way an open note ends _(iOS/Android)_

While a note is open both native shells run asynchronous workflows against ONE
note identity — the debounced body save, the debounced title rename, live-sync
adoption of an on-disk change, plus a fourth per shell (iOS the folder move,
Android an image insertion) — and the user can leave at any moment: Back, the
system back gesture / leading-edge swipe, a resolved wikilink, Move, Delete.
Every exit is one case of a single verb that runs **admission → latch → cancel →
drain → commit → the exit's own effect**. The guarantee the ordering exists to
keep: no async completion may land against a stale note identity (a save holding
the pre-rename id recreates a ghost note; a rename landing after a delete
resurrects the file).

Each shell owns its own implementation, in its own idiom — Android one mutex
where taking the lock IS the drain, iOS per-workflow cancellation chains awaited
in a declared order. The engine owns what a save MEANS (persist-or-park,
ADR-0001) and is reached only through injected effects; the shells own only when
that work runs and in what order, because every step being ordered is a
host-runtime handle (a Compose coroutine, a Swift `Task`, a WebView round-trip, a
navigation that has to stay vetoable). This section is the shared statement of
that ordering — the two implementations are held together by it plus each shell's
ordering tests, not by shared code. → EditorSession.kt, EditorSession.swift,
EditorSessionTest.kt, EditorSessionTests.swift

- Every latch an exit sets lands **before the first suspension**: the destructive
  latch, the one-exit-at-a-time admission, and the interaction lock are all set
  in the same turn as the user's tap, so the exit verb is deliberately neither a
  `suspend fun` (Android — `rememberCoroutineScope` dispatches on the next frame)
  nor `async` (iOS). A keystroke, a second Back, or a queued save arriving after
  the tap is therefore already fenced. _(iOS/Android)_ → EditorSession.kt `end`,
  EditorSession.swift `end(_:effects:)`
- A destructive exit's cancels land **before** the drain: delete cancels the
  queued debounces synchronously (iOS all four workflows, Android inside the same
  pre-suspension step as the latch), so the drain only ever waits for work that
  was already in flight, and anything queued behind the latch touches nothing at
  all — Android's `runWork` returns null, an iOS scheduled workflow sees
  `isActive == false`. The debounced body save is the one exception, neutralised
  as the first step of the commit rather than at admission (cancel, then await
  it): a save already running has to finish and be projected before the exit
  awaits its current mailbox, or the next commit races the write it supersedes. _(iOS/Android)_
- While an existing note's disk read is pending, the visible placeholder has no note identity. It never seeds that note's mailbox. Starting a new open invalidates the previous clean snapshot; reconciliation waits for `documentLoaded` for the real note. Quick capture already owns the engine-created empty body and accepts edits immediately. _(native shells)_ → NoteEditorView.swift, NoteEditorScreen.kt, EditorMailbox.swift `prepareLoad`, EditorMailbox.kt `prepareLoad`
- Every document report carries its vault-relative note id and a page-monotonic generation. A shell routes reports into the named note's mailbox even after another view attaches. _(native shells)_ → packages/editor/src/bridge.ts, EditorMailbox.kt, EditorMailbox.swift
- A reportable user transaction advances the generation synchronously. The first transaction after a load or delivered change posts `edited`; subsequent transactions in that unreported run do not post another watermark. _(native shells)_ → milkdown/serializationLoop.ts `documentEdited`
- A mailbox is current when its newest change generation is at least its edited watermark. Current exits use those bytes without WebView interaction; a behind exit asks for one flush and waits up to 6 seconds. A token-tagged failure or deadline while still behind refuses a user exit that has not yet left, releases its latches, and permits retry. _(native shells)_ → EditorMailbox.kt `awaitCurrent`, EditorMailbox.swift `awaitCurrent`
- A renderer-death OS signal lets every exit proceed on the mailbox's latest bytes. A never-loaded, never-edited note leaves using the shell's disk copy with nothing to save. Silence alone never declares a renderer dead. _(native shells)_
- The body an exit commits is the newest tagged change held by its mailbox after the flush wait. A destructive exit still folds in newer quarantined changes before completing. _(native shells)_ → EditorSession.kt, EditorSession.swift
- A failed body flush or pending rename refuses a user exit that has not yet left, and releases every latch it set. A failed delete leaves the editor usable. _(native shells)_
- Android Back, the system back gesture, the top-bar back arrow, and a resolved wikilink tap leave the note before committing it. The next screen starts its transition without waiting for the editor flush or the disk write. _(Android)_ → EditorSession.kt `leaveThenCommit`, EditorSessionTest.kt
- Android Back waits before leaving only for an image insert whose picker has already returned. That insert needs the editor it was picked for. _(Android)_ → NoteEditorScreen.kt `awaitPendingWork`
- After Android Back has left, the commit runs on the store's scope, which outlives the screen. The order is mailbox, then body, then title. The commit cannot call the user back to the note. _(Android)_ → EditorSession.kt `drainAndCommit`, NotesStore.kt `launchEditorLeave`
- An Android Back commit that fails, or a title that cannot be renamed, shows a message after the note list is on screen. The unsaved body stays in the draft register, and the editor's leave flush retries it. _(Android)_ → NoteEditorScreen.kt `onFailed`, `leaveNote`
- Android runs the editor's leave flush, the untouched-capture delete, and the draft register release only after Back's commit settles. A second write of the same body against the same baseline cannot park a conflict copy. _(Android)_ → EditorSession.kt `whenExitSettles`
- Android reads a note's body on open only after every leave commit still in flight has landed. Reopening the note just left shows its committed text. _(Android)_ → NotesStore.kt `awaitEditorLeaves`
- A leaving Android editor never loads content into the shared WebView: a self-link relink after Back updates only the saved baseline. _(Android)_ → NoteEditorScreen.kt `settleRelink`
- A leaving Android editor holds its pane at its last height while the keyboard and format toolbar animate away. The WebView does not relayout the note during the exit. _(Android)_ → NoteEditorScreen.kt `leavingEditorHeight`
- Android Back is ignored once a delete or a peer's delete has latched the editor closed. That exit performs the leave itself. _(Android)_ → EditorSession.kt `end`
- iOS system Back and edge swipe commit after the pop. They wait once when behind and proceed on the mailbox's latest bytes even if the wait fails; a later delivered change is handed to retained persistence. The parent may re-adopt first: loading it flushes the child's outgoing edit with the child's identity before loading the parent. _(iOS)_ → NoteEditorView.swift `finishLeave`, EditorMailboxTests.swift, docs/qa/wikilink-pop-large-edited-note.md
- Streaming withholds content changes to protect against saving a prefix, but never withholds the synchronous `edited` signal. A flush settles an edited tail before reporting the complete document; a clean streamed flush echoes the host's full original bytes. A note switch reports an outgoing pending edit synchronously before replacing its identity. _(native shells)_ → milkdown/hostHandle.ts `flush`, `setContent`, milkdown/documentLoad.ts `finishProgressiveLoad`
- Blur, hidden visibility and pagehide flush the embedded editor immediately. Backgrounding explicitly waits for posted changes (2 seconds on Android, 6 seconds within iOS background time) and then flushes the draft register, including the mailbox's latest available bytes after a failed wait. A durable write advances the baseline before a later write. _(native shells)_ → BackgroundEditorFlush.swift, NotesStore.kt, EditorSession.kt
- Renaming, moving or following a parked identity awaits the outgoing mailbox, then calls `retarget(fromId, toId)`: the editor relabels its live document and reports it through `change` under the new id, preserving caret, scroll, undo history and any keystroke after the flush. The shell does not re-push its copy, and a retarget naming another note is ignored. Ordinary edits do not invalidate asynchronous image insertion or selection-link editing. _(native shells)_ → milkdown/hostHandle.ts `retarget`, EditorMailbox.kt `retarget`, EditorMailbox.swift `retarget`, NoteEditorView.swift `retargetNoteId`, NoteEditorScreen.kt `retargetNoteId`
- A late iOS departure draft is published and retained until a durable write or park succeeds; a failed late write remains eligible for background retry. Only the newest bound view for a shared note id receives a change; covered views do not acquire another stale-base draft. _(iOS)_ → NotesStore.swift `flushRetainedEditor`, EditorMailbox.swift `change`
- A native host releases unused clean mailbox bodies after detachment or document handoff. Pending flush waiters, active bindings and retained unreported drafts keep their entries until settled. _(native shells)_ → EditorMailbox.swift `prune`, EditorMailbox.kt `prune`
- Debug native apps load the query-gated editor test hooks for device harnesses, including document replacement. Release URLs do not enable those hooks. _(native shells)_ → EditorWebView.swift `loadEditor`, EditorWebView.kt, src/editor-embed/main.ts
- A rename or move invalidates an earlier clean snapshot for its target id. A self-link relink waits for `documentLoaded` under the new identity before offering a conditional replacement; an unanswered load never invents a generation. _(native shells)_ → EditorMailbox.swift `awaitLoaded`, EditorMailbox.kt `awaitLoaded`, NoteEditorView.swift `settleRelink`, NoteEditorScreen.kt `settleRelink`
- External updates and relinks are conditional on the exact note id and generation held by the editor, with no unreported edit. Refusal keeps the draft; acknowledgment advances the shell baseline. Relinks rebase and retry at most three times. _(native shells)_ → milkdown/hostHandle.ts `applyExternalContent`, EditorWebView.swift, EditorWebView.kt
- A **committed** delete's latch is one-way for that session: no pending
  workflow, queued bridge callback, title debounce, or in-flight adoption can
  touch the note afterwards. _(iOS/Android)_
- Only one navigation exit runs at a time. A second Back while the first is
  still draining is dropped, and a refused exit may be retried. _(iOS/Android)_
- The exit's own effect cannot interleave with a tracked workflow. Same
  guarantee, three mechanisms: Android runs move and delete inside the drain
  lock; iOS's move exits register their task as the move workflow, so a later
  exit draining that workflow waits for them; iOS navigation and delete instead
  rely on admission plus a post-drain re-check (a delete that latched while the
  drain ran abandons the exit rather than committing into it). _(iOS/Android)_
- Editor change events are fenced before the initial off-main read lands (an
  empty `setContent` echo must never be saved back over the note) and once a
  destructive exit has latched. Android additionally fences them while the vault
  is migrating to another storage root. _(iOS/Android)_ → EditorSession.kt
  `acceptsEditorChange`, EditorSession.swift `disposition(loaded:)`
- A peer delete adopted by live sync is its own ending: the file is already gone,
  so there is nothing to drain and nothing to commit, and the session only has to
  ensure no pending workflow resurrects it. _(iOS)_ → EditorSession.swift
  `closeForExternalDelete`
- An exit with no editor attached drains nothing and commits nothing against an
  unknown body — it just leaves. Only the legacy-WebView notice (github#8) is in
  that state deliberately: it renders no editor at all and its Back must still
  work. Any other detached state means the editor is mid-attach, and the exit is
  dropped. _(Android)_ → EditorSession.kt `exitWithoutEditor`,
  EditorAttachmentGate.kt

Two **permitted** divergences — each shell keeps its own sequence; the shared
invariant above is what both must satisfy:

- Navigation commit order: Android commits the body, then the title; iOS commits
  the title (the rename), then the body. Both commit both before the file moves,
  so neither can strand a body at a dead id. _(iOS/Android)_
- Move-picker timing: iOS drains before presenting the destination picker (its
  own `prepareMove` exit); Android presents immediately and drains in `onPick`.
  Both complete the drain before the move commits. _(iOS/Android)_

Two divergences are **not** permitted — each is one shell failing the invariant,
left open because closing it is a behavior change, not a refactor:

- On a parked-conflict flush the editor follows the parked id, so it never stays
  pointed at an id whose disk content is now the peer's version.
- An editor change that arrives after a destructive exit has latched is
  quarantined and folded into the final commit, never dropped: a committed delete
  discards it, a failed delete restores it.
