# AGENTS.md - Shared Svelte App

Svelte 5 frontend shared across all platforms (Tauri desktop, Android, iOS, web dev).

From the monorepo root, prefer `just build`, `just tauri-dev`, `just test-unit`, and `just check` for the standard workflows.

## Architecture

- **`components/NotesShell.svelte`**: Main app shell — note list, sidebar, settings, sync UI, routing.
- **`components/MarkdownEditor.svelte`**: CodeMirror 6 editor with scroll compensation for external scroll containers. See @docs/devlog.md for the scroll fix deep-dive.
- **`lib/liveMarkdownTransform.ts`**: CM6 plugin for live markdown rendering — widgets for tables, checkboxes, HR, inline images. Styling in `styles/markdown.css`.
- **`lib/platform/types.ts`**: `PlatformFS` interface — all file/search/graph operations go through this. Implementations in `platform/tauri.ts` (native) and `platform/web.ts`.
- **`lib/syncServiceV2.ts`** + **`lib/syncManager.svelte.ts`**: V2 hash-based sync client. `syncServiceV2` handles the HTTP sync protocol, `syncManager` coordinates sync lifecycle (auto-sync, idle detection, connectivity).
- **`lib/autoSyncV2.ts`**: Polling-based auto-sync with debounce, idle detection, and manual trigger via `requestSyncV2()`.
- **`lib/supersearch/`**: Server-side semantic search client — downloads vector artifacts from server, hybrid keyword+vector ranking.

## Key Constraints

- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **Svelte 5 reactivity**: Use `$state()` runes, not stores. Read `scrollParent` and `onchange` lazily inside callbacks (not in `$effect` body) to avoid tracking them as dependencies — prevents editor destruction/recreation.
- **Editor responsiveness is sacred.** Never let background operations (sync, search indexing, save) block or delay typing. See memory: `feedback_typing_sacred.md`.
- **Image preloading**: Editor preloads image dimensions for CM6 widget sizing. Images served via Tauri asset protocol (`asset://`).

## Common Patterns

- **Adding markdown elements**: Edit `liveMarkdownTransform.ts` (processing) + `markdown.css` (styling). Test with `tests/gfm-test-note.md`.
- **Theme tokens**: `src/styles/app.css` → `@theme` block (primary, text, border, surface, muted, bg).
- **Platform-specific behavior**: Implement in `PlatformFS` interface, never branch on platform in components.
- **Search**: Client-side keyword search (MiniSearch, always available) + server-side semantic search (optional). Combined in `supersearch/hybridSearch.ts`.
- **Debug sync automation**: In dev builds and `VITE_INCLUDE_TEST_HOOKS=true` builds, `window.__testSync` is available for MCP-driven server switching and sync control. Prefer it over clicking through Settings when testing Tauri apps.

## Tauri MCP Shortcuts

Use `webview-execute-js` against the live app and call:

- `await window.__testSync.connect('http://127.0.0.1:3005', 'testing123')` on desktop
- `await window.__testSync.connect('http://10.0.2.2:3005', 'testing123')` on Android emulator
- `await window.__testSync.status()`
- `await window.__testSync.syncNow()`
- `await window.__testSync.disconnect()`

## Testing

- **Playwright E2E**: `tests/*.spec.ts` — covers markdown rendering, wikilinks, image paste, search, sync.
- **Markdown spec + cursor movement**: `tests/markdown-spec.spec.ts` reads `markdown-spec/cases/**`; use it for cursor-reveal and wrapped-line navigation regressions.
- **Unit tests**: `src/lib/*.test.ts` — notes, search index, table widget, editor content sync.
- **Regression tests**: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting).

## Verification (Required)

| What changed | Run |
|---|---|
| Components / UI | `just build` → `pnpm run test -- <spec>` |
| lib/ logic | `just build` → `just test-unit` |
| CSS / Tailwind | `just build` → visual spot-check via screenshot |
| Editor behavior | Above + manual test in `just tauri-dev` (CM6 quirks don't always show in Playwright) |
