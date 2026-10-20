## 10. Cleanup — the deletion checklist and its proof

The point of this work is the code that leaves. Deleting is a deliverable, not a tidy-up: a
read path left behind "just in case" is the next agent's shortcut back to a capture. Work the
checklist top to bottom in the cleanup commit, tick each item, and finish with the proof gates.
Line numbers are as of 2026-10-03 (`main` at 4a39858d); confirm each with `rg` before deleting,
and never delete something a kept path still references.

### 10.1 Bundle

- [x] `src/features/editor/milkdown/MilkdownEditor.svelte`: `captureContent()` (1676-1697);
      `editReadOutOf` (324-327) and both uses (the RC-28 branch in `reportDocumentChange`
      ~1091, the arming at ~1757); the `editedDuringLoad` flag once merged into `unreported`
      (306-318, 1527); the comment on `holdsExactly` (1643-1674) that justifies being
      side-effect free "because a change from here would land in the next note" — the
      function stays, the reason is gone, rewrite the comment.
- [x] `src/editor-embed/createFutoEditorApi.ts`: `getContent` (125-140) including the RC-73
      `?? ''` coercion and its comment.
- [x] `src/editor-embed/main.ts:82-88`: the re-read inside `onchange`.
- [x] `packages/editor/src/bridge.ts`: `getContent` from `FutoEditorApi`; the stale header
      (13-15, "desktop uses CodeMirror"); the stale "rAF-coalesced" doc on `ChangeMessage`.
- [x] `tests/editor-gauntlet/milkdownAdapter.ts:531-568, 654` and any Playwright helper such
      as `captureOutgoingNote` (`editor-embed-milkdown.spec.ts:810-819`): move to the test hook.
- [x] `packages/editor/AGENTS.md`: the line "`MilkdownEditor`'s `readSerialized`/`getContent`
      and the desktop `invoke` wrapper write each one as U+FFFD" — `getContent` is now only
      the component method; reword so nobody re-adds a bridge `getContent` to satisfy it.

### 10.2 Android (`apps/android/app/src/main/java/com/futo/notes/`)

- [x] `ui/EditorWebView.kt`: `ExternalAdoption` + `adoptIfUnchangedScript` (104-146);
      `captureContentAndWait` / `readContentAndWait` (971-1017); `applyExternalContentIfUnchanged`
      (1019-1060); `PageRead`, `readPage`, `startPageRead` and the `"1"` probe (1062-1154);
      `CAPTURE_SCRIPT`, `READ_SCRIPT` (1305-1324); `UNRESPONSIVE_PAGE_DEAD_AFTER_MS` (1303);
      `unresponsiveSinceMs`; `contentPushes` and every `+= 1`; the `pageRead` completion in
      `onRenderProcessGone` (463-468, keep the handler — it now marks mailboxes unreachable);
      `postedAttachmentGeneration` sampling for `findMatches` (362-369) once the page stamps
      ids — `isCurrentFindReportOwner` (99-102) can then compare the stamped id instead.
      `CAPTURE_DEADLINE_MS` (1300) stays only if `insertImageAndWait` still uses it; rename
      it to say so.
- [x] `ui/EditorNavigationCommit.kt`: lines 12-186 — `EditorCaptureOutcome`, `editorExitBody`,
      `UnansweredPageRead`, `unansweredPageRead`, `captureWithinDeadline`. Keep 207-271.
- [x] `ui/EditorSession.kt`: `OpenNoteEffects.captureEditor`; `LIFECYCLE_READ_ATTEMPTS` (247);
      `reconcileRead`, `reconcileRetry`, `reconcileRetryInFlight` (260-262) and their
      cancel/relaunch in `end()` (523-525, 580-605); `refreshFromLiveEditor` (357-375);
      the read in `settleDeferredAdoption` (403); `readEditorAheadOfAnExit` / `readEditor`
      (431-467); the RC-92/RC-08/FB-5 rationale blocks (338-356, 410-430) — replace with one
      paragraph pointing at the mailbox.
- [x] `NotesStore.kt`: `refreshers`, `liveFlushes`, `setRefresher`, `flushLive` (331-357),
      `LIVE_FLUSH_BUDGET_MS` (238-240), the `liveFlushes > 0` hold (311), `setEditorRefresher`,
      `flushPendingEditorLive` (572-574), and the RC-92 KDoc.
- [x] `ui/NoteEditorScreen.kt`: `captureEditor` (407-420); the NAVIGATE `captureBody` read and
      its rationale (545-559); the refresher registration (738-745); the relink read + CAS
      (338-372); the `notes.save.failedPending` branch for `EditorExitFailure.CAPTURE` (609-617)
      becomes the one `.unflushed` toast.
