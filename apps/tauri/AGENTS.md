# AGENTS.md - FUTO Notes Tauri App

Tauri v2 **desktop** shell. This is the **Tauri adapter**: a Rust backend that exposes the shared note domain (CRUD, rules, search, sync) to the Svelte UI via `#[tauri::command]`s, plus OS-level glue. The shared Svelte/TS layer (`src/`) owns the UI and reactive state and calls in. The Tauri mobile shell is retired — mobile ships as native SwiftUI/Compose in `apps/ios` / `apps/android`; see root AGENTS.md.

**Stack**: Rust + Tauri v2 + serde. Plugins: dialog, process, clipboard-manager, opener, fs, single-instance (desktop), mcp-bridge (debug).

From the monorepo root, prefer the `just` wrappers: `just tauri-dev`, `just tauri-prod`, `just tauri-build`, and `just test-rust`. (Mobile is native: `just ios-native` / `just android-native` / `just deploy-ios`.)

## Architecture

**The local note engine lives in Rust.** `futo-notes-model` owns pure decisions; `futo-notes-store` owns the durable vault, migrations, note/folder workflows, backlink repair, and search lifecycle. Tauri and UniFFI are projections of that same store. TypeScript owns presentation state but never reimplements a workflow.

`lib.rs` is only the crate map and public `run()` entry. `application.rs` is the composition root: it registers plugins, manages one `AppState`, installs startup services, and declares the complete `generate_handler!` surface. Long-lived note-store, watcher, and sync state are fields of `AppState`; commands never discover or manage independent state cells.

The desktop adapter is split by responsibility:

- **`local_notes.rs`**: the complete `local_notes_*` projection over one `LocalNoteStore`, including desktop trash policy.
- **`sync/`**: `mod.rs` is only the module map. `tauri_commands.rs` owns the stable `e2ee_*` command surface, `cycle_runner.rs` wires manual/live push-first cycles, `frontend_contract.rs` owns serialization, `tauri_events.rs` translates callbacks, and `session_state.rs` bridges session/task state.
- **`vault_location.rs`**: the only authority for environment overrides, persisted custom roots, and the CRITICAL debug (`fake-notes`) / release (`futo-notes`) default split.
- **`filesystem_watcher.rs`**: `notify` lifecycle, rename-cookie pairing, relative-path normalization, `fs:change` emission, and the typed one-shot `WatcherSuppression` service shared by note/folder/sync commands.
- **`image_commands.rs`**: image file import and native clipboard-to-PNG ingestion.
- **`system_trash.rs`**: recoverable desktop delete policy plus the headless hard-delete fallback.
- **`platform_integration.rs`**: Linux log/theme/decorations, single-instance setup, and Unix file-descriptor preparation.
- **`updater_commands.rs`**, **`panic_reporter.rs`**: updater capability and Rust crash persistence.
- **`background_tasks.rs`**: the shared `spawn_blocking`/thread boundary and uniform join/I/O error mapping.
- **`main.rs`**: process entry point; disables WebKitGTK DMA-BUF on Linux before calling `run()`.

Unit tests live inline at the bottom of their owning module in a `#[cfg(test)] mod tests { ... }` block. This keeps private `_impl` functions directly testable without adding test-only directories; IDE folding can hide the blocks when navigating production code.

TypeScript handles reactive note projection state, preferences, and sync coordination. Note/folder/search calls go through `localNoteStore.ts` to `local_notes_*`; there is no plugin-fs or client-index path for notes.

## Key Patterns

- **Atomic writes**: `LocalNoteStore` uses `futo_notes_core::files::write_atomic_text()` (flushed same-directory temp + rename). TypeScript does not write Markdown.
- **Path safety**: pushed DOWN into the crates — `futo_notes_core::files::safe_note_path` and `futo-notes-model`'s folder primitives. Desktop code resolves the vault only through `vault_location.rs`; compatibility commands may not hand-build paths. TypeScript has `pathSafety.ts` for paths it forms before a command call.
- **Filesystem watcher**: `filesystem_watcher.rs` watches the vault for external edits and emits `fs:change`. The store's `BeforeWrite` projection registers every affected path before the first filesystem syscall. Suppression is one-shot, so it cannot hide a later external edit inside the five-second expiry window.
- **Platform configs**: `#[cfg(target_os = "...")]` and `#[cfg(debug_assertions)]` for platform/build-specific behavior.

## Dev Ports

| Target | Port | Command |
|---|---|---|
| Desktop | 5180 | `just tauri-dev` |

(Mobile is native now — see `apps/ios` / `apps/android` and root AGENTS.md.)

## Tauri MCP

Debug builds include the MCP bridge. Prefer `webview-execute-js` for deterministic automation over brittle UI clicking when possible.

For sync server switching, use the dev-only webview hook:

- `await window.__testSync.connect(serverUrl, password)` — password-mode login
- `await window.__testSync.connectE2ee(serverUrl, password)` — alias, same behavior
- `await window.__testSync.status()`
- `await window.__testSync.syncNow()` / `syncE2ee(password)`
- `await window.__testSync.disconnect()` / `disconnectE2ee()`

Notes:
- Desktop dev server URLs use `127.0.0.1`
- `connect()` and `connectE2ee()` clear cached E2EE state first so sync state does not bleed across backend switches
- The same test hooks are available in debug builds created with `VITE_INCLUDE_TEST_HOOKS=true`, which is how `just test-cross-platform` drives the app

## Building & Testing

```bash
just tauri-dev       # Desktop dev (Wayland-first)
just tauri-prod      # Production-config desktop dev
just tauri-build     # Production desktop build
just test-rust       # Rust unit tests (creates dist/ first)
```

(Mobile builds are native: `just ios-native` / `just android-native` / `just deploy-ios` — see root AGENTS.md.)

`test:rust` requires `dist/` to exist (Tauri build system expects it). The script creates it automatically.

## Verification (Required)

| What changed | Run |
|---|---|
| Desktop adapter logic (`apps/tauri/src-tauri/src`) | `cargo test -p futo-notes-tauri --lib` + `just test-rust-full` |
| New `#[tauri::command]` | Add unit test for `_impl` function, then `just test-rust` |
| Tauri config / capabilities | `just tauri-dev` → manual smoke test |

## Constraints

- **`window.confirm()`/`window.alert()` don't work in Tauri's webview.** Use `ask()`/`message()` from `@tauri-apps/plugin-dialog`.
- **Single-instance** (desktop only): second launch focuses the existing window. Kill stale processes when testing binary swaps.
