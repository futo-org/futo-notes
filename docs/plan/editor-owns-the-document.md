# The editor owns the document — the shells stop reading it

> **Status: IMPLEMENTED 2026-10-03; broad verification exceptions recorded below.** Architecture by Fable with Justin; written as a
> hand-off for an implementing agent. Behavioural truth stays in `docs/spec/editor.md`; §9 lists
> the lines this plan renegotiates. Supersedes nothing — it closes the mechanism that
> issues #194, #244 and #245 are three symptoms of.

## Implementation journal

2026-10-03, branch `step1-editor-ownership`:

- Bridge v9, tagged changes, transition-only `edited`, flush/failure messages and conditional external apply implemented; both native specs regenerated. Native host reads, liveness probes, departure fences and lifecycle read retries are deleted. Both shells route late changes through per-note mailboxes.
- Native exits, lifecycle flushes and reconciliation wait on posted changes only when behind. Conditional external adoption waits for its acknowledgment before advancing the baseline. Renderer death permits leaving with the latest received snapshot. iOS holds background time through the durable write.
- iOS UI testing caught an initial-open race: a blank placeholder acknowledged under the real id could overwrite disk during reconciliation. Placeholders now use the empty sentinel id, clean mailbox snapshots are invalidated when starting a new open, and reconciliation starts on the real document acknowledgment. Quick capture starts with the empty body already created by its engine workflow. Native regression cases pin this gate and reject late duplicate reports after invalidation.
- Regressions were run red before their fixes: outgoing note-switch ownership, the initial-open gate, and simulator touch/launch helpers. Component data-safety and flush-failure tests: 23 passed; editor/note tests: 1,091 passed; editor package minimal suite: 284 passed.
- `just check`: passed on the final implementation; this includes the build. `just bridge-spec-check`, `just check-drift` (28 concepts), `pnpm run check:languages`: passed. All six §10.5 cleanup gates print no matches. Full embed Playwright: 579 passed; full desktop Playwright: 187 passed; smoke and note-never-emptied: 17 passed. Desktop cross-platform sync: 39 passed, 16 native scenarios skipped.
- `just test-android-native`: both flavor unit suites passed, including eleven mailbox cases. Native instrumentation: 56 passed, one skipped, one failure in `DialogImeDismissTest.dialogFieldKeepsFocusAndKeyboardWhileImeShows`; it remains an unresolved device-check result. All eight Android native cross-platform scenarios passed; the peer-rename scenario also passed after the final identity-handoff fix. Fixtures were migrated by replacing the old anonymous change injection with a real editor transaction and updating serialized Markdown fixtures.
- `just test-ios-native` on the isolated Mac worktree: 289 unit tests in 44 suites passed, five UI tests passed, and the find-bar layout test failed (64 pt gap versus a 24 pt limit). The unchanged base commit on the same iOS 27 simulator reproduces that exact failure. The modified Swift owner files pass formatting; whole-repo Swift lint also reports existing failures in unrelated files.
- Android claimed-emulator QA: a 20,000-section streaming edit survived immediate backgrounding and process restart with its final section; Back during a clean 50,000-line paragraph parse preserved disk bytes and the next note opened. The small-edit-before-giant variant and both final reruns passed.
- iOS AXe HID typing was confirmed ineffective on the unchanged baseline; software-keyboard touches work. The warm software-keyboard run passed sustained typing, wikilink pop, quick Back and streaming background. Self-link rename exposed a real identity-handoff race: the relink ran before the renamed document had a mailbox revision. Both shells now invalidate stale target snapshots and await the real load acknowledgment before conditional adoption. Matching mailbox regressions and both native self-link stories pass. The iOS story failed before this fix with the edited file reverting to the old self-link and passed afterward. All five iOS stories have passing software-keyboard results; the initial cold launch still encountered simulator errors. Both iOS stuck-page variants passed, including the small edit followed by giant parse.
- `just prepush`: blocked by the full Rust suite's OS portal trash probe (`portal declined to trash ...`), outside this change. The broad editor, desktop and sync suites above were run separately. No release or MR has been published while these verification results remain unresolved; the planned commit/MR sequence has not been executed. Changes remain reviewable in this worktree.