- [x] `MainActivity.kt:168-181`: `onPause` calls the new `flushPendingEditor()`; the RC-92
      comment goes.
- [x] Tests, whole files: `test/ui/EditorCaptureDeadlineTest.kt`, `test/ui/EditorExitBodyTest.kt`,
      `test/ui/ExternalAdoptionTest.kt`. Blocks: `EditorSessionTest.kt` 463-536 helper and the
      ten read tests (538, 564, 585, 606, 644, 660, 679, 705, 736, 767);
      `EditorLifecycleFlushTest.kt` 400-521. `EditorContentCaptureTest` stays only for
      `decodeJavascriptString` (used by the engine probe) — rename the file to say what it tests.

### 10.3 iOS (`apps/ios/Sources/`)

- [x] `Editor/EditorWebView.swift`: `ExternalAdoption`, `adoptIfUnchangedScript`,
      `externalAdoption` (23-68); `EditorCaptureOutcome`, `editorExitBody`, `editorLeaveBody`
      (70-147); `EditorCaptureResumer` (193-213); `EditorDepartureCapture` (215-268); the
      liveness box (270-278); `captureWithinDeadline` + `EditorCaptureWait` (280-352);
      `waitForCurrent` (368-374) if only the capture used it; `captureContent(leftBy:)` through
      `captureDepartingDocument` (1018-1125); `captureDeadlineSeconds`, `captureScript`,
      `readScript`, `startRendererLivenessProbe`, `captureCurrentContent` (1265-1370);
      `departure` and `holdsChanges` in `adopt()` and the `.change` handler (577, 1416-1418);
      `contentPushes` (666-668 and every `+= 1`); `documentOwner` if the id map replaces it
      (680-684); the `EditorAttachmentSlot` RC-77 rationale (595-605) — the slot stays only
      if `closeFind` still needs it (`NoteEditorView.swift:551-552`); the 1684 departure
      resolution in `webViewWebContentProcessDidTerminate` (keep the handler).
- [x] `Notes/Editor/EditorSession.swift`: the `.lifecycle` work kind and its cancel entries
      (17-19, plan table); `lifecycleReadAttempts` + `refreshFromLiveEditor` (248-292); the
      `.capture` failure path (399-404) becomes `.unflushed`; fix the out-of-date plan table at
      165-170 while there.
- [x] `Notes/Editor/LiveEditorFlush.swift`: delete the file except `BackgroundTaskProvider`
      (11-38), which moves next to the new background flush.
- [x] `Notes/Editor/OpenNoteReconciler.swift`: `captureEditor` effect (84-87); `.unread` if
      the new `Unreachable` result replaces it (102-104); the read block (169-193) and the
      RC-08 comment.
- [x] `Notes/Editor/NoteEditorView.swift`: `setDraftRefresher` registration (401-403); the
      capture loop in `finishLeave` (492-503); the relink read + conditional adopt (703-742);
      `refreshFromLiveEditor` (844-865); the `captureEditor` effect (883-896);
      `captureBodyForExit` (936-951); the three `captureFailed` toasts (1019-1020, 1081-1082,
      1144-1149).
- [x] `Notes/Storage/NotesStore.swift`: the `isHolding` guard (450-452); `setDraftRefresher`,
      `liveEditorFlush`, `flushPendingEditorLive` (476-500); the refresher release/rearm/reset
      lines (370, 376, 473, 926).
- [x] `App/FutoNotesApp.swift:105-120`: both call sites → `flushPendingEditor()`; RC-92 comment.
- [x] Tests, whole files: `Tests/Editor/EditorCaptureDeadlineTests.swift`,
      `EditorDepartureCaptureTests.swift`, `EditorExitBodyTests.swift`, `ExternalAdoptionTests.swift`,
      `Tests/Notes/Editor/LiveEditorFlushTests.swift`. Blocks: `EditorSessionTests.swift` 304-331
      and 527-646; `OpenNoteReconcilerTests.swift` 430-546 (keep the two RC-08 scenarios as
      rewrites); `NativeMutationOutcomeTests.navigationWaitsForEditorCompletions` (152-172), rewritten as image-insertion ordering because navigation still waits for that queue;
      `EditorAttachmentSlotTests.attachmentIsReadableOnceOnScreen` if the slot goes.
- [x] `BridgeCallSurfaceTests`: drop `getContent` from `documentedMethods`.
- [x] The 11 pre-existing swift-format errors in `EditorWebView.swift` noted in
      `milkdown-transition.md` §10: most are in deleted ranges; run `just lint-swift` and clear
      whatever is left in that file in this commit.

