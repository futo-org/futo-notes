# Desktop Rust Adapter — Architecture and Compatibility Spec

This document fixes the intended organization of the Rust code behind the
Tauri **desktop** shell. It is an architectural contract, not a request for a
different product surface: reorganizing this crate must not add or remove
features, Tauri commands, events, serialized fields, or platform behavior.

The desktop crate is an adapter over the shared `futo-notes-*` crates. Note
domain rules, search behavior, cryptography, merge behavior, and the sync
orchestrator remain shared with the native shells; the desktop crate owns Tauri
IPC, process/application composition, desktop operating-system integration, and
translation to the stable frontend contract. → `apps/tauri/src-tauri/src/`,
`crates/futo-notes-{core,model,search,sync}`

## Naming and organization

- Module and file names state their responsibility. Do not recreate ambiguous
  catch-all modules such as the former `core.rs`, or vague top-level modules
  such as `notes.rs`, `search.rs`, `sync.rs`, and `sync_state.rs`.
- This is not a blanket ban on abbreviations. Established domain and external
  contract names remain concise: `sync` stays `sync`; the shipped `fs_*` and
  `e2ee_*` command names remain unchanged. New internal names should prefer
  complete responsibility words when an abbreviation would make ownership
  unclear.
- Files that primarily expose Tauri commands use the descriptive `_commands`
  suffix. Inside the already-scoped `sync/` directory, `tauri_commands.rs` and
  `tauri_events.rs` make the framework boundary explicit.
- `lib.rs` is only the crate module map plus the public `run()` entry.
  `application.rs` is the composition root: it configures plugins, manages the
  one application state value, installs startup services, and registers the
  complete command surface.
- Sync code lives under `src/sync/`. Its `mod.rs` is only a module map; it must
  not accumulate command implementations, orchestration, serialization, or
  event translation.

## Module ownership map

| Module | Sole responsibility |
|---|---|
| `main.rs` | Process entry; applies the Linux WebKitGTK DMA-BUF guard and calls the library `run()` function. |
| `lib.rs` | Private module declarations and the public `run()` entry. |
| `application.rs` | Tauri builder, plugins, setup hooks, managed state, and the complete `generate_handler!` list. |
| `application_state.rs` | The single desktop `AppState` aggregate. |
| `background_tasks.rs` | Shared `spawn_blocking` and named-thread boundaries plus stable join/I/O error translation. |
| `note_commands.rs` | `notes_*` scan/read/write/create/delete/rename/move adapters over `futo-notes-model`, plus the desktop note-trash command. |
| `folder_commands.rs` | Desktop folder create/rename/delete commands and subtree watcher suppression. The higher-level non-destructive move-up delete flow remains in the frontend. |
| `legacy_filesystem_commands.rs` | Compatibility-only `fs_*` note/folder commands and their legacy metadata/path semantics. It may not grow a second copy of note-domain rules. |
| `filesystem_watcher.rs` | `notify` lifecycle, event normalization, rename pairing, `fs:change`, and the shared one-shot `WatcherSuppression` service. |
| `image_commands.rs` | Image-file import and native clipboard bitmap-to-PNG persistence. |
| `search_commands.rs` | Tauri adapter and startup lifecycle for `futo-notes-search`; emits `search:status`. |
| `vault_location.rs` | The only desktop authority for environment isolation, persisted custom roots, and debug/release default vault selection. |
| `system_trash.rs` | Recoverable OS-trash deletion with the headless/unavailable-trash hard-delete fallback. |
| `updater_commands.rs` | Runtime self-update capability policy exposed to the frontend. |
| `panic_reporter.rs` | Rust panic persistence into the frontend-compatible `.crashlogs` schema. |
| `platform_integration.rs` | File-descriptor preparation, Linux log filtering/theme monitoring/decorations, and single-instance setup. |
| `sync/mod.rs` | Sync module map only. |
| `sync/tauri_commands.rs` | Stable `e2ee_*` Tauri command surface. |
| `sync/cycle_runner.rs` | Manual and live push-first cycle wiring, sync gating, progress, and watcher pre-write hooks. |
| `sync/frontend_contract.rs` | Stable JS↔Rust serialized sync inputs, outputs, summaries, failures, and rename pairs. |
| `sync/tauri_events.rs` | Translation from shared sync callbacks to stable Tauri events. |
| `sync/session_state.rs` | Tauri-managed wrapper around the shared `SyncSession` plus the abortable Tauri task handle. |

No production Rust module should independently discover or install another
state cell. `AppState` owns exactly the long-lived watcher, search, and sync
state, exposed internally as the clear field names `watcher`, `search`, and
`sync`. → `application_state.rs`, `application.rs`

## Stable Tauri IPC surface

The organizational rewrite preserves all **37** command names. These names are
an external frontend/automation contract:

