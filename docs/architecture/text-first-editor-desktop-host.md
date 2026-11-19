# Text-first editor: desktop host commands

Appendix to [the renderer handoff](text-first-editor-host.md). The Tauri side of the
portable transport: `apps/tauri/src-tauri/src/editor_host.rs` (commands and state) and
`editor_host/worker.rs` (the per-note worker), typed client
`src/lib/platform/tauri/editorHost.ts`. The renderer is `src/features/editor/desktop/`: its
view draws the engine's display text, and `attachedNote.ts` holds the open note's attachment.

| Command                                     | Returns                   | Notes                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor_switch(noteId, discard)` | `{opened, closed}` | Attaches `noteId` (`opened`: `{token, noteId, snapshot}`; `WasmSession.restore(JSON.stringify(snapshot))`), then releases the note attached before it (`closed`: its outcome, null when none): saved, or with `discard` dropped unsaved. A failure at either step leaves the previous note attached and nothing changed. The note already attached (`noteId`, or a case variant that is the same file on this volume) is saved, or with `discard` dropped, and read back from disk under a new token instead, keeping its lease; `closed` is that release. Any other note whose lease is held (a case variant that is a second file included) fails the switch. |
| `editor_reload(token)` | `{opened, closed}` | Saves the note `token` holds, then reads that note back from disk into a fresh draft under a new token, keeping the lease (a save that parked reads the copy): the host names the note, never the page. `closed` is the save. |
| `editor_request(token, request)`            | `HostAck`                 | The page's `HostRequest` (`Append`, `Resume`) as produced; hand the ack to `acknowledge`, never gate typing on it. An old `token` is refused (`stale editor session`); the Store also answers `StaleToken` for another session's token or a retired sequence, and `Rejected` for an out-of-order one.                                                                                         |
| `editor_checkpoint(token)`                  | `EditorOutcome`           | Write the Markdown now (write, merge, converge, recreate or park; a clean draft only reads the note, to offer an outside change). Rejects with `{kind: 'failed', message}`; input is not paused, so retry.                                                                                                                                                                                                                             |
| `editor_rename(token, title)` | `EditorOutcome` | Saves the draft as `title` (sanitized) in the folder the attachment's note is in when it runs, in one Store workflow (`save_draft_as`): an unchanged note is written and renamed (collision-resolved, backlinks rewritten); a changed one keeps its bytes and the draft parks as a conflict copy named after the destination. The page never names the destination. The attachment follows, same token and sequence. Rejects like `editor_checkpoint`. |
| `editor_close(token, discard)`              | `EditorOutcome`           | Saves the Markdown (or with `discard` drops it), then releases the lease; if the save fails the note stays attached and it rejects like `editor_checkpoint`. Going Home.                                                                                                                                                                                                                      |
| `editor_note_ids()`                         | `string[]`                | The vault's ids in delivery order, for `update_note_ids`.                                                                                                                                                                                                                                                                                                                                     |
| `editor_hold_saves(held)`                   | —                         | Test automation only: while held, every write of the attached note declines (timer and checkpoint report `saved: false`; rename, a reload and close reject). A release build refuses.                                                                                                                                                                                                           |
| event `editor:saved` | `{token, outcome}` | The worker's save timer fired (500 ms after the last edit, 2 s max wait): `outcome` saved, or with `error` set when the write failed (the Store retries). Also a move a store workflow made (a move, a sync relocation, a rename the file watcher saw): `outcome` with `saved: false`. |

`EditorOutcome` is `{stamp, noteId, revision, saved, parked, mutation, offered, recreated,
error}`: what the worker did, the note the attachment holds after it, the draft revision then
(`saved`: the note holds the draft at it, or `offered`), whether a save parked the draft in
`noteId` (the note it left keeps its bytes), the mutation to apply, the source the note holds
when it is not the draft at `revision` (an outside change merged in, or a clean draft's outside
source: the page adopts it at `revision`), whether the save recreated a note deleted outside,
and the timer's failure, if it failed.

- **Threading.** One worker thread per attached note owns the `StoreEditorHost`; it opens,
  answers requests in arrival order, checkpoints and renames. Commands only queue and wait,
  so no Store I/O runs on the IPC or UI threads. One note is attached per app (all windows).
  `editorHost.ts` sends every command one at a time, in the order the page sent it, so
  requests reach the worker in sequence order and a checkpoint writes every edit sent before
  it; the page itself never waits on a reply to keep typing. Commands that save go through
  `invokeVaultCommand`, so a vault that stops accepting writes raises the vault-unavailable
  state; `editor_request` does not (a stale token is a page race).
- **One owner of which note is attached.** Every outcome names the note the attachment holds
  and carries a `stamp`: 1, 2, … per token, in the worker's order. Tauri does not order events
  against command replies, so the page applies each outcome once, in stamp order, an earlier
  one in flight holding a later one back, and a command settles once its outcome is applied
  (`attachedNote.ts` `arrive`). One `editor:saved` listener, registered before the first
  command, routes by token: an event that beats its note's opening reply waits for it, and a
  released note keeps listening until its last outcome is applied. A store workflow that
  moves the attached note — `local_notes_move`, a folder rename or move, a sync relocation, a
  rename the file watcher saw — moves the attachment in the same span (the Store's
  `IdentityTransition`; for sync, `futo_notes_core::files::note_moved` while it holds the
  vault guard; for the watcher, `LocalNoteStore::observe_external_change` under the gate and
  the guard, once the old file is gone or holds only the attachment's own recreation of it,
  with the renamed file holding what it held before) and
  wakes the worker, which reports it on `editor:saved`. The page's own
  `savedSource` (what the note held when the draft last matched it) advances only from an
  outcome with `saved` whose `revision` is the engine's current one.
- **Save policy.** Saving is the worker's job, never a page request. After each job the
  worker re-arms `save_delay()` (500 ms after the last edit, at most 2 s after the first
  unsaved edit); when it elapses the worker runs `save_if_due()` and emits `editor:saved`
  so the page can apply the save's mutation. A failed save does not pause input and
  retries 2 s later; the page shows one save-failure toast per streak of failures, until a
  save lands. The page's own `editor_checkpoint` is an explicit save-now.
- **Closing.** `editor_close`, a switch to another note and app exit save before dropping the
  worker; with `discard` (the vault refuses writes) they drop the draft instead. A process
  crash loses at most the unsaved window; there is no recovery log. A vault reset
  (`local_notes_reset`) is the exception: the Store ends the attachment under the reset's own
  gate hold, discarding its draft, and only then is the worker dropped, so nothing is written
  back into the emptied vault.
- **Coexistence.** `local_notes_save` refuses the attached note (the Store's `save_unattached`
  checks the editor lease by collision key, its current id after renames, under the same
  gate hold as the write, so an attach cannot slip between).
  A create (`local_notes_save` with no original id) is not refused, even for the attached
  note's name: it installs a fresh file under a free name (`flush.rs` `save_unattached`).
  The plain `save`/`flush_draft` do not check: an old save would overwrite the note and the
  editor's next save would then park its draft as a conflict. The page saves the attached
  note only through the editor's own saves (`editor:saved`, `editor_checkpoint`,
  `editor_rename`, `editor_reload`, `editor_close`, `editor_switch`). A title rename is
  `editor_rename`, never a checkpoint followed by `local_notes_move`. A deleted note answers
  every later request with an error, so close it.
- **Note ids.** The open snapshot carries them (`snapshot.note_ids`, from the one vault walk
  that opens the note), so the first projection resolves every wikilink. Call
  `editor_note_ids()` after the page's own note mutations and on `fs:change`, and pass the
  result to `update_note_ids`
  (the page's `update_note_ids` never changes its source, selection or history).
