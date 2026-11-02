# Text-first editor: desktop host commands

Appendix to [the renderer handoff](text-first-editor-host.md). The Tauri side of the
portable transport: `apps/tauri/src-tauri/src/editor_host.rs`, typed client
`src/lib/platform/tauri/editorHost.ts`. No renderer is wired to it yet. The page-side text view
is the renderer's choice: CodeMirror 6 or a custom view; the host commands are the same either way.

| Command | Returns | Notes |
|---|---|---|
| `editor_open(noteId)` | `{token, snapshot, recoveryIssue, noteIds}` | Closes any attached note first. `WasmSession.restore(JSON.stringify(snapshot))`; a recovered pause stays paused. `recoveryIssue` is the Store's typed issue (`kind`, `record`, `version`). |
| `editor_request(token, request)` | `HostAck` | The page's `HostRequest` (Append, Flush, Resume) as produced; hand the ack to `acknowledge`. An old `token` is refused (`stale editor session`); the Store also rejects a request carrying another session's token or a reused sequence. |
| `editor_checkpoint(token)` | `FlushDraftResult` | The only Markdown save while attached (write, converge, recreate or park). Rejects with `{kind: 'failed', message}`, or `{kind: 'committed', result, message}` when Markdown committed but recovery retirement failed: apply `result.mutation`, then retry. |
| `editor_close(token)` | — | Flushes accepted edits to recovery, then releases the lease. No Markdown checkpoint. |
| `editor_note_ids()` | `string[]` | The vault's ids in delivery order, for `update_note_ids`. |
| event `editor:flush-due` | token | The Store's recovery flush delay elapsed. |

- **Threading.** One worker thread per attached note owns the `StoreEditorHost`; it opens,
  answers requests in arrival order and checkpoints. Commands only queue and wait, so no
  Store I/O runs on the IPC or UI threads. One note is attached per app (all windows).
- **Flush policy.** Durability is page-issued, as the transport spec requires: request
  sequences are page-owned, and timer execution never acknowledges. After each request the
  worker re-arms `recovery_flush_delay()` (100 ms from the oldest unflushed edit); when it
  elapses it emits `editor:flush-due` once. The page answers with `flush()` through
  `editor_request`, or after its outstanding Append is acknowledged if `flush()` was `Busy`.
- **Closing.** `editor_close`, opening another note and app exit drop the worker after one
  host-issued Flush (sequence past the page's last; the page is gone). Accepted edits are
  already in the OS before then; reopening replays them.
- **Coexistence.** `local_notes_save` and `local_notes_flush_draft` refuse the attached note
  (the Store's `*_unattached` verbs check the editor lease by collision key, its current id
  after renames, under the same gate hold as the write, so an attach cannot slip between).
  The plain `save`/`flush_draft` do not: an old save would overwrite the note and the
  editor's checkpoint would then park its draft as a conflict. The new frontend must save attached notes only through `editor_checkpoint`.
  Rename, move and delete still go through `local_notes_*`; they retarget the attachment,
  and a deleted note answers every later request with an error, so close it.
- **Note ids.** Deliver `noteIds` once at open, then call `editor_note_ids()` after the
  page's own note mutations and on `fs:change`, and pass the result to `update_note_ids`
  (it answers `Busy` while a change is unreleased; retry after the ack).