Implementation clarifications:

- The host API still has 18 methods: replacing `getContent` with `flush` leaves the count unchanged. Four new outbound types are added (the opening paragraph's “three messages” was a counting error).
- The native rename/move handoff uses the existing `documentLoaded` event to await the target revision before a relink; it adds no bridge method, renderer read or liveness probe. Both mailbox copies and tests were changed together.
- Test reads use `?test`/`?census`, never the production bridge. URLs adding other test flags use `&` after `?test`.
- Native find reports now carry the same document identity; Android no longer samples attachment ownership on the bridge thread.
- Reconciliation retains a restart closure only for work interrupted by an exit that later refuses; this is not a WebView retry or liveness probe.
- The general `notes.save.failedPending` catalog entry still has non-capture callers, so the cleanup gate checks only the deleted capture keys.
- Desktop continues its in-process persistence path. Native-only outgoing/lifecycle self-flush avoids delivering an old desktop note into a session already switched by its loader.

### Review follow-up — 2026-10-05

- Split loaded-document identity from bridge generation. Regressions for a two-image drop, two pending image pastes and typing during an image save failed before the fix and pass afterward.
- Identity-only `setContent` acknowledges a relabel without replacing the document or resetting history. Both native shells await the outgoing mailbox before retargeting; desktop reattachment uses the session id. The bundle caret/undo regression failed before the fix and passes afterward. Android emulator rename under 40 concurrent document edits retained every marker and left no old-id file or conflict copy.
- Late iOS departure writes publish and retain their draft until durable. An actual blocked-directory write test proves lifecycle retry and removal after success. Background persistence in both shells now records its baseline through the ordinary save completion before another write.
- Android exits cancel a pending reconcile adoption; the wedged-renderer Back regression failed before the fix. Restored lifecycle, interruption/retry, mailbox/register ordering and exit-policy coverage. Both shells test three refused relink attempts and preserving an edit delivered between attempts. iOS tests same-id stacked binding delivery, deferred retry after refusal and mailbox pruning.
- Quick capture invalidates deleted-body snapshots. Hosts prune unused mailboxes and acknowledged push bodies; Android ignores malformed tagged reports. Debug native test-hook scope, stale spec text and test titles are updated.
- Final portable checks: `just check` passed (2,997 application tests, 549 editor-package tests, build and gates); `pnpm run check:languages` passed; `just check-drift` passed (29 concepts). Smoke: 7 passed. Clean full editor-embed run: 580 passed. The first broad run collided with concurrent bundle rebuilds and shared Playwright artifacts; those tooling failures are filed as papercuts and the isolated rerun is green.
- Android: `just test-android-native` passed 373 tests per flavor; `just build-android-native` passed both flavors; claimed-emulator rename and malformed-message QA passed. iOS: `just test-ios-native` passed 297 unit tests in 46 suites and all six UI tests on claimed `futo-qa-3`. Touched Swift files pass formatting; whole-repo Swift lint still reports pre-existing errors in unrelated license/toolbar/test files.
- iOS self-link device QA retained `back to [[SelfyX]]qq77\n` on disk after rename and subsequent typing, with only `SelfyX.md` and no conflict copy. The automated story reported an AXe translation error after typing; a fresh screenshot and explicit disk assertions confirmed the actions landed. This is a manual device result, not a passing automated story.

## 0. Decisions this plan makes (read before starting)

Justin asked for this plan after a review of the 107 editor commits since the Milkdown merge
(2026-09-21): about a third of them, and three of the open release blockers, are the same
defect class — the native shell and the editor WebView both think they own the open note's
text, and every lifecycle edge (Back, background, rename, sync adopt) has to read across an
async bridge with a deadline and then decide what silence means. This plan removes the read.
The decisions it takes, which the implementing agent must NOT re-litigate or soften:

1. **`BRIDGE_VERSION` goes 8 → 9 (breaking).** The `change` message gains identity, four
   messages are added, two host calls change shape, one host call is replaced. Both native
   hosts move in the same MR (root AGENTS.md M10). This plan is the §11.6 sign-off request;
   Justin reading and approving it is the sign-off.
2. **The shells never evaluate JavaScript to learn what the document says.** Not at exit,
   not at background, not before a reconcile, not for a relink. `getContent` leaves the bridge
   contract. The only reads left are in-process desktop calls on the Svelte component, which
   share a thread with the session and are not the problem.
3. **Every message the editor posts about a document names the document.** `noteId` plus a
   page-monotonic `generation`. A shell routes by id; it never binds "whoever is attached now".
4. **A note switch inside the debounce saves the edit.** Today it drops it unless the shell
   read first (`tests/editor-embed-milkdown.spec.ts:904` pins the drop). That test changes.
5. **"Refuse the exit" survives for exactly one case**: the shell knows the editor holds an
   edit it has not received, asked for it, and did not get it within the deadline. The
   liveness probe, the 60 s "dead after" rule, the three-attempt retry and the
   busy-versus-wedged classification are deleted, because the shell no longer has to infer
   dirtiness from silence — the editor tells it.

What this plan does not do: it does not move serialization to Rust, does not touch sync, does
not change the 200 ms typing debounce, and does not decide whether progressive open stays.
The residual loss window after this work is "typed in the last few hundred milliseconds and
the OS killed the process before any flush ran", which is the window desktop already has.

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

## 2. The design — one sentence per rule

1. The shell names the document it hands the editor; the editor stamps that name and a
   generation on everything it says about it.
2. The editor tells the shell, synchronously at the keystroke, when it holds an edit the shell
   has not received (`edited`). It is cheap and carries no content.
3. The editor delivers content (`change`) on the usual debounce, and immediately on its own
   lifecycle edges, on a note switch, and when the shell asks (`flush`).
4. The shell keeps a mailbox per note id: the newest `change` it has and the newest `edited`
   watermark. **The shell is current for a note when `latest.generation >= editedThrough`.**
   That one comparison replaces every read.
5. When the shell is current, an exit, a background flush, a reconcile or a relink proceeds
   on `latest` with no WebView interaction at all.
6. When it is behind, it calls `flush(token)` once and waits for a `change` that satisfies it,
   bounded by a deadline. Deadline with no answer is `unreachable`.
7. `unreachable` while behind: a user-initiated exit refuses once and can be retried (by the
   time the user taps again the change has usually arrived); a system-forced exit (iOS pop,
   background) proceeds on `latest` and leaves the retained-draft retry in place. A renderer
   that died (`onRenderProcessGone`, `webViewWebContentProcessDidTerminate`) marks the page
   unreachable for good, and every path proceeds on `latest` — the edit is gone with the
   process and refusing helps nobody.
8. Replacing the document from outside (sync adopt, relink) is conditional on the generation
   the shell last saw, decided by the editor in one place, never by comparing text.

## 3. The bridge contract, v9

Edit `packages/editor/src/bridge.ts`; regenerate with `just bridge-spec`; `pnpm exec vitest run
packages/editor/src/bridge.test.ts` pins the surface (currently 18 methods, version 8 — the version
assertion changes). Also fix the stale header: it still says desktop uses CodeMirror.

### 3.1 Identity

```ts
/** Which document a message is about. `noteId` is the vault-relative id the host
 *  passed in `initialize`/`setContent`; `generation` is a page-monotonic counter
 *  the bundle increments on every load and every reportable user transaction. */
export interface DocumentRef {
  noteId: string;
  generation: number;
}
```

`generation` never resets within a page load. It increments for: each `initialize`/`setContent`
load (whole document or first streamed chunk), each applied `applyExternalContent`, and each
transaction `isReportableDocumentChange` accepts (`documentChanges.ts:63-67`). Streamed chunk
appends are housekeeping and do not increment it.

### 3.2 Host → editor (`FutoEditorApi`)

| Call                                                         | Change                                    | Notes                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize(configJson)`                                     | `EditorHostConfig` gains `noteId: string` | `hostBoot.ts:34-63`, validate like `content`                                                                                                                                                                                                                                                                                       |
| `setContent(noteId, markdown)`                               | gains `noteId`                            | **Before loading, flush the outgoing document** (§4.3)                                                                                                                                                                                                                                                                             |
| `applyExternalContent(noteId, markdown, expectedGeneration)` | gains both                                | Applied iff the editor's current ref is `{noteId, expectedGeneration}` and it holds no unreported edit; otherwise refused (§4.5)                                                                                                                                                                                                   |
| `flush(token)`                                               | **new**                                   | Serialize now and post `change` with `flushToken: token`; see §4.4                                                                                                                                                                                                                                                                 |
| `getContent()`                                               | **removed**                               | Desktop keeps the component method; the gauntlet adapter (`tests/editor-gauntlet/milkdownAdapter.ts:531-568,654`) and Playwright suites switch to a `window.__futoTest.readDocument()` hook installed only by the embed's test build path — the same pattern as `window.__futoEditorMounted` (drift entry `editor-mounted-global`) |

Everything else is unchanged.

### 3.3 Editor → host (`FutoEditorOutboundMessage`)

| Message           | Shape                                                                                        | When                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documentLoaded`  | `DocumentRef & { source: 'load' \| 'external' }`                                             | A load or external apply is on screen (whole doc, or the first chunk of a streamed one). The host seeds the mailbox from it: `latest = {generation, content: <what it pushed>}`, `editedThrough = generation`                    |
| `edited`          | `DocumentRef`                                                                                | Synchronously inside the first reportable transaction after the last `change`/`documentLoaded` for this document — a transition, not every keystroke. Posted during streaming too (the save lock holds `change`, never `edited`) |
| `change`          | `DocumentRef & { content: string; flushToken?: string }`                                     | The serialization of exactly `generation`. Debounced in typing (200/1500 ms unchanged); immediate on the edges in §4.4                                                                                                           |
| `flushFailed`     | `DocumentRef & { flushToken: string; reason: 'noDocument' \| 'loadFailed' \| 'serializer' }` | A `flush` the editor cannot honour. Content is never invented — this is the structural close of #244                                                                                                                             |
| `externalRefused` | `DocumentRef`                                                                                | An `applyExternalContent` whose `expectedGeneration` did not match. `generation` is the editor's current one                                                                                                                     |

`ready`, `initialized`, `focus` and the rest are unchanged. `OUTBOUND_MESSAGE_TYPES` and the
union at `bridge.ts:557-584` gain the four new types; `BridgeCoverageTest` (Android) and the
exhaustive `switch` over `BridgeMessageType` (iOS) will fail until both hosts handle them,
which is the point.

### 3.4 Version note for the header

Write it in the style of the existing entries: v9 is BREAKING — `change` is no longer usable
without identity, `setContent`/`applyExternalContent` take a note id, `getContent` is gone,
`flush` is required when an exit mailbox is behind. Name #194/#244/#245 and this plan.

## 4. Editor side (`src/features/editor/milkdown/`, `src/editor-embed/`, `packages/editor/`)

### 4.1 Where the counter lives

`MilkdownEditor.svelte` already has `documentGeneration` (`:415-429`, ticked by `openNote` and
teardown, used for image targeting). Promote it: it becomes THE generation, ticked also by
`applyExternal` success and by every reportable transaction. Keep the image-insert use; it
benefits (a late insert can be refused by generation — out of scope, note it as a follow-up).

Add component state `currentNoteId: string | null` set by `openNote(noteId, text)` /
`setContent` and cleared on teardown. The component's public callbacks become:

- `onchange(content, ref: DocumentRef, flushToken?: string)` — desktop ignores the extras.
- `onedited(ref)` — new.
- `ondocumentloaded(ref, source)` — new.
- `onflushfailed(ref, token, reason)` — new.
- `onexternalrefused(ref)` — new.
- `flush(token?)` — new method (also used internally by the self-flush edges with no token).

### 4.2 `edited`: a transition flag in the plugin's callback

`documentChanges.ts` `createDocumentChangePlugin` already calls `onDocumentChanged()`
synchronously at dispatch. In the component's `documentEdited` (`:1040-1043`): increment the
generation, and if `unreported === false` set it and post `edited`. `unreported` is cleared
when a `change` for the current generation is posted or a load replaces the document. Do not
post `edited` per keystroke: it is a transition. The existing `editedDuringLoad` flag merges
into this (it is the same fact restricted to the streaming window).

### 4.3 A load flushes the outgoing document first

`applyExternal` (`:1416-1529`) today never cancels or flushes `changeTimer`, and `holdsExactly`
(`:1643-1674`) is deliberately side-effect free because an untagged `change` from there would
land in the next note (RC-04). Both reasons die with tagging. New order at the top of a load
for a DIFFERENT note id (`setContent`/`openNote`):

1. If the outgoing document has an unreported edit: if it is streaming, `endPendingLoad('settle')`;
   then post `change` tagged with the OUTGOING ref. Synchronously, before anything about the
   new note is touched. (A streaming, unedited outgoing document is discarded as today.)
2. Proceed with the load; post `documentLoaded` for the new ref once the whole document or the
   first chunk is in the view.

A load for the SAME note id (the host re-pushing, `holdsExactly` true) still posts nothing.

This is what makes the iOS wikilink pop structurally safe: UIKit re-adopts the parent and pushes
`setContent(parent)` before the child's exit runs; the child's pending edit goes out tagged with
the child's id in step 1; the child's `finishLeave` then finds its mailbox current and commits
with no WebView interaction (`docs/qa/wikilink-pop-large-edited-note.md` is the acceptance
story). Cost to name in the comment: a streaming AND edited outgoing note is settled
synchronously here, bounded by its parse, which is the same bound today's capture had.

### 4.4 `flush` and the self-flush edges

`flush(token)` is `captureContent()` (`:1676-1697`) turned inside out — same steps, but the
answer is posted, not returned:

1. `loadFailed` → `flushFailed(reason: 'loadFailed')`. No document / never loaded →
   `flushFailed(reason: 'noDocument')`.
2. Streaming and edited → `endPendingLoad('settle')` (forces the tail; the host asked).
   Streaming and clean → serialize is the echo (`hostMarkdown`), cheap.
3. Cancel the debounce timer, stop a pending priming wait, `readSerialized()`; `null` →
   `flushFailed(reason: 'serializer')` (RC-17's fallback to older text is gone — the host has
   that text already).
4. Post `change` with the current ref and `flushToken`. Clear `unreported`.

A flush when nothing is unreported still posts `change` (the host dedupes by generation). It
costs one cached serialization; for an unedited document it is the host's own bytes.

Self-flush (no token) on: the editor's own blur (`:689-690` focus listeners → add the call
before `onfocuschange(false)`), `document.visibilitychange` → `hidden`, and `pagehide`. These
are defence in depth; the shells' explicit `flush` on exit/background is the primary path,
because Android's WebView does not reliably see `visibilitychange` when the Activity pauses.