### 10.4 Strings, docs, registry

- [x] `languages/en.json` (and every other catalog): delete `notes.navigation.captureFailed`,
      `notes.move.captureFailed`, `notes.delete.captureFailed`; Android's
      `notes.save.failedPending` only if nothing else uses it. Add `notes.navigation.unflushed`.
      `pnpm run check:languages` must pass.
- [x] `docs/spec/editor.md`: the §9 lines; the `→` authority refs that name deleted symbols
      (`captureContent(leftBy:)`, `editorLeaveBody`, `editorExitBody`, `captureCurrentContent`,
      `captureWithinDeadline`, `startRendererLivenessProbe`, `captureContentAndWait`,
      `EditorCaptureDeadlineTests`, `EditorCaptureDeadlineTest`, `EditorExitBodyTests`,
      `EditorExitBodyTest`); the two closed Gaps.
- [x] `docs/plan/milkdown-transition.md` §10: strike the `change`-generation entry (~1163-1168)
      and the `insertImage` deadline entry's reference to it; leave the image follow-up.
- [x] `docs/qa/wikilink-pop-large-edited-note.md`: the rationale paragraph (§8).
- [x] `scripts/drift-registry.json` `editor-exit-ordering` (296-328): the description's
      "nothing mechanically holds the two shells together … next step is the Rust engine"
      sentence; name the mailbox as the shared statement instead. `just check-drift`.
- [x] `apps/ios/AGENTS.md`, `apps/android/AGENTS.md`: any sentence that tells an agent to
      "read the editor" / "capture" at exit; add one line each: the shell never evaluates
      JavaScript to learn the document — it reads its mailbox.
- [x] `docs/learnings/`: if a learning doc exists for RC-92/RC-77 (check
      `rg -l 'RC-92|RC-77|captureWithinDeadline' docs/`), add a dated "superseded by
      editor-owns-the-document" line at its top rather than deleting it.

### 10.5 Proof gates (all must print nothing; paste the output in the MR)

Baseline on `main` at 4a39858d, 2026-10-03: the second gate alone hits 362 lines across 30
files. That is the number that has to reach zero.

```sh
# No shell reads the editor's text, no probe, no capture vocabulary left anywhere outside this plan.
rg -n 'getContent\(' apps/ packages/editor/src --glob '!**/*.test.*'
# Embed's only read is the query-gated test hook, never a host bridge method.
rg -n 'getContent\(' src/editor-embed --glob '!main.ts'
rg -n 'captureWithinDeadline|EditorCaptureOutcome|UnansweredPageRead|EditorDepartureCapture|LiveEditorFlush|editorExitBody|editorLeaveBody|captureContentAndWait|readContentAndWait|captureCurrentContent|captureDepartingDocument|flushPendingEditorLive|refreshFromLiveEditor|readEditorAheadOfAnExit|adoptIfUnchangedScript|applyExternalContentIfUnchanged|ExternalAdoption|LIFECYCLE_READ_ATTEMPTS|lifecycleReadAttempts|LIVE_FLUSH_BUDGET_MS|UNRESPONSIVE_PAGE_DEAD_AFTER_MS|CAPTURE_SCRIPT|READ_SCRIPT|captureScript|readScript|startRendererLivenessProbe|startPageRead|editReadOutOf|captureContent\b' \
  apps/ src/ packages/ tests/ scripts/ docs/spec docs/qa languages/ --glob '!docs/plan/editor-owns-the-document.md'
rg -n 'evaluateJavaScript\("1"\)|evaluateJavascript\("1"\)' apps/
rg -n 'captureFailed' apps/ languages/ src/
# notes.save.failedPending remains the general durable-write failure message.
# Every RC id whose mechanism is gone is only cited as history, never as a live rationale.
rg -n 'RC-92|RC-77|RC-28|RC-73|RC-08\b' apps/ src/ packages/ --glob '!**/*.test.*' --glob '!**/*Tests.swift' --glob '!**/*Test.kt'
```

Then the counts, for the MR description (expect roughly −1,550 source and −1,500 test lines
across Swift and Kotlin before the additions):

```sh
git diff --stat main...HEAD -- apps/ios apps/android | tail -1
git diff --stat main...HEAD -- 'apps/ios/Sources' 'apps/android/app/src/main' | tail -1
```

If a gate prints a hit the agent believes is legitimate, the plan is wrong, not the gate:
record why in the MR and update this section in the same commit.
