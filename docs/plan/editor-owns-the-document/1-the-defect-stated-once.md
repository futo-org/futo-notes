## 1. The defect, stated once

Read these three files first; the comments quoted below are the scenarios the new design must
still satisfy, and the agent should be able to point at the line that satisfies each.

- `apps/ios/Sources/Editor/EditorWebView.swift:215-236` (RC-04/RC-09): "A `change` carries no
  note identity … A `change` handled while this read is pending was therefore posted by the
  OUTGOING document, and handing it to the callbacks just bound would save the popped note's
  body into the revealed one."
- `apps/android/app/src/main/java/com/futo/notes/ui/EditorSession.kt:338-356` (RC-92): "A note
  that is still streaming its tail reports no `change` at all … and a typed edit spends 200 ms
  in the bundle's debounce, so the register the lifecycle flush pulls lags the editor by exactly
  the text most likely to be lost."
- `apps/android/app/src/main/java/com/futo/notes/ui/EditorNavigationCommit.kt:151-161` and
  `:110-112`: the deadline, the probe, and "Silence is never read as 'the editor holds nothing'
  there — that would adopt a peer's version over an edit the page is sitting on."

Every one of those is a consequence of two facts: the `change` message is anonymous
(`packages/editor/src/bridge.ts:283-287`), and the editor is silent about edits it is holding
back (streaming, debounce). Fix both facts and the reads have nothing left to learn.

Today's read sites, so the agent can confirm each one is gone at the end:

| Shell   | Trigger                            | Read                                                  | Where                                                                          |
| ------- | ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| iOS     | Back / edge swipe                  | `captureContent(leftBy:)` ×3 attempts                 | `NoteEditorView.swift:485-534` `finishLeave`                                   |
| iOS     | wikilink, Move, Delete             | `captureBodyForExit` → `captureCurrentContent`        | `NoteEditorView.swift:949-951, 1050, 1100`                                     |
| iOS     | shared WebView re-adopted          | `captureDepartingDocument` + change fence             | `EditorWebView.swift:577, 1110-1125, 1418`                                     |
| iOS     | scenePhase inactive/background     | `LiveEditorFlush` → `readContent` ×3                  | `NotesStore.swift:492`, `LiveEditorFlush.swift`, `EditorSession.swift:248-292` |
| iOS     | sync touched the open note         | `OpenNoteReconciler` reads before classifying         | `OpenNoteReconciler.swift:169-193`                                             |
| iOS     | self-link relink after rename/move | read, then compare-and-swap script                    | `NoteEditorView.swift:700-749`, `EditorWebView.swift:41-58`                    |
| Android | Back / arrow / wikilink            | `captureContentAndWait`                               | `NoteEditorScreen.kt:545-559`, `EditorWebView.kt:985-987`                      |
| Android | onPause                            | `flushPendingEditorLive` → `refreshFromLiveEditor` ×3 | `MainActivity.kt:168-181`, `NotesStore.kt:331-357`, `EditorSession.kt:357-375` |
| Android | sync touched the open note         | `readEditorAheadOfAnExit`                             | `EditorSession.kt:431-467`                                                     |
| Android | blur after deferred adoption       | same read                                             | `EditorSession.kt:390-408`                                                     |
| Android | self-link relink                   | read + compare-and-swap                               | `NoteEditorScreen.kt:334-377`, `EditorWebView.kt:1029-1060`                    |

Shared machinery that exists only for those reads: `captureWithinDeadline`, the `"1"` liveness
probe, `EditorCaptureOutcome` (4 cases), `UnansweredPageRead`, `EditorDepartureCapture`,
`LiveEditorFlush`, the `.lifecycle` work kind, `CAPTURE_SCRIPT`/`READ_SCRIPT`/`adoptIfUnchangedScript`,
`contentPushes`/`lastPushedContent` comparisons, `editReadOutOf` (RC-28) and `captureContent()`
in the bundle. The readers' line-level inventories are in §10.