Delete `captureContent()`, `editReadOutOf` and the RC-28 arming at `:1757` — RC-28 existed
because a host read handed out text before any `change` said so; nothing is handed out any
more. Keep `getContent()`/`readContent()` on the component for desktop (`NotesShell.svelte:80`,
`createNotePersistence.ts:64`, `createNoteLoader.ts:72-91`); remove the `window.FutoEditor.getContent`
wiring in `createFutoEditorApi.ts:125-140` (the RC-73 `?? ''` coercion goes with it).

### 4.5 Conditional external apply

`applyExternalContent(noteId, markdown, expectedGeneration)`: if `currentNoteId !== noteId` or
`generation !== expectedGeneration` or `unreported` → post `externalRefused` with the current
ref and do nothing else. Otherwise apply exactly as today (`setContent` path →
`applyExternal`, history-suppressed), increment the generation, post `documentLoaded(source:
'external')`. The `adoptIfUnchangedScript` compare-and-swap (RC-70/71) is this, expressed by
generation instead of by text, and it closes the "keystroke between read and replace" window
by construction: a keystroke bumps the generation, the apply is refused, the shell already has
the `edited` watermark and rebases again.

### 4.6 Embed wiring (`src/editor-embed/main.ts`, `createFutoEditorApi.ts`, `hostBoot.ts`)

