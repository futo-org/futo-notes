# Desktop Rust Adapter — Architecture Spec

The Tauri crate is a desktop projection over shared Rust services. It owns IPC,
application composition, watcher events, trash policy, updater integration, and
other OS glue. It does not own a second note architecture.

## Ownership

- `futo-notes-model`: deterministic note rules only.
- `futo-notes-core::files`: cross-platform path and atomic-file safety
  primitives only.
- `futo-notes-store`: durable Markdown layout, migrations, note/folder
  workflows, collision resolution, backlink rewrites, conditional flushes, and
  the single search lifecycle.
- `futo-notes-sync`: sync/session behavior, outside the local-note rewrite.
- Tauri and UniFFI: projections of the same store contract.

`AppState` owns exactly one `LocalNoteStore` for the resolved vault, one watcher,
and the sync/session state. Commands never create independent note or search
owners.

## Module map

| Module                                     | Responsibility                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `application.rs`                           | Builder, plugins, setup, managed state, complete command registration.                |
| `application_state.rs`                     | The single desktop state aggregate.                                                   |
| `local_notes.rs`                           | `local_notes_*` projection, including desktop note/folder trash policy.               |
| `filesystem_watcher.rs`                    | Recursive watcher, normalized events, rename pairing, and typed one-shot suppression. |
| `vault_location.rs`                        | Custom-root persistence and the debug/release default-root safety split.              |
| `image_commands.rs`                        | Image import and clipboard bitmap persistence.                                        |
| `system_trash.rs`                          | Recoverable delete with headless hard-delete fallback.                                |
| `sync/*`                                   | Tauri wiring for the shared sync session/orchestrator.                                |
| `platform_integration.rs`                  | Linux integration, single-instance behavior, and process setup.                       |
| `updater_commands.rs`, `panic_reporter.rs` | Updater policy and crash persistence.                                                 |

## Local-note IPC

The current frontend contract is:

- `local_notes_bootstrap`, `local_notes_snapshot`, `local_notes_inventory`
- `local_notes_read`, `local_notes_exists`, `local_notes_save`,
  `local_notes_flush_draft`
- `local_notes_delete`, `local_notes_move`
- `local_notes_create_folder`, `local_notes_rename_folder`,
  `local_notes_delete_folder`
- `local_notes_reset`
- `local_notes_search`, `local_notes_wait_until_search_ready`,
  `local_notes_rescan`

These commands expose workflow-shaped results. `local_notes_save` commits the
body, optional rename, collision resolution, and every resolvable backlink
rewrite under one store lock. Note and folder workflows also return the
post-commit folder projection. TypeScript applies that result without a
follow-up vault scan and never predicts it.

Old `notes_*`, note-related `fs_*`, and independent `search_*` commands are not
compatibility requirements and must not be reintroduced.

## Watcher and atomicity

- Every store mutation is serialized.
- Before the first filesystem syscall, the store reports the complete planned
  `FileChange` set through `BeforeWrite`; desktop registers those paths in the
  one-shot watcher suppressor.
- Atomic Markdown writes use a flushed, short-named temporary file in the same
  directory followed by rename. Case/normalization-only renames use a hidden
  temp hop and restore the source if the second hop fails.
- A watcher echo consumes one suppression entry. A later external edit inside
  the expiry window is therefore still delivered.
- External changes are projected back into the store and trigger one index
  reconcile plus one frontend snapshot refresh.

## Safety boundaries

- `vault_location.rs` alone selects the active root. Debug defaults to
  `~/Documents/fake-notes`; release defaults to `~/Documents/futo-notes`.
  The frontend delegates default selection through `resolve_default_notes_root`
  in `src/lib/platform/tauri/notesRoot.ts`; it never reconstructs either path.
- Note IDs and folder paths are validated beneath the root; traversal and root
  deletion are refused.
- Destination collisions are folded by case and Unicode normalization, then
  resolved with deterministic `-2`, `-3`, … suffixes. Existing notes are never
  overwritten by a create, rename, move, or folder move-up.
- Folder delete moves every note to the parent before removing the remaining
  tree. Failed moves roll back; the vault root is never a valid target.
- Desktop deletes use OS trash where available; native shells delete directly.

## Events

The watcher continues to emit `fs:change`; sync continues to own its progress
and live-state events; Linux theme integration continues to emit
`linux-theme-changed`. Search has no independent event/state cell—the frontend
asks the local-note store for readiness.
