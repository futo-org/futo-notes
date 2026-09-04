# iOS autosave regression — lessons and follow-ups

The fix and story harness are present on main. The durable-flush invariant lives in
`apps/ios/Sources/Notes/Storage/NotesStore.swift` (`settledFlush`), with tests in
`apps/ios/Tests/Notes/Editor/SettledFlushTests.swift`. Device stories run through
`just test-ios-stories`; the pre-push routing is owned by `.githooks/pre-push` and
`scripts/run-ios-stories-if-available.sh`.

## Incident summary

Typing into one note on the native iOS app at ~2.5 characters/second mints
`<title> (conflict YYYY-MM-DD)` copies — 9 copies of one note in ~3 minutes on a
pooled simulator, first copy within ~20 s. The editor silently rebinds to each copy,
so the original note stops receiving edits. Sync is **not** involved (reproduced with
sync disconnected); the `:stable` server is incidental.

Root cause: commit `6dfcf14bd` ("feat(ios): render open-note dispositions", first
shipped in v1.7.0) moved the debounced autosave from `store.write` +
`confirmedSavedContent` onto `store.flushDraft`, and put the baseline advance
(`savedContent = newContent`) behind `guard session.isActive` — i.e. behind
`Task.isCancelled`. Every keystroke's `session.schedule(.save)` cancels the in-flight
save task, but a flush that has already returned is **durable**: skipping the record
leaves `savedContent` behind disk, so the next flush's `base` is stale and the engine
correctly parks the editor's own earlier write as a conflict copy
(`crates/futo-notes-store/src/lib.rs` `flush_draft`, diverged arm). Android is immune:
its equivalent span runs under `withContext(NonCancellable)`
(`apps/android/app/src/main/java/com/futo/notes/ui/EditorSession.kt`).

Why no test caught it: the decision lived in a tested pure function
(`confirmedSavedContent`) until `6dfcf14bd` inlined it into the SwiftUI view, where no
seam reaches it; `FlushDraftVerbTests` pins the engine's park (correct behavior, wrong
layer to catch this); `EditorSessionTests` pins that a cancelled save *settles* but its
fake body has no baseline to go stale; nothing on any platform types at a human cadence
or asserts "no files the user didn't create".


## Invariant being installed

**A durable flush always advances the editor's baseline. Only identity may veto the
record — never task liveness.** The implementation and tests above enforce this.


## Follow-ups recorded at completion

1. **iOS debug test hook** mirroring Android's
   `apps/android/app/src/debug/java/com/futo/notes/testhook/TestHookProtocol.kt`, so
   stories can ask the app for state (~100 ms) instead of reading the a11y tree (~2 s).
   Not needed by story 1 (disk oracle suffices); build it when a story needs app-internal
   state, not before.
2. More stories on the harness: rename-while-typing, background-flush (F8), park-then-
   continue-typing convergence.
3. **Open decision for Justin**: the `editor-exit-ordering` drift entry pre-registered
   its own escalation — "if a third divergence ships as a device bug, the next step is
   the deferred Rust editor engine (crates/futo-notes-editor), not a bigger fixture."
   This incident qualifies. Whether to start that engine is a scope call this record only
   surfaces.


## Original execution record

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/plan/ios-autosave-device-stories.md
```