- Legacy/filesystem and image: `fs_list_notes_with_meta`, `fs_save_image`,
  `fs_paste_clipboard_image`, `fs_start_watcher`, `fs_list_folders`,
  `fs_delete_folder`, `fs_move_note`.
- Vault and updater: `notes_dir_override_load`, `notes_dir_override_save`,
  `resolve_default_notes_root`, `app_self_update_supported`.
- Sync: `e2ee_connect`, `e2ee_resume`, `e2ee_disconnect`, `e2ee_status`,
  `e2ee_sync_run`, `e2ee_start_live`, `e2ee_stop_live`,
  `e2ee_note_changed`.
- Note/folder domain adapters: `notes_scan`, `notes_scan_folders`,
  `notes_seed_if_empty`, `notes_read`, `notes_exists`, `notes_write`,
  `notes_create`, `notes_delete`, `notes_rename`, `notes_move`,
  `notes_create_folder`, `notes_delete_to_trash`, `notes_rename_folder`,
  `notes_delete_folder`.
- Search: `search_query`, `search_status`, `search_rebuild`, `search_notify`.

The complete list lives in one place, `application.rs`. Moving a handler to a
different module must not rename its command or its frontend argument names.
Serialized sync field names are owned only by `sync/frontend_contract.rs` and
remain camelCase on the wire. → `application.rs`, `sync/frontend_contract.rs`,
`src/lib/platform/tauri.ts`, `src/lib/syncServiceE2ee.ts`

## Stable desktop events

The rewrite preserves all six Tauri event names and their payload roles:

- `fs:change` — `{ type, filename }`; a paired rename also includes `from`.
- `search:status` — the shared search-engine status.
- `sync:progress` — `{ phase, current, total }` for manual cycles.
- `sync:live-state` — live-stream health/status and an optional message.
- `sync:live-synced` — the full frontend `SyncSummary` projection.
- `linux-theme-changed` — the desktop theme string (`light` or `dark`).

Event translation remains at the adapter boundary. Shared crates do not depend
on Tauri event types. → `filesystem_watcher.rs`, `search_commands.rs`,
`sync/cycle_runner.rs`, `sync/tauri_events.rs`, `platform_integration.rs`

## Command and blocking boundaries

- Tauri command functions are asynchronous. Filesystem-heavy work runs through
  `background_tasks::blocking`, which uses Tauri's blocking runtime rather than
  blocking the webview/runtime worker. Shared async network/sync operations
  remain async instead of being wrapped in filesystem worker threads.
- Filesystem commands return `Result<T, String>` and translate a failed blocking
  task with the existing `join error: …` prefix. The pure updater capability
  query is the intentional boolean-returning exception.
- Command modules keep testable pure or filesystem-level implementation
  functions underneath the Tauri boundary. The command resolves managed state
  and the vault root, then delegates to the implementation.
- Note rules and filesystem-safe note paths are delegated to
  `futo-notes-model` / `futo-notes-core`; desktop adapters do not reimplement
  title, tag, preview, wikilink, collision, or note-ID rules.

## Watcher behavior and self-write suppression

- The desktop watcher recursively watches the resolved vault and emits only
  note-facing `.md` / legacy `.txt` changes. Hidden files or any path beneath a
  hidden component are ignored; image files do not emit `fs:change`.
- Event paths are stripped against both the canonical and raw vault-root
  spellings. This covers macOS canonical event paths and Linux registered-path
  event paths without losing changes behind a symlinked spelling.
- File creates, content modifications, and removals map to `add`, `change`, and
  `unlink`. Metadata-only modifications are ignored.
- Rename `From`/`To` events are paired by the OS tracker cookie. A paired rename
  emits one `rename` event. An unmatched `From` older than 500 ms is emitted as
  `unlink`; an unmatched `To` is emitted as `add`.
- Every Rust-owned note-tree mutation registers every watcher-visible relative
  path **before** touching disk. This covers note writes/creates/deletes/trash,
  renames/moves, first-run seeding, folder subtree mutations, legacy commands,
  and sync apply hooks.
- Suppression entries expire after five seconds but are one-shot: the first
  matching watcher echo removes the entry. A later external edit inside the
  original five-second window is therefore delivered normally.
- A rename is suppressed atomically only when both its old and new paths are
  registered; consuming a partially registered pair would hide only half the
  operation.
- Collision-resolved create/rename/move operations pre-register the planned
  final path and also register the actual result if a concurrent external
  writer changes the collision outcome.
- Folder rename registers every `.md` and `.txt` source and destination path in
  the subtree. Folder delete registers every `.md` and `.txt` path being
  removed. These walks inspect names only and do not parse note bodies.
- Sync manual/live cycles pass the same suppression service as the
  orchestrator's `pre_write` hook. → `filesystem_watcher.rs`,
  `note_commands.rs`, `folder_commands.rs`, `sync/cycle_runner.rs`

