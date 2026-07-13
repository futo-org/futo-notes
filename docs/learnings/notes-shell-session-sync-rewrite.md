# Notes shell/session/sync contract rewrite

## 1. Outcome and measurements

This rewrite keeps the desktop shell's observable note, tab, watcher, and sync
behavior while replacing the dependency callback graph inside
`NotesShell.svelte`, `noteSession.svelte.ts`, and `syncManager.svelte.ts`.

| Measure                              | Before (`8822da1`) |                     After |
| ------------------------------------ | -----------------: | ------------------------: |
| Production lines in the three owners |              2,471 |                     1,855 |
| `NotesShell.svelte` lines            |              1,048 |                       963 |
| Session + sync dependency callbacks  |                 37 |                        15 |
| Legacy focused tests                 |                 61 | 42 replacement fast tests |
| Browser acceptance scenarios         |                  9 |                         9 |
| Cross-client sync scenarios          |                 30 |                        30 |

The production boundary shrank by 616 lines (24.9%). No compatibility adapter
or parallel implementation remains. The desktop-only shell also dropped the
unreachable Tauri-mobile drawer/back-swipe projection; native mobile uses the
SwiftUI and Compose shells and never instantiates this component.

## 2. Central lesson

The editor session and sync lifecycle are different owners, but they need one
direct relationship. The former callback graph represented every property and
mutation as a separate dependency, which hid ordering rules among dozens of
forwarders. The replacement passes the session itself to the sync owner:

- `noteSession` owns the loaded id, saved baseline, live draft, validation, and
  serialized saves;
- `syncManager` owns sync health, watcher batching, remote rename/adopt/delete
  reconciliation, and deleted-tab pruning;
- `NotesShell` owns composition, DOM projections, tabs, routing, and layout.

The important boundary is not “component versus helper.” It is “who may decide
whether the open draft is clean, and who may replace or close it.”

## 3. Replication playbook

1. Fetch `origin/main` and create a fresh worktree from it.
2. Record the starting commit and require a clean worktree.
3. Run the focused state tests, production TypeScript/Vite build, browser
   acceptance tests, and the full cross-client suite before editing.
4. Inventory every legacy test name and write this ledger before removing its
   implementation-coupled setup.
5. Rebuild the note session first, then sync reconciliation, then reduce the
   shell to composition wiring.
6. Run fast tests after each owner, then browser tests, then the complete
   isolated cross-client gate.
7. Fetch/rebase current main and repeat the affected gates.

Baseline commands and results:

```text
vitest run noteSession.test.ts syncManager.test.ts       61/61 passed
tsc --noEmit + vite build                               passed, 3991 modules
playwright p0 + remote-rename + sync-status-bar          9/9 passed
node tests/cross-platform-sync.mjs                       30/30 passed
```

The cross-client harness uses two debug app instances, a fresh data directory
per client, and a fresh local server port per scenario. It never uses the demo
or production service.

## 4. Safety invariants

- A save never treats a missing/destroyed editor as an empty document.
- Opening a note is read-only; CM6 line-ending normalization does not write.
- A title-only edit cannot rename the file during a normal typing pause; body
  edits still persist quickly, and an explicit flush drains unseen editor text.
- Programmatic remote adopts do not increment the local edit version.
- Focused CM6 documents are never replaced; a clean deferred adopt lands on
  blur, while a newly dirty draft wins.
- A deleted open note is closed only after disk absence is authoritative; a
  recreated empty note remains valid, and an unsaved draft remains open.
- Deleted background tabs are pruned only when their files are absent.
- Remote renames retarget tabs before deleted-id pruning.
- Pure local pushes do not trigger a vault rescan or redundant search reindex.
- Sync and save remain asynchronous and never block editor input.

## 5. Failure-derived rules

- A test-only route seed must mark the route loaded before navigation; otherwise
  the route effect correctly reads the absent file and replaces the seed with
  an empty document.
- Sync completion is a four-phase operation: report outcome, project peer
  writes, apply renames, then reconcile/prune. Mixing these phases recreates the
  rename-versus-delete ordering bugs.
- Disk existence, not `updatedIds`, decides whether a deleted id survived. The
  summary combines local pushes and peer pulls, so membership can be ambiguous.
- An empty read following a delete must be followed by an existence recheck.

## 6. Complete legacy-test ledger