- `main.ts:82-88` `onchange` currently ignores its argument and re-reads `getContent()`. It now
  posts what the component handed it, with the ref and token.
- Wire the four new callbacks to posts.
- `hostBoot.ts` applies `config.noteId` before `content` (step order at `:182-203`), and
  `createFutoEditorApi.setContent` passes the id through.
- `createFutoEditorApi.initialize`/`setContent` keep `resetHistory()`.

### 4.7 Editor-side tests

Playwright (`tests/editor-embed-milkdown.spec.ts`; helper `settleChangeDebounce` at `:78-86`):

- Rewrite: `:293` (the `change` carries `noteId`/`generation`), `:840/:863/:877` (switch
  semantics: the outgoing note's change is posted tagged BEFORE the next note loads; nothing
  for the outgoing note arrives after), `:904` (**inverted**: a switch inside the debounce posts
  the typed text tagged with the outgoing id, then shows the next note), `:2660/:2774`
  (`flush` mid-stream: clean → echo with load generation; edited → settles and posts the full
  note), `:2976/:3003` (a `flush` reports the unreported edit exactly once).
- Add: `edited` is posted once per unreported run, synchronously, including during streaming;
  `flush(token)` echoes the token; `flushFailed` on a serializer throw (reuse the throwing
  fixture from `MilkdownEditor.test.ts:196-253`) and on a never-loaded page; `applyExternalContent`
  with a stale generation posts `externalRefused` and leaves the text alone; with the right
  generation posts `documentLoaded(external)`; `documentLoaded` after `initialize`, after
  `setContent`, and after the first chunk of a streamed load; blur/visibilitychange/pagehide
  each post a `change` immediately; a `change` is never posted for a note id the editor no
  longer holds.