## Legacy compatibility rules

The `fs_*` commands remain because released frontend builds, test automation,
or external callers may still invoke them. They are compatibility adapters,
not a second preferred API.

- `fs_list_notes_with_meta` performs a metadata-only recursive filesystem walk.
  It does not read or parse note contents. It returns visible lowercase-`.md`
  paths with `mtimeMs` and `sizeBytes`, does not follow symlinks, respects the
  shared folder-depth bound, skips hidden entries, normalizes separators to
  `/`, and sorts by modification time descending.
- `fs_list_folders` recursively returns visible folders in lexicographic order,
  skips hidden entries and symlinks, normalizes separators, and preserves the
  legacy depth bound.
- `fs_delete_folder` preserves the strict legacy path validator: empty,
  absolute, trailing-slash, empty-component, `.`, `..`, traversal, and
  over-depth inputs are rejected rather than sanitized into a different target.
- `fs_move_note` is an exact old-ID→new-ID move. A missing source or existing
  destination is an error; it does not collision-suffix the destination.
- Legacy delete/move commands delegate to the same trash, path-safety, and
  watcher-suppression services as the modern commands.

## Vault and desktop safety boundaries

- `vault_location.rs` is the only desktop module allowed to select the vault.
  Other modules request the resolved root; they do not inspect environment,
  Tauri paths, or override files independently.
- With `FUTO_NOTES_DATA_DIR`, the default vault is
  `<FUTO_NOTES_DATA_DIR>/notes` and the persisted override file is isolated
  under the same data directory.
- Without that environment override, debug builds default to
  `~/Documents/fake-notes` and release builds default to
  `~/Documents/futo-notes`. This split is a critical real-data safety guard.
- A valid persisted custom vault overrides the default. The
  `resolve_default_notes_root` command intentionally returns the default rather
  than the persisted custom selection. Resolving the active root creates it if
  necessary.
- Desktop note/folder trash operations first use the operating system's trash.
  If trash is unavailable (for example, headless CI), they fall back to the
  matching hard file/directory deletion.
- Rust panics are written under `<vault>/.crashlogs/` using the same JSON field
  schema consumed by the frontend crash reporter on next launch.

## Sync adapter boundary

- The desktop `sync/` directory contains adapter wiring only. Encryption,
  protocol behavior, persistence/migration, object-map semantics, conflict
  handling, push-first ordering, and live-loop behavior stay in
  `futo-notes-sync`.
- Manual and live cycles share the `SyncSession` gate so concurrent cycles
  cannot race or regress the persisted cursor.
- `frontend_contract.rs` is the one serialized desktop projection. Cycle and
  event code consume it rather than defining similar wire structs elsewhere.
- `tauri_events.rs` distinguishes a stream failure (`live: false`) from a cycle
  failure on a healthy stream (`live: true`).
- Disconnect stops the live task, clears the in-memory connected session, and
  demotes persisted state to ancestry so reconnect can retain safe object/hash
  lineage. → [sync.md](sync.md), `sync/*`, `futo-notes-sync`

## Search, updater, and platform boundaries

- Search startup is launched off the application setup path. Until the Rust
  engine is installed, search commands return the existing empty/default status
  that lets the frontend use its MiniSearch fallback. → [search.md](search.md),
  `search_commands.rs`
- `app_self_update_supported` returns false in debug Rust builds. In release it
  returns true for macOS and Windows, and for Linux only when `APPIMAGE` is
  present. The frontend may separately force-show its fake/manual dev surface.
  → [settings.md](settings.md), `updater_commands.rs`
- Linux log filtering, theme monitoring, decorations, and Unix file-descriptor
  preparation stay out of application composition in
  `platform_integration.rs`.

## Unit-test layout

- Desktop unit tests live inline at the bottom of their owning production file
  in `#[cfg(test)] mod tests { … }`.
- Do not create JavaScript-style `*.test.rs` files, per-module `tests.rs`
  directories, or a central `src/unit_tests/` tree for these private adapter
  tests. IDE folding may hide inline test modules while navigating production
  code.
- Inline placement preserves direct access to private implementation functions
  without widening visibility or adding `#[path]` indirection.
- Crate-level `tests/` integration tests remain appropriate for public
  cross-crate contracts; they do not replace the private desktop adapter tests.

## Dependency boundary

The desktop crate declares only dependencies used by the adapter. Domain-heavy
dependencies belong in the shared crates that own their behavior. The rewrite
removed unused direct desktop dependencies on `rand`, `rand_chacha`, `rayon`,
`sha2`, `filetime`, `walkdir`, `reqwest`, `url`, and `thiserror`; do not re-add
them merely to duplicate behavior already available through a shared crate.
