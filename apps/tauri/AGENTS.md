# AGENTS.md - Stonefruit Tauri App

Tauri v2 desktop + mobile shell. Rust backend with file I/O, local search helpers, and platform integration. Svelte frontend served from monorepo root `src/`.

**Stack**: Rust + Tauri v2 + serde. Plugins: dialog, process, clipboard-manager, opener, single-instance (desktop), mcp-bridge (debug).

From the monorepo root, prefer the `just` wrappers for the common Tauri flows: `just tauri-dev`, `just tauri-prod`, `just tauri-build`, `just android-dev`, `just ios-dev`, and `just test-rust`.

## Architecture

- **`core.rs`**: Native business logic — file I/O, sync delta apply helpers, keyword search, engagement tracking. Every public Tauri command wraps an `_impl` function for testability. Imports file operations and hashing directly from `stonefruit-core` — do not add wrapper functions.
- **`lib.rs`**: App setup — plugin registration, platform-specific init (iOS safe-area, Linux GTK decorations, fd limit bump).
- **`main.rs`**: Entry point. Disables WebKitGTK DMA-BUF renderer on Linux for Wayland stability.

Graph/server semantic search is disabled during the E2EE server migration.

## Key Patterns

- **Atomic writes**: All note writes go through `write_atomic_text()` (temp file + rename) for crash safety.
- **Path safety**: `ensure_safe_note_id()` (from `stonefruit_core::files`) blocks `..`, `.`, `/`, `\` — never bypass this for user-supplied paths.
- **Filesystem watcher**: `notify` crate watches notes dir for external edits, emits `note_changed` events. Sync writes suppress watcher events for 5s to avoid loops.
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

- `await window.__testSync.connectE2ee(serverUrl, email, name, password)`
- `await window.__testSync.status()`
- `await window.__testSync.syncE2ee(password)`
- `await window.__testSync.disconnectE2ee()`

Notes:
- Desktop dev server URLs use `127.0.0.1`
- Android emulator must use `10.0.2.2` for host services
- `connectE2ee()` clears E2EE cached state first so sync state does not bleed across backend switches
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
| Rust logic (`core.rs`, graph) | `just test-rust` |
| New `#[tauri::command]` | Add unit test for `_impl` function, then `just test-rust` |
| Tauri config / capabilities | `just tauri-dev` → manual smoke test |
| Mobile-specific code | Build + deploy to device, check `adb logcat` (Android) or Xcode logs (iOS) |

## Constraints

- **`window.confirm()`/`window.alert()` don't work in Tauri's webview.** Use `ask()`/`message()` from `@tauri-apps/plugin-dialog`.
- **Single-instance** (desktop only): second launch focuses the existing window. Kill stale processes when testing binary swaps.
- **iOS**: `objc2` used for safe-area insets and edge-to-edge webview. `disableInputAccessoryView: true` removes keyboard bar.
- **Android**: Camera + Internet permissions declared. Uses `TAURI_DEV_HOST` for remote dev.
