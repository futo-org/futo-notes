# Text-first editor: desktop host commands

Appendix to [the renderer handoff](text-first-editor-host.md). The Tauri side of the
portable transport: `apps/tauri/src-tauri/src/editor_host.rs`, typed client
`src/lib/platform/tauri/editorHost.ts`. No renderer is wired to it yet. The page-side text view
is the renderer's choice: CodeMirror 6 or a custom view; the host commands are the same either way.

| Command | Returns | Notes |
|---|---|---|
| `editor_open(noteId)` | `{token, snapshot, noteIds}` | Closes any attached note first. `WasmSession.restore(JSON.stringify(snapshot))`. |
| `editor_request(token, request)` | `HostAck` | The page's `HostRequest` (`Append`, `Resume`) as produced; hand the ack to `acknowledge`, never gate typing on it. An old `token` is refused (`stale editor session`); the Store also answers `StaleToken` for another session's token or a retired sequence, and `Rejected` for an out-of-order one. |
| `editor_checkpoint(token)` | `FlushDraftResult` | Write the Markdown now (write, converge, recreate or park). Rejects with `{kind: 'failed', message}`; input is not paused, so retry. |
| `editor_close(token)` | `FlushDraftResult` | Saves the Markdown (a checkpoint), then releases the lease; if the save fails the note stays attached and it rejects like `editor_checkpoint`. |
| `editor_note_ids()` | `string[]` | The vault's ids in delivery order, for `update_note_ids`. |
| event `editor:saved` | `{token, result, error}` | The worker's save timer fired (500 ms after the last edit, 2 s max wait). `result` is the `FlushDraftResult` when it wrote, `error` the message when the write failed (the Store retries). |

- **Threading.** One worker thread per attached note owns the `StoreEditorHost`; it opens,
  answers requests in arrival order and checkpoints. Commands only queue and wait, so no
  Store I/O runs on the IPC or UI threads. One note is attached per app (all windows).
  `editorRequest` in `editorHost.ts` sends the page's requests one at a time so they reach
  the worker in sequence order; the page itself never waits on a reply to keep typing.
- **Save policy.** Saving is the worker's job, never a page request. After each job the
  worker re-arms `save_delay()` (500 ms after the last edit, at most 2 s after the first
  unsaved edit); when it elapses the worker runs `save_if_due()` and emits `editor:saved`
  so the page can apply the save's mutation. A failed save does not pause input and
  retries 2 s later. The page's own `editor_checkpoint` is an explicit save-now.
- **Closing.** `editor_close`, opening another note and app exit checkpoint before dropping
  the worker. A process crash loses at most the unsaved window; there is no recovery log.
- **Coexistence.** `local_notes_save` and `local_notes_flush_draft` refuse the attached note
  (the Store's `*_unattached` verbs check the editor lease by collision key, its current id
  after renames, under the same gate hold as the write, so an attach cannot slip between).
  The plain `save`/`flush_draft` do not: an old save would overwrite the note and the
  editor's next save would then park its draft as a conflict. The new frontend must save attached notes only through the editor's own saves (`editor:saved`, `editor_checkpoint`, `editor_close`).
  Rename, move and delete still go through `local_notes_*`; they retarget the attachment,
  and a deleted note answers every later request with an error, so close it.
- **Note ids.** Deliver `noteIds` once at open, then call `editor_note_ids()` after the
  page's own note mutations and on `fs:change`, and pass the result to `update_note_ids`
  (the page's `update_note_ids` never changes its source, selection or history).
