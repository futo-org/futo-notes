# AGENTS.md - FUTO Notes Tauri App

Tauri v2 **desktop** shell. This is the **Tauri adapter**: a Rust backend that exposes the shared note domain (CRUD, rules, search, sync) to the Svelte UI via `#[tauri::command]`s, plus OS-level glue. The shared Svelte/TS layer (`src/`) owns the UI and reactive state and calls in. (The Tauri *mobile* shell is retired — mobile ships as native SwiftUI/Compose in `apps/ios` / `apps/android`; see root AGENTS.md. The iOS/Android `cfg` code below still exists in-tree but is no longer built via `just`.)

**Stack**: Rust + Tauri v2 + serde. Plugins: dialog, process, clipboard-manager, opener, fs, single-instance (desktop), mcp-bridge (debug).

From the monorepo root, prefer the `just` wrappers: `just tauri-dev`, `just tauri-prod`, `just tauri-build`, and `just test-rust`. (Mobile is native: `just ios-native` / `just android-native` / `just deploy-ios`.)

## Architecture

**The note domain lives in Rust.** CRUD, the note rules (title/tag/id/wikilink/preview), and full-text search are single-sourced in `futo-notes-model` / `futo-notes-core` / `futo-notes-search` — the same crates the native iOS/Android shells consume via the `futo-notes-ffi` UniFFI facade (see root AGENTS.md "Where Logic Lives"). Do not re-implement CRUD or search in TypeScript; call the commands. (The note rules are shared from `futo-notes-model` via the conformance-locked TS copy `src/lib/rules.ts` / the FFI facade rather than a Tauri command — see root AGENTS.md.) **TypeScript owns the UI and reactive state** (Svelte components, `notesCache` in `notes.svelte.ts`, tab/session state, sync coordination, the platform shell). Reserve net-new Rust for the note domain and existing compute-heavy paths.

The command surface (registered in `lib.rs` via `tauri::generate_handler!`) is split by module:

- **`notes.rs`**: `notes_*` — note CRUD + scanning over `futo-notes-model::crud` (`notes_scan`, `notes_read`, `notes_write`, `notes_create`, `notes_delete`, `notes_rename`, `notes_move`, folder ops, trash). Mirrors the FFI `NoteStore` 1:1.
- **`search.rs`**: `search_*` — desktop shim over `futo-notes-search` (Tantivy BM25 + SPLADE, background indexer, RRF fusion). The heavy lifting lives in the crate; this layer resolves paths, emits `search:status`, and exposes the commands. (Supersearch vector ops are gone — replaced by this engine.)
- **`sync.rs`** / **`sync_state.rs`**: `e2ee_*` — the E2EE sync command surface over `futo-notes-sync`, plus the JS↔Rust state and watcher-suppression map.
- **`core.rs`**: the remaining `fs_*` / path / device commands — filesystem watcher (`notify` crate, emits `fs:change`), image save/paste, folder ops not yet on the model, notes-dir override, default path resolution, soft-keyboard/haptics. Every public command wraps an `_impl` function for testability.
- **`lib.rs`**: App setup — plugin registration, the `tauri::generate_handler!` `invoke_handler`, platform-specific init (iOS safe-area, Linux GTK decorations, fd limit bump).
- **`main.rs`**: Entry point. Disables WebKitGTK DMA-BUF renderer on Linux for Wayland stability.

TypeScript handles: reactive note state (`notes.svelte.ts`, `notesCache`), app state/preferences (`src/lib/appState.ts`), sync coordination (`src/lib/syncManager.svelte.ts`), and the search shim (`src/lib/searchEngine.ts`, which prefers the Rust engine and falls back to the live MiniSearch keyword index in `src/lib/searchIndex.ts`). Note I/O goes through the `notes_*` commands rather than `@tauri-apps/plugin-fs`.

## Key Patterns

- **Atomic writes**: Note writes go through `notes_write`, which uses `write_atomic_text()` (`futo_notes_core::files`) — temp file + rename for crash safety. The TS `atomicWrite.ts` helper remains for the rare non-note file the TS layer still writes directly.
- **Path safety**: pushed DOWN into the crate — `futo_notes_core::files::safe_note_path` (used by `notes.rs`/`core.rs`) and `futo-notes-model`'s folder-path validation block `..`, `.`, `/`, `\`. TypeScript has `pathSafety.ts` for any path it forms before a command call. Never bypass for user-supplied paths.
- **Filesystem watcher**: `notify` crate in Rust watches the notes dir for external edits and emits `fs:change` events; the Svelte store re-reads via command. Sync/note writes register the touched filename in the watcher-suppression map for 5s (`WATCHER_SUPPRESSION_MS`) so a Rust-driven write doesn't loop back as an external change.
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
- Android emulator must use `10.0.2.2` for host services
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
| Rust logic (`core.rs`) | `just test-rust` |
| New `#[tauri::command]` | Add unit test for `_impl` function, then `just test-rust` |
| Tauri config / capabilities | `just tauri-dev` → manual smoke test |
| Mobile-specific code | Build + deploy to device, check `adb logcat` (Android) or Xcode logs (iOS) |

## Constraints

- **`window.confirm()`/`window.alert()` don't work in Tauri's webview.** Use `ask()`/`message()` from `@tauri-apps/plugin-dialog`.
- **Single-instance** (desktop only): second launch focuses the existing window. Kill stale processes when testing binary swaps.
- **iOS**: `objc2` used for safe-area insets and edge-to-edge webview. `disableInputAccessoryView: true` removes keyboard bar.
- **Android**: Camera + Internet permissions declared. Uses `TAURI_DEV_HOST` for remote dev.
