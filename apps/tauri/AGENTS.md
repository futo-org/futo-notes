# AGENTS.md - FUTO Notes Tauri App

Tauri v2 desktop + mobile shell. Thin Rust backend for performance-critical operations; most app logic is in the shared Svelte/TS layer (`src/`).

**Stack**: Rust + Tauri v2 + serde. Plugins: dialog, process, clipboard-manager, opener, fs, single-instance (desktop), mcp-bridge (debug).

From the monorepo root, prefer the `just` wrappers: `just tauri-dev`, `just tauri-prod`, `just tauri-build`, `just android-dev`, `just ios-dev`, and `just test-rust`.

## Architecture

**New features should be in TypeScript unless they are compute-heavy or need OS-level access** (see root AGENTS.md "TypeScript First"). The Rust-to-TypeScript migration moved most file I/O, note indexing, app config, and engagement tracking to TypeScript (`src/lib/`). What remains in Rust is what benefits from native performance or OS-level access:

- **`core.rs`**: 14 Tauri commands — sync payload prep/apply (wraps `futo-notes-core`), filesystem watcher (`notify` crate), supersearch vector operations (download, query, per-note vectors), image save/paste, notes-dir override, and default path resolution. Every public command wraps an `_impl` function for testability.
- **`lib.rs`**: App setup — plugin registration, platform-specific init (iOS safe-area, Linux GTK decorations, fd limit bump).
- **`main.rs`**: Entry point. Disables WebKitGTK DMA-BUF renderer on Linux for Wayland stability.

TypeScript handles: note CRUD (`src/lib/notes.ts`), note index (`src/lib/notesIndex.ts`), app state/preferences (`src/lib/appState.ts`), search indexing (`src/lib/searchIndex.ts`), sync coordination (`src/lib/syncManager.svelte.ts`), and all file I/O via `@tauri-apps/plugin-fs` with atomic writes (`src/lib/platform/atomicWrite.ts`).

## Key Patterns

- **Atomic writes**: Both Rust (`write_atomic_text()` in core.rs) and TypeScript (`atomicWrite.ts`) use temp file + rename for crash safety. New file I/O should use the TS path unless there's a performance reason for Rust.
- **Path safety**: Rust has `ensure_safe_note_id()` (from `futo_notes_core::files`); TypeScript has `pathSafety.ts`. Both block `..`, `.`, `/`, `\` — never bypass for user-supplied paths.
- **Filesystem watcher**: `notify` crate in Rust watches notes dir for external edits, emits `note_changed` events. Sync writes suppress watcher events for 5s to avoid loops.
- **Platform configs**: `#[cfg(target_os = "...")]` and `#[cfg(debug_assertions)]` for platform/build-specific behavior.

## Dev Ports (avoid collisions)

| Target | Port | Command |
|---|---|---|
| Desktop | 5180 | `just tauri-dev` |
| Android | 5181 | `just android-dev` |
| iOS | 5182 | `just ios-dev` |

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
just android-dev     # Android dev
just ios-dev         # iOS dev
```

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
