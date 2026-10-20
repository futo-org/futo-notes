## 5. The shell mailbox — shared shape, two idioms

Both shells already have the right skeleton: a draft register keyed by token
(`NotesStore.kt:235-260` `PendingEditorDraft`, `NotesStore.swift:340-375`), an `EditorSession`
that orders admission → latch → cancel → drain → commit → effect, and an attachment token.
Keep all of that. What changes is the source the register is fed from and how "capture" is
answered.

### 5.1 `EditorHost` keeps a mailbox per note id

```
Mailbox(noteId):
  latest:        { generation, content }?     // newest change or documentLoaded seed
  editedThrough: generation                   // newest edited watermark (>= latest.gen when behind)
  unreachable:   Bool                         // renderer died since this page load
  waiters:       [token -> continuation]      // flush() calls awaiting an answer
```

Routing in the message handler (`EditorWebView.kt:624-628`, `EditorWebView.swift:1415-1422`):

- `documentLoaded` → seed/replace `latest` with the content the host pushed for that id and
  that generation; `editedThrough = generation`.
- `edited` → `editedThrough = max(editedThrough, generation)`.
- `change` → if `generation > latest.generation`: replace `latest`, resume waiters whose
  condition is met, deliver to the bound view for THAT note id (the existing
  `receiveEditorChange`). A `change` whose `generation <= latest.generation` is dropped. A
  `change` for a note id with no bound view is kept in the mailbox (the iOS popped view reads
  it in `finishLeave`; Android's pop dispose flushes from it).
- `flushFailed` → resume the waiter with `unreachable`.
- `externalRefused` → resume the relink waiter with `refused(generation)`.
- Renderer death handlers → `unreachable = true` on every mailbox, resume all waiters.

Views bind to the host by note id (`attach(noteId, …)`), not by "last attached wins". Two views
overlapping during a transition (push/pop, cross-fade) each receive only their own note's
messages. This deletes the departure fence on iOS and closes #194 on Android by construction:
a late `change` from note A after note B attached is routed to A's mailbox and A's retained
flush, never to B.

### 5.2 The one decision procedure

```
awaitCurrent(noteId, deadline, purpose) -> Current(content, generation) | Unreachable(latest?)
  m = mailbox(noteId)
  if m.unreachable: return Unreachable(m.latest)
  if m.latest && m.latest.generation >= m.editedThrough: return Current(m.latest)
  token = fresh(); host.flush(token)          // one call, no probe
  wait until (m.latest.generation >= m.editedThrough) or flushFailed(token) or deadline
  return Current(m.latest) if satisfied else Unreachable(m.latest)
```

`deadline` is the existing 6 s for user exits and reconcile; the background path uses what
fits inside the OS budget (see 5.4). Note the fast path: for every exit where the user paused
typing for 200 ms before tapping Back — the overwhelming majority — this returns
synchronously with no bridge traffic at all.

Policy on `Unreachable`, per purpose (this is the whole remaining "silence" table):

| Purpose                                              | Behind (editedThrough > latest.gen)                                                 | Not behind              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| Navigate / wikilink / Move / Delete (user-initiated) | refuse once (`EditorExitFailure.capture` stays, renamed `.unflushed`); user retries | proceed on `latest`     |
| iOS system pop                                       | proceed on `latest`; retained-draft retry stays                                     | proceed on `latest`     |
| Background                                           | flush the register from `latest`                                                    | same                    |
| Reconcile                                            | no verdict this pass (today's `.unread`)                                            | classify on `latest`    |
| Relink                                               | keep the draft, no adopt                                                            | conditional adopt (5.5) |

A page whose renderer died is never "behind": `unreachable` short-circuits to `latest` on every
row. That is today's "no live document → the shell's copy" rule, decided by a real OS signal
instead of a probe.

### 5.3 Exits (`EditorSession` on both shells)

The verb and its ordering stay (drift entry `editor-exit-ordering`, `scripts/drift-registry.json:296-328`
— update its description; the invariant it states is unchanged). Only the capture phase
changes: `effects.captureBody()` becomes `effects.awaitCurrent(deadline)`, and
`editorExitBody`/`editorLeaveBody` collapse to the two-row table above.

iOS `finishLeave` (`NoteEditorView.swift:485-534`): no attempts loop; `awaitCurrent(.systemPop)`;
commit `latest`. `captureBodyForExit` (`:936-951`) becomes `awaitCurrent(.userExit)` returning
nil only on `Unreachable && behind`. The three `*.captureFailed` toasts become one string
(`notes.navigation.unflushed`, new catalog entry; delete the three old keys).

Android `navigateAfterSaving` (`NoteEditorScreen.kt:510-620`): `captureBody` becomes
`awaitCurrent`; the `prepare()` blur stays (it also drives the self-flush). Delete and Move
already commit from the shell buffer; they now commit from the mailbox's `latest` after an
`awaitCurrent` — closing the spec Gap that iOS refuses a delete for 6 s on a busy renderer
while Android never asks (editor.md ~2396-2407): both now ask, both proceed on `latest` when
not behind.

Remove: `EditorCaptureOutcome` (both), `UnansweredPageRead`, `captureWithinDeadline`,
`startRendererLivenessProbe`/`startPageRead`'s `"1"`, `EditorDepartureCapture`,
`captureDepartingDocument`, the `.lifecycle` work kind and `lifecycleReadAttempts`,
`reconcileRead`/`reconcileRetry` cancellation in `end()` (there is no read to cancel; the
reconcile's `awaitCurrent` is cancelled through its own task like any other work),
`UNRESPONSIVE_PAGE_DEAD_AFTER_MS`, `contentPushes`, `lastPushedContent`-as-comparison (keep it
only as the dedupe for re-pushing the same text).

### 5.4 Background

iOS `FutoNotesApp.swift:105-120` and Android `MainActivity.kt:168-181` call a new
`store.flushPendingEditor()` that, for each registered open note, runs `awaitCurrent(noteId,
deadline: short)` and then the existing register flush. iOS keeps `BackgroundTaskProvider`
(`LiveEditorFlush.swift:11-38`) so the wait plus the write run inside `beginBackgroundTask`;
the rest of `LiveEditorFlush` (the hold, the per-episode read, the 25 s watchdog) is deleted.
Android's `flushLive`/`refreshers`/`LIVE_FLUSH_BUDGET_MS` go the same way. The "hold the
change-fed flush while a read is out" rule is unnecessary: there is one feed, and the existing
settled-flush invariant (a durable flush advances the baseline before the next write; editor.md
"A durable native autosave flush always advances…") is what prevents two writes over one base.
Keep that invariant's tests (`SettledFlushTests`, `EditorSessionTests.cancelledSaveStillResumes`,
Android `EditorSessionTest`).

Deadline for background: the editor's `flush` answers in one serialization unless it is
settling a streamed tail. Use 2 s on Android (onPause has no OS budget guarantee) and 6 s on
iOS inside the background task. Both fall through to flushing `latest` — which is what today's
code does after 3 × 6 s.

### 5.5 Reconcile and relink

`OpenNoteReconciler.swift:169-193` / `EditorSession.kt:431-467`: replace the read with
`awaitCurrent(noteId, 6 s, .reconcile)`; `Unreachable && behind` → `.unread` / null as today;
otherwise gather facts from `latest`. The FB-5 rule ("Back does not wait out a reconcile read")
still holds because `awaitCurrent` is cancellable and `end()` cancels `.adopt` work as it does
now. The RC-08 scenarios (`unreportedEditSurvivesPeerEdit`, `…PeerDelete`) stay as tests,
driven by an `edited` watermark instead of a fake read.

Relink (`NoteEditorView.swift:700-749`, `NoteEditorScreen.kt:334-377`): `awaitCurrent`, then
`host.applyExternalContent(noteId, rebased, expectedGeneration: latest.generation)`, then wait
for `documentLoaded(external)` (adopted) or `externalRefused` (a keystroke landed; the
`edited` watermark is already ahead — loop once more through `awaitCurrent` and rebase on the
new `latest`; cap at 3 then keep the draft). `ExternalAdoption`/`adoptIfUnchangedScript` and
their tests are deleted.

### 5.6 Shell tests

Delete whole files (per the readers' inventories): iOS `EditorCaptureDeadlineTests`,
`EditorDepartureCaptureTests`, `EditorExitBodyTests`, `ExternalAdoptionTests`, `LiveEditorFlushTests`;
Android `EditorCaptureDeadlineTest`, `EditorExitBodyTest`, `ExternalAdoptionTest`. Delete the
read blocks inside iOS `EditorSessionTests` (`:304-331`, `:527-646`), `OpenNoteReconcilerTests`
(`:430-546`), `NativeMutationOutcomeTests.navigationWaitsForEditorCompletions`; Android
`EditorSessionTest` (`:463-536` helper and the ten tests listed in the Android inventory),
`EditorLifecycleFlushTest:400-521`.

Rewrite: every `RecordingOpenNoteEffects`/`FakeEditor` that expects a `"capture"` step first
(Android `EditorSessionTest` assertions at 177, 193, 214-266, 375, 418, 439, 460; iOS
`OpenNoteReconcilerTests.FakeEditor:41-55`) now seeds a mailbox. `navigationStopsOnCaptureFailure`
/ `navigation stops when the editor cannot hand back its body` become "navigation refuses once
when behind and unanswered, then leaves on retry when the change arrives".

Add, both shells, as pure unit tests over the mailbox and `awaitCurrent` (no WebView):

- a `change` for note A arriving after note B attached lands in A's mailbox and A's retained
  flush, never in B (#194 — this is the regression test the issue asks for);
- current when `latest.gen >= editedThrough` returns synchronously with no flush call;
- behind → exactly one `flush(token)`; satisfied by a `change` with `gen >= editedThrough`
  even if its token differs (a self-flush raced the request);
- `flushFailed` → `Unreachable`; a navigate exit refuses when behind, proceeds when not;
- renderer death → `unreachable`; every purpose proceeds on `latest`;
- a `change` with `gen <= latest.gen` is dropped;
- `documentLoaded` seeds the mailbox so a never-edited note exits with no bridge traffic;
- `externalRefused` loops the relink at most 3 times;
- background: behind → flush, wait, then the register flush writes `latest`; the existing
  cross-fade and retained-draft tests (`EditorLifecycleFlushTest:53-398`) still pass unchanged.

Keep: `EditorBackAffordanceTests`, `EditorSwipeBackTests` (UI; the acceptance test), `EditorTeardownTests`,
`BridgeCallSurfaceTests` (minus `getContent`), `EditorDraftCoordinatorTests`, `FlushDraftVerbTests`,
`SettledFlushTests`, `EditorNavigationDecisionTests`; Android `EditorNavigationCommitTest`,
`InsertImageDeadlineTest`, `EditorAttachmentGateTest`, `FindInNoteStateTest` (mind its source
scans at `:86,:109` — they grep for `fun navigateAfterSaving`, `override fun prepare()`,
`override suspend fun cancelPendingSave`, `fun openNoteEffects`; keep those names).
