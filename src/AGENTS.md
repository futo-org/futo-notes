# AGENTS.md - Shared Svelte App

Svelte 5 frontend shared across all platforms (Tauri desktop, Android, iOS, web dev).

From the monorepo root, prefer `just build`, `just tauri-dev`, `just test-unit`, and `just check` for the standard workflows.

## Architecture

- **`components/NotesShell.svelte`**: Main app shell — note list, sidebar, settings, sync UI, routing.
- **`components/MarkdownEditor.svelte`**: CodeMirror 6 editor with scroll compensation for external scroll containers. See @docs/devlog.md for the scroll fix deep-dive.
- **`lib/liveMarkdownTransform.ts`**: CM6 plugin for live markdown rendering — widgets for tables, checkboxes, HR, inline images. Styling in `styles/markdown.css`.
- **`lib/platform/`**: Platform abstraction layer. `types.ts` defines `PlatformFS` interface; `tauri.ts` (native) and `web.ts` (dev/test) implement it. `atomicWrite.ts` provides crash-safe temp+rename writes. `pathSafety.ts` validates paths against traversal attacks. `tauriPaths.ts` resolves notes root and overrides.
- **`lib/notes.svelte.ts`**: Reactive note state. Holds `notesCache` (the single source of truth for the sidebar) and the CRUD wrappers. Reads come from the Rust `notes_scan` command (mapped `NoteMeta[] → NotePreview[]`); mutations update the cache optimistically and write through the `notes_*` commands. The note domain (CRUD, rules, scan, search) lives in the `futo-notes-model` Rust crate, not in TS — see root AGENTS.md "Where Logic Lives".
- **`lib/syncServiceE2ee.ts`** + **`lib/syncManager.svelte.ts`**: E2EE sync client. `syncServiceE2ee` handles encryption and the external server API; `syncManager` coordinates sync lifecycle (auto-sync, idle detection, connectivity).
- **`lib/autoSyncV2.ts`**: E2EE auto-sync with debounce, idle detection, and manual trigger via `requestSyncV2()`.

## Key Constraints

- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **Svelte 5 reactivity**: Use `$state()` runes, not stores. Read `scrollParent` and `onchange` lazily inside callbacks (not in `$effect` body) to avoid tracking them as dependencies — prevents editor destruction/recreation.
- **Editor responsiveness is sacred.** Never let background operations (sync, search indexing, save) block or delay typing.
- **Image preloading**: Editor preloads image dimensions for CM6 widget sizing. Images served via Tauri asset protocol (`asset://`).

## Common Patterns

- **Adding markdown elements**: Edit `liveMarkdownTransform.ts` (processing) + `markdown.css` (styling). Test with `tests/gfm-test-note.md`.
- **Theme tokens**: `src/styles/app.css` → `@theme` block (primary, text, border, surface, muted, bg).
- **Platform-specific behavior**: Implement in `PlatformFS` interface, never branch on platform in components.
- **Search**: Full-text search is owned solely by the shared Rust `futo-notes-search` engine (Tantivy BM25, reached via `search_query`/`search_status`/`search_rebuild`/`search_notify`). During its brief startup reconcile, the UI may filter the already-loaded note metadata; it must not build, persist, or maintain a second body index in JavaScript. Synchronous wikilink completion filters note IDs from `notesCache`.

## Tauri MCP Shortcuts

Use `webview-execute-js` against the live app and call:

- `await window.__testSync.connect('http://127.0.0.1:3100', 'testing123')` on desktop
- `await window.__testSync.status()`
- `await window.__testSync.syncNow()`
- `await window.__testSync.disconnect()`

## Testing

- **Playwright E2E**: `tests/*.spec.ts` — covers markdown rendering, wikilinks, image paste, search, sync.
- **Markdown spec + cursor movement**: `tests/markdown-spec.spec.ts` reads `markdown-spec/cases/**`; use it for cursor-reveal and wrapped-line navigation regressions.
- **Unit tests**: `src/lib/*.test.ts` — notes, search index, sync, platform modules, table widget, editor content sync.
- **Regression tests**: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting).

## Verification (Required)

| What changed | Run |
|---|---|
| Components / UI | `just build` → `pnpm run test -- <spec>` |
| lib/ logic | `just build` → `just test-unit` |
| CSS / Tailwind | `just build` → visual spot-check via screenshot |
| Editor behavior | Above + manual test in `just tauri-dev` (CM6 quirks don't always show in Playwright) |