- `packages/editor/src/bridge.test.ts`: version 9, the method list without `getContent` and
  with `flush`, the union with the new shapes.
- `packages/editor/src/hostBoot.test.ts`: `noteId` required and applied before content.
- `tests/note-never-emptied.spec.ts:410` (RC-28) — rewrite as: an Undo back to the loaded
  document after a flush is still reported (the flush cleared `unreported`; the undo is a new
  reportable transaction, so it is).
- `src/features/editor/milkdown/documentChanges.test.ts`: unchanged; add the transition test
  for `edited` wherever the flag lands (component test).

Desktop must be untouched in behaviour: `just check` and the desktop Playwright suite green with
no desktop code change beyond passing `noteId` into `openNote`.

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

## 6. Sequencing

One branch, one MR to `main`, commits per concern so a reviewer can read each layer alone. A
v9 bundle is unusable by a v8 host and vice versa, so nothing here ships half-landed (M10);
the dev-build dogfood is on the branch.

1. `feat(editor): tag every document message and add flush (bridge v9)` — §3 + §4, bundle
   tests green, `just bridge-spec` regenerated, desktop untouched. Both native hosts will fail
   to compile/their coverage tests will fail; that is expected at this commit and fixed by the
   next two.
2. `feat(android): the shell keeps a mailbox and never reads the editor` — §5 on Android.
3. `feat(ios): the shell keeps a mailbox and never reads the editor` — §5 on iOS.
4. `docs(spec): editor exits are decided from the mailbox, not a read` — §9, plus
   `apps/ios/AGENTS.md`, `apps/android/AGENTS.md`, `packages/editor/AGENTS.md`,
   `docs/plan/milkdown-transition.md` §10 (strike the #194 entry), drift registry description.
5. `test(qa): exit stories for the mailbox` — §8.
6. `chore(editor): delete the read path` — §10, with the proof-gate output in the commit body.

Do the Android shell before iOS: it has the fewer read sites and its unit tests run on Linux.
The Mac is available over Tailscale for the iOS commit (memory `reference_mac_ssh_ios_builds`:
`justin@100.101.132.29`; codesign needs Justin's own `ssh -t` session, build/test/install you
can run yourself). Keep the worktree on the Mac at the same branch and run `just test-ios-native`
there after every iOS change. Never land a branch where only one host speaks v9.

Commit 6, after everything is green, is the cleanup pass in §10 as its own commit
(`chore(editor): delete the read path`), so the reviewer sees deletions separately from
behaviour. The §10 proof gates must pass before the MR is opened.

## 7. Verification chain (report every command and result; M18)

- Bundle: `pnpm run test:editor:minimal`; `npx playwright test --config playwright.editor-embed.config.ts`
  (all three `editor-embed-milkdown*.spec.ts`); `pnpm exec vitest run packages/editor src/features/editor`.
- Contract: `just bridge-spec-check`, `just check-drift`, `pnpm run check:languages` (new catalog key).
- Desktop regression: `just check`; the desktop Playwright suite; `tests/note-never-emptied.spec.ts`.
- Android: `just test-android-native` (unit); device: `just android-native` on a claimed pool
  device (`eval "$(just qa-claim android)"`), then the stories in §8.
- iOS (Mac over Tailscale, see memory `reference_mac_ssh_ios_builds`): `just test-ios-native`,
  `just test-ios-stories` (runs the wikilink-pop story's automated steps), then §8 by hand.
- Cleanup: the §10.5 proof gates print nothing; `just lint-swift` clean on `EditorWebView.swift`.
- Before merge: `just prepush`.

Perf guard (M5): typing must not post per keystroke. Assert in a Playwright test that N
keystrokes inside one debounce window produce exactly one `edited` and one `change`.

## 8. QA stories (`docs/qa/`)

Update `wikilink-pop-large-edited-note.md`: the "why a person" paragraph is now wrong (the
`change` names its note); keep the story, rewrite the rationale as "UIKit's adopt-before-exit
order is the one thing nothing below the navigation stack reproduces", re-run, record.

Add two stories, each with the result of the run on this branch and what it could not prove:

- `background-while-streaming.md` (iOS and Android): open a 20k-section note, type a word in
  the first section while "Loading the rest" shows, background the app within a second,
  wait, kill the app, reopen: the word is in the file. Covers RC-92 without the read.
- `exit-from-a-stuck-page.md` (Android first, iOS if the Mac is available): the 50,000-line
  single-paragraph note from 2026-09-01 (`docs/plan/milkdown-transition.md` §5); open it, press
  Back during the parse: the user leaves at once (not behind → proceed on `latest`), the file
  is unchanged, and the next note opens correctly once the parse ends. Then: type into a small
  note, switch to the giant one, press Back during ITS parse — the small note's word is in its
  file (the switch flushed it tagged).

## 9. Spec renegotiation (`docs/spec/editor.md`)

Behaviour that changes, and the lines that state it today (line numbers as of this plan):

- "Saving & rename" `:2046`: keep the 200 ms line; add that every report names its note and
  generation, that an unreported edit is announced synchronously, and that a note switch
  reports the outgoing note's pending edit before loading the next.
- The Gap at `:2065-2070` (select-all-delete dropped when flushed inside the window): a
  switch or exit now flushes first, so the window is only a process kill. Narrow the Gap's
  text to that; do not delete it.
- "Editor exits" `:2298` (commit the exact captured snapshot) → "the newest tagged `change`
  the shell holds, after asking the editor to flush when it is behind".
- `:2324-2335` (no live document → the shell's copy) → the renderer-death rule in §5.2.
- `:2336-2347` (deadline plus liveness probe) → delete; replace with the two-row table.
- `:2348-2356` (streaming withholds `change`) → streaming withholds `change` but announces
  `edited`; a flush settles the tail.
- `:2370-2374` (change fencing) → fencing is by note id; the pre-load fence stays
  (`documentLoaded` is the gate instead of "the initial off-main read").
- Permitted divergence "Where the committed body comes from" → delete; both shells commit
  `latest`. The Gap under it (iOS delete refuses for 6 s; Android never asks) → closed.
- The Gap at `:1969-1993` (exit during a >6 s slice drops streamed-time text, #245) → closed:
  the shell is behind and either waits or refuses; it never commits a stale copy as current.
- Gaps #79 (iOS ignores a parked disposition on navigation) and #80 (Android drops a change
  after the destructive latch) are untouched — note that the mailbox makes #80 easy later
  (the quarantine is the mailbox entry) but do not close it here.
- `docs/spec/sync.md` open-note dispositions: "both native shells settle a deferred open-note
  adoption on a blur edge" still holds; the pre-classify read line, if any, changes to
  `awaitCurrent`.

Close #194, #244, #245 from the MR with the test that pins each.

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

## 11. Traps the agent will meet

- **`FindInNoteStateTest` source scans** grep for method names (§5.6). Rename nothing it names.
- **The Android `onReady` fires immediately on attach when `isReady` is already true**
  (`EditorWebView.kt:831-856`): the mailbox must be seeded by `documentLoaded`, not by attach,
  or a never-edited note is "behind" forever (no `latest`). Treat "no `latest` and no
  `editedThrough`" as current-with-nothing-to-save, and log it.
- **iOS `attach` rebinds closures** (`EditorWebView.swift:971-996`). Replace the single
  `onChange` closure with a `[noteId: handler]` map; `detach(token)` removes only its own id.
- **Two views on the same note id** during an iOS push/pop of the same note (open A, link to
  A): the mailbox is per id, both views read the same `latest`; the register already coalesces
  by id with highest token winning (`NotesStore.swift:448-467`). Fine; add a test.
- **`settledFlush` must still advance the baseline** before the next write of the same id, or
  a background flush followed by a fast `change` parks a conflict copy. Do not weaken it.
- **`blur()` inside the old `captureScript`** was doing double duty (drop the keyboard, then
  read). The self-flush on blur keeps the first half useful; the shells still call `blur()` in
  `prepare()`.
- **Do not add a per-keystroke post.** `edited` is a transition. If a test needs per-keystroke
  generations, read them through the test hook, not the bridge.
- **`just check` currently has a known red** on this machine: the enormous-paragraph open
  budget (~2.05 s vs 2.0 s). Pre-existing; report it, do not touch the budget (M15).
- **Catalog strings** (root AGENTS.md §5): the one new toast key goes in `languages/en.json`.
- **Worktree**: this plan lives in `~/Developer/futo-notes-step1-editor-ownership`
  (`just wt new step1-editor-ownership`, slot ports already assigned). Build and run from it
  through `just`, never from the primary checkout.

## 12. Follow-ups this plan enables but does not do

- `insertImage` refused by generation (the #194 sibling at `milkdown-transition.md` §10).
- Android Gap #80: quarantine-after-latch is one more mailbox field.
- Desktop could adopt the same `edited`/generation signals for `hasUnseenEditorChanges` and
  `closeDeadlineDirty.ts` instead of reading the component; not needed for correctness there.
- Step two (Rust owns the live document) is a separate decision; whichever tree store is
  chosen, the per-note mailbox is the seam it plugs into.
