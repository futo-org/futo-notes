# AGENTS.md - Shared Svelte App

Svelte 5 frontend shared across all platforms (Tauri desktop, Android, iOS, web dev).

## Architecture

- **`components/NotesShell.svelte`** (~2100 lines): Main app shell — note list, sidebar, settings, sync UI, routing.
- **`components/MarkdownEditor.svelte`**: CodeMirror 6 editor with scroll compensation for external scroll containers. See @docs/devlog.md for the scroll fix deep-dive.
- **`lib/liveMarkdownTransform.ts`**: CM6 plugin for live markdown rendering — widgets for tables, checkboxes, HR, inline images. Styling in `styles/markdown.css`.
- **`lib/platform/types.ts`**: `PlatformFS` interface — all file/search/graph operations go through this. Implementations in `platform/tauri.ts` (native) and `platform/web.ts`.
- **`lib/sync.ts`** + **`lib/syncState.ts`**: Hash-based sync client. UUID↔filename mapping, conflict detection via Rust backend.
- **`lib/supersearch/`**: Semantic search pipeline — ONNX embeddings, vector search, hybrid keyword+vector ranking.

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

## Testing

- **Playwright E2E**: `tests/*.spec.ts` — covers markdown rendering, wikilinks, image paste, search, sync.
- **Unit tests**: `src/lib/*.test.ts` — notes, search index, table widget, editor content sync.
- **Regression tests**: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting).

## Verification (Required)

| What changed | Run |
|---|---|
| Components / UI | `pnpm run build` → `pnpm run test -- <spec>` |
| lib/ logic | `pnpm run build` → `pnpm run test:unit` |
| CSS / Tailwind | `pnpm run build` → visual spot-check via screenshot or `pnpm run dev` |
| Editor behavior | Above + manual test in `pnpm run tauri:dev` (CM6 quirks don't always show in Playwright) |