| Removed test                                                                                            | Plain-English promise                                           | Disposition    | New evidence                                                         |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| persists a new note when the title was changed                                                          | A title-only edit makes a new note durable.                     | **Fast**       | `draft decisions` replacement test                                   |
| skips writes for a brand-new note that was never touched                                                | Opening and leaving untouched quick capture creates no file.    | **Fast**       | `draft decisions` replacement test + cross-client tombstone scenario |
| skips writes for existing notes when neither title nor content changed                                  | Clean notes are not rewritten.                                  | **Fast**       | `draft decisions` replacement test                                   |
| reports typed content the save pipeline never saw                                                       | Flush sees live editor bytes even without onchange.             | **Fast**       | `flushes editor content even when rAF never delivered onchange`      |
| reports an unsaved title-only change                                                                    | A changed title is a dirty draft.                               | **Fast**       | `draft decisions` replacement test                                   |
| is clean when editor and title match the last save                                                      | Matching baselines are clean.                                   | **Fast**       | `draft decisions` replacement test                                   |
| is clean when there is no editor (content undefined)                                                    | A destroyed editor can never mean an empty note.                | **Fast**       | `draft decisions` replacement test                                   |
| treats the rAF-deferred delivery of adopted content as an echo                                          | An adopt echo is not a user edit.                               | **Fast**       | `draft decisions` replacement test                                   |
| treats a real edit as an edit                                                                           | Content differing from the adopted baseline is local work.      | **Fast**       | `draft decisions` replacement test                                   |
| still counts a type-then-revert delivery so session content converges                                   | Revert deliveries update session state.                         | **Fast**       | `draft decisions` replacement test                                   |
| never classifies a title-only debounce (no content payload) as an echo                                  | Title events always reach dirty bookkeeping.                    | **Fast**       | `draft decisions` replacement test                                   |
| does NOT rename mid-typing: a title-only edit holds for ~10s, not 500ms                                 | Title renames wait through ordinary typing pauses.              | **Fast**       | same-named replacement test                                          |
| body content edits keep the existing short (500ms) debounce                                             | Body edits persist after 500 ms idle.                           | **Fast**       | same-named replacement test                                          |
| focuses the body when opening '+ New'                                                                   | Quick capture focuses the body.                                 | **Fast**       | same-named replacement test                                          |
| opens a broken-wikilink target as an empty deferred note (no eager create, no forced focus)             | Missing link targets open empty without creation or autofocus.  | **Fast**       | `opens a broken-wikilink target as an empty deferred note`           |
| does not rewrite a CRLF note to disk just because it was opened                                         | Line-ending normalization is read-only.                         | **Fast**       | same-named replacement test                                          |
| prefers an explicit rename from the sync summary                                                        | Explicit rename evidence wins.                                  | **Fast**       | `rename classification` replacement test                             |
| falls back to a recent recorded rename target                                                           | A watcher rename hint can recover the active target.            | **Fast**       | `rename classification` replacement test                             |
| infers a rename from delete plus collision-suffixed update                                              | Collision suffixes preserve the open note.                      | **Fast**       | replacement fast test + remote-rename browser test                   |
| returns null when sync only deleted the note with no recovery target                                    | A plain delete is never invented into a rename.                 | **Fast**       | `rename classification` replacement test                             |
| rewrites opaque fetch TypeErrors to an actionable message                                               | Browser transport failures are actionable.                      | **Core**       | `syncErrorMessage.test.ts`                                           |
| matches the other fetch-failure phrasings case-insensitively                                            | Known browser phrasings share one message.                      | **Core**       | `syncErrorMessage.test.ts`                                           |
| passes through a real Error message verbatim                                                            | Server/auth errors retain their detail.                         | **Core**       | `syncErrorMessage.test.ts`                                           |
| stringifies non-Error throwables                                                                        | Tauri string rejections are displayable.                        | **Core**       | `syncErrorMessage.test.ts`                                           |
| starts with no error                                                                                    | Sync health starts clear.                                       | **Acceptance** | sync-status-bar browser initial state                                |
| sets reactive error state when a background sync fails                                                  | Background failures reach UI state.                             | **Fast**       | `surfaces a background error and clears it...`                       |
| clears the error on the next successful sync                                                            | A clean cycle clears cycle errors.                              | **Fast**       | replacement outcome test + browser test                              |
| raises the failure indicator + toast when a completed cycle has per-item failures                       | Partial cycles are not reported as success.                     | **Fast**       | failure-message replacement test + browser test                      |
| toasts once on the healthy→failing edge, not on every failing cycle                                     | Identical retries do not spam.                                  | **Fast**       | distinct-failure replacement test                                    |
| clears on a clean sync and re-toasts if failures return                                                 | Recovery re-arms failure notification.                          | **Fast**       | distinct-failure replacement test                                    |
| clearSyncError() dismisses the indicator on demand (click-to-clear)                                     | Dismiss clears current UI state.                                | **Acceptance** | sync-status-bar click browser test                                   |
| surfaces live-loop errors from sync:live-state (message present)                                        | Live errors share sync error UI.                                | **Fast**       | stream outcome replacement tests                                     |
| a clean reconnect clears a stream error (the stream recovered)                                          | Stream recovery clears stream failure.                          | **Fast**       | reconnect replacement test + browser test                            |
| a clean poll does not clear a stream error or re-arm its toast                                          | Poll health cannot prove SSE health.                            | **Fast**       | same-promise replacement test                                        |
| clearSyncError() (click-to-dismiss) clears a stream error too                                           | User dismissal clears either source.                            | **Acceptance** | sync-status-bar browser test                                         |
| a live cycle-error raises the error but keeps live (idle tick) up                                       | Cycle errors do not claim the stream disconnected.              | **Fast**       | reconnect/cycle replacement test + browser test                      |
| re-toasts when a subsequent error has a different message (no clear needed)                             | Materially different failures notify again.                     | **Fast**       | distinct-failure replacement test                                    |
| stamps lastSyncedAt on a successful sync                                                                | Completed cycles update last-sync time.                         | **Fast**       | timestamp replacement test                                           |
| notifies the engine of peer updates, deletes, and renames                                               | Peer writes are searchable immediately.                         | **Fast**       | peer-projection replacement test                                     |
| does not notify the engine for our own pushes (non-peer ids)                                            | Local pushes avoid redundant indexing.                          | **Fast**       | peer-projection replacement test                                     |
| toasts 'Sync complete' for a clean MANUAL sync                                                          | Manual clean sync gets completion feedback.                     | **Fast**       | manual-completion replacement test                                   |
| stays quiet for clean background/live syncs                                                             | Routine cycles stay quiet.                                      | **Fast**       | manual-completion replacement test                                   |
| never reports 'Sync complete' for a manual cycle with per-item failures                                 | Failed manual cycles never claim success.                       | **Fast**       | distinct-failure replacement test                                    |
| watcher: defers applyExternalContent for the focused open note until blur                               | Watchers never replace focused CM6 state.                       | **Fast**       | focused-editor replacement test                                      |
| watcher: still adopts the open note when the editor is NOT focused                                      | Clean blurred notes adopt watcher content.                      | **Fast**       | immediate-adopt replacement test                                     |
| sync-complete: defers applyExternalContent for the focused open note until blur                         | Sync never replaces focused CM6 state.                          | **Acceptance** | edit-during-sync and active-note cross-client scenarios              |
| sync-complete: still adopts the open note when the editor is NOT focused                                | Clean blurred notes adopt sync content.                         | **Fast**       | immediate-adopt replacement test                                     |
| converts a deferred focused adopt into local-draft preservation when the user edits before blur         | A draft created during deferral wins.                           | **Fast**       | deferred-draft replacement test                                      |
| closes the open session and toasts instead of blanking the editor                                       | Peer deletion closes a clean open note.                         | **Fast**       | peer-deletion replacement test + cross-client scenario               |
| keeps an unsaved local draft (never closes) when the deleted open note has draft changes                | Unsaved local text survives peer deletion.                      | **Fast**       | peer-deletion replacement test                                       |
| still follows a collision-rename of the open note rather than closing it                                | Rename evidence wins over deletion handling.                    | **Acceptance** | remote-rename browser test                                           |
| retargets tabs (onAnySyncRename) for a collision-inferred rename and does not prune the old id          | Tabs move before old-id pruning.                                | **Fast**       | inferred-rename ordering replacement test                            |
| adopts the replacement when the open note was deleted then recreated ON DISK                            | A recreated file is adopted.                                    | **Fast**       | recreated-note replacement test                                      |
| closes and prunes when the open note is in BOTH lists but is GONE from disk (our push + peer tombstone) | Disk absence beats ambiguous summary lists.                     | **Fast**       | both-lists replacement test                                          |
| prunes tabs only for deleted notes that are GONE from disk (recreated ones stay)                        | Recreated background tabs remain.                               | **Fast**       | background-pruning replacement test                                  |
| prunes the closed active-note tab (no draft) so it cannot resurrect                                     | Closed deleted active tabs cannot reopen missing ids.           | **Acceptance** | peer-delete cross-client scenario                                    |
| does NOT prune the open note whose unsaved draft was kept                                               | A kept draft retains its tab.                                   | **Fast**       | kept-draft replacement test                                          |
| closes cleanly (no unhandled rejection) when the existence check errors                                 | Probe failure closes the active note safely and does not crash. | **Fast**       | rejected-probe replacement test                                      |
| closes when a deleted-id note vanishes between the exists-check and the read (TOCTOU)                   | Empty reads are re-verified before adopt.                       | **Fast**       | TOCTOU replacement test                                              |
| still adopts a legitimately-empty recreated note (re-verify says present)                               | Empty content remains valid when the file exists.               | **Fast**       | empty-recreate replacement test                                      |
| still prunes OTHER deleted notes when the active note is switched mid-probe                             | An active reconcile bail does not abort background pruning.     | **Fast**       | mid-probe-switch replacement test                                    |

Ledger completeness check: 16 removed note-session tests + 45 removed sync-manager
tests = 61 rows. The table contains 61 data rows.

## 7. Current coverage shape

- Fast: 42 tests across the two rewritten owners.
- Core: canonical error-message, note CRUD, sync orchestrator, and watcher
  batching tests remain in their existing owners.
- Browser: 9 contract shell/status/rename/crash scenarios, plus a 49-scenario
  broader shell pass covering titles, folders, tags, and sidebar state.
- Cross-client: 30 real desktop-to-desktop sync scenarios with isolated local
  services.
- Build/static: TypeScript no-emit and the production Vite build.

## 8. Follow-up queue

- The shell still contains desktop tab persistence and native listener setup.
  Those belong to their existing owners only if a future rewrite can delete the
  shell policies rather than wrap them in another callback adapter.
- Fault injection cannot currently prove process death between a session save
  completing and a user-initiated delete. The current delete path cancels the
  timer before deleting; a durable compare-and-swap/delete transaction would
  require a lower-level note-store contract and is out of this rewrite.
