# AGENTS.md - Stonefruit Tauri App

Tauri v2 desktop + mobile shell. Rust backend with all file I/O, sync, search, and graph logic. Svelte frontend served from monorepo root `src/`.

**Stack**: Rust + Tauri v2 + serde. Plugins: dialog, process, clipboard-manager, opener, single-instance (desktop), mcp-bridge (debug).

## Architecture

- **`core.rs`** (~2800 lines): All business logic — file I/O, sync payload prep/apply, keyword search, semantic search (vector download + query), image sync, engagement tracking. Every public Tauri command wraps an `_impl` function for testability.
- **`graph_positions.rs`**: UMAP-like layout for note graph visualization (kNN → fuzzy simplicial set → SGD optimization).
- **`graph_clusters.rs`**: K-Means clustering with heuristic cluster count (3–12 based on note count).
- **`lib.rs`**: App setup — plugin registration, platform-specific init (iOS safe-area, Linux GTK decorations, fd limit bump).
- **`main.rs`**: Entry point. Disables WebKitGTK DMA-BUF renderer on Linux for Wayland stability.

## Key Patterns

- **Atomic writes**: All note writes go through `write_atomic_text()` (temp file + rename) for crash safety.
- **Path safety**: `ensure_safe_note_id()` blocks `..`, `.`, `/`, `\` — never bypass this for user-supplied paths.
- **Filesystem watcher**: `notify` crate watches notes dir for external edits, emits `note_changed` events. Sync writes suppress watcher events for 5s to avoid loops.
- **Lazy vector loading**: Semantic search artifacts are downloaded on demand from the server, cached in app data.
- **Platform configs**: `#[cfg(target_os = "...")]` and `#[cfg(debug_assertions)]` for platform/build-specific behavior.

## Dev Ports (avoid collisions)

| Target | Port | Command |
|---|---|---|
| Desktop | 5180 | `pnpm run tauri:dev` |
| Android | 5181 | `pnpm run tauri:android:dev` |
| iOS | 5182 | `pnpm run tauri:ios:dev` |

## Building & Testing

```bash
pnpm run tauri:dev          # Desktop dev (Wayland-first)
pnpm run tauri:build        # Production desktop build
pnpm run tauri:test:rust    # Rust unit tests (creates dist/ first)
pnpm run tauri:android:dev  # Android dev
pnpm run tauri:ios:dev      # iOS dev
```

`test:rust` requires `dist/` to exist (Tauri build system expects it). The script creates it automatically.

## Verification (Required)

| What changed | Run |
|---|---|
| Rust logic (`core.rs`, graph) | `pnpm run tauri:test:rust` |
| New `#[tauri::command]` | Add unit test for `_impl` function, then `pnpm run tauri:test:rust` |
| Tauri config / capabilities | `pnpm run tauri:dev` → manual smoke test |
| Mobile-specific code | Build + deploy to device, check `adb logcat` (Android) or Xcode logs (iOS) |

## Constraints

- **`window.confirm()`/`window.alert()` don't work in Tauri's webview.** Use `ask()`/`message()` from `@tauri-apps/plugin-dialog`.
- **Single-instance** (desktop only): second launch focuses the existing window. Kill stale processes when testing binary swaps.
- **iOS**: `objc2` used for safe-area insets and edge-to-edge webview. `disableInputAccessoryView: true` removes keyboard bar.
- **Android**: Camera + Internet permissions declared. Uses `TAURI_DEV_HOST` for remote dev.
