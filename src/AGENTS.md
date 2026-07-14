# AGENTS.md - Shared Svelte App

Svelte 5 frontend shared across all platforms (Tauri desktop, Android, iOS, web dev).

From the monorepo root, prefer `just build`, `just tauri-dev`, `just test-unit`, and `just check` for the standard workflows.

## Architecture

- **`app/`** owns application composition, routing, bootstrap, and native-shell wiring. `App.svelte` and `main.ts` are thin framework entry points.
- **`features/`** owns complete capabilities. Components, reactive state, boundary shims, and tests stay with the feature that changes them.
- **`features/editor/`** owns the CodeMirror editor, live preview, toolbar behavior, links, images, and editor UX extensions.
- **`features/notes/`** owns reactive note projection state. `notes.svelte.ts` holds `notesCache`, applies committed `LocalNoteMutation` results, and never predicts collision, relink, migration, or search behavior.
- **`features/sync/`** owns the E2EE client, sync lifecycle, watcher batching, write suppression, and external-change coordination.
- **`features/search/`** owns search presentation. The Rust local-note store owns the sole BM25 lifecycle.
- **`features/images/`** owns image-file listing, deletion, and renderable vault URLs; sidebar and editor consume that boundary.
- **`lib/platform/`** is the platform boundary. Components and features use `PlatformFS`; native command details stay in the Tauri adapter.
- **`shared/`** contains small, genuinely cross-feature contracts and named capabilities for async work, dialogs, DOM behavior, media rules, notifications, persisted state, and time formatting.
- **`editor-embed/`** is the native web-editor boundary and implements the versioned `futoBridge` contract.

## Key Constraints

- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **Svelte 5 reactivity**: Use `$state()` runes, not stores. Read `scrollParent` and `onchange` lazily inside callbacks (not in `$effect` body) to avoid tracking them as dependencies — prevents editor destruction/recreation.
- **Editor responsiveness is sacred.** Never let background operations (sync, search indexing, save) block or delay typing.
- **Image preloading**: Editor preloads image dimensions for CM6 widget sizing. Images served via Tauri asset protocol (`asset://`).

## Common Patterns

- **Adding markdown elements**: Put traversal in `features/editor/live-preview/buildLiveMarkdownDecorations.ts`, element-specific processing in the matching `live-preview/*Decorations.ts` module, and styling in the matching `styles/markdown-*.css` capability file. Keep `liveMarkdownTransform.ts` and `styles/markdown.css` as public facades. Test with `tests/gfm-test-note.md`.
- **Theme tokens**: `src/styles/theme.css` → `@theme` block (primary, text, border, surface, muted, bg).
- **Platform-specific behavior**: Implement in `PlatformFS` interface, never branch on platform in components.
- **Search**: Full-text search is owned solely by the shared Rust local-note store. UI code consumes ranked note IDs and must not build, persist, or maintain a second body index in JavaScript. Synchronous wikilink completion filters note IDs from `notesCache`.

## Tauri MCP Shortcuts

Use `webview-execute-js` against the live app and call:

- `await window.__testSync.connect('http://127.0.0.1:3100', 'testing123')` on desktop
- `await window.__testSync.status()`
- `await window.__testSync.syncNow()`
- `await window.__testSync.disconnect()`

## Testing

- **Playwright E2E**: `tests/*.spec.ts` — covers markdown rendering, wikilinks, image paste, search, sync.
- **Markdown spec + cursor movement**: `tests/markdown-spec.spec.ts` reads `markdown-spec/cases/**`; use it for cursor-reveal and wrapped-line navigation regressions.
- **Unit tests**: co-located `*.test.ts` files under each owning feature; platform and generic utility tests remain under `src/lib/`.
- **Regression tests**: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting).

## Verification (Required)

| What changed | Run |
|---|---|
| Components / UI | `just build` → `pnpm run test -- <spec>` |
| lib/ logic | `just build` → `just test-unit` |
| CSS / Tailwind | `just build` → visual spot-check via screenshot |
| Editor behavior | Above + manual test in `just tauri-dev` (CM6 quirks don't always show in Playwright) |
