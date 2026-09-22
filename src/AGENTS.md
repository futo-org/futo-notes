# AGENTS.md - Shared Svelte App

Svelte 5 frontend shared across all platforms (Tauri desktop, Android, iOS, web dev).

From the monorepo root, prefer `just build`, `just tauri-dev`, `just test-unit`, and `just check` for the standard workflows.

## Architecture

- **`app/`** owns application composition, routing, bootstrap, and native-shell wiring. `App.svelte` and `main.ts` are thin framework entry points.
- **`features/`** owns complete capabilities. Components, reactive state, boundary shims, and tests stay with the feature that changes them.
- **`features/editor/`** owns the note editor: shared chrome (`NoteTagBar.svelte`), the paste sink, the fence-language set, and the keyboard shell hook.
- **`features/editor/milkdown/`** owns THE editor — Milkdown (ProseMirror), WYSIWYG, mounted by the desktop shell through `app/components/NoteWorkspace.svelte` and by both native shells through `editor-embed/main.ts`. One engine, one plugin set, all three surfaces. The suites live in `tests/editor-embed-milkdown.spec.ts` (bridge contract), `-toolbar` (toolbar command parity), `-interactive` (list continuation, table editing keys, link hit area), `-parity`, `-wikilinks`, `-compat`, `-deep-nesting` and `tests/editor-embed-webview-floor.spec.ts`. Run the lot with `pnpm run test:e2e:editor-embed`.
- **`features/notes/`** owns reactive note projection state. `notes.svelte.ts` holds `notesCache`, applies committed `LocalNoteMutation` results, and never predicts collision, relink, migration, or search behavior.
- **`features/sync/`** owns the E2EE client, sync lifecycle, watcher batching, write suppression, and external-change coordination.
- **`features/search/`** owns search presentation. The Rust local-note store owns the sole BM25 lifecycle.
- **`features/images/`** owns image-file listing, deletion, and renderable vault URLs; sidebar and editor consume that boundary. `vaultImageSrc.ts` is the single owner of the vault-filename -> loadable-URL mapping (a host-registered base URL on the native shells, per-file `PlatformFS.getImageUrl` on desktop via `vaultImageUrlResolver.ts`).
- **`lib/platform/`** is the platform boundary. Components and features use `PlatformFS`; native command details stay in the Tauri adapter.
- **`shared/`** contains small, genuinely cross-feature contracts and named capabilities for async work, dialogs, DOM behavior, media rules, notifications, persisted state, and time formatting.
- **`editor-embed/`** is the native web-editor boundary and implements the versioned `futoBridge` contract.

## Key Constraints

- **Editor styling lives with the editor.** `MilkdownEditor.svelte`'s own `<style>` block owns the `.ProseMirror` surface and every element rendered inside it. What is left under `src/styles/` is only what is genuinely shared beyond that surface: `code-tokens.css` (the `tok-*` fence palette, also read by the highlighter) and `markdown-links.css` (the link and wikilink chips, whose `cm-md-*` class names are a legacy name from the CodeMirror engine, not a CodeMirror selector). `markdown.css` is the facade over those two.
- **Svelte 5 reactivity**: Use `$state()` runes, not stores. Read `onchange` lazily inside callbacks (not in `$effect` body) to avoid tracking it as a dependency — prevents editor destruction/recreation.
- **Editor responsiveness is sacred.** Never let background operations (sync, search indexing, save) block or delay typing.
- **Images**: the editor's image node views resolve a vault filename to a URL through `vaultImageSrc.ts` and re-render themselves when it lands. Images are served via the Tauri asset protocol (`asset://`).
- **Note/folder/search work goes through `getLocalNoteStore()`.** `PlatformFS` is only for shell storage, images, and capabilities; components never invoke note commands or plugin-fs directly. Sync keeps its dedicated `syncServiceE2ee.ts` shim; user-facing sync errors are localized catalog messages, with `classifySyncError()` deciding transient vs actionable and `syncErrorDedupeKey()` collapsing transport variants so a flapping outage toasts once.
- **Never hand-build note paths** — use `pathSafety.ts` for any path formed before a command call.

## Common Patterns

- **Adding markdown elements**: a construct the editor should understand is a Milkdown/remark plugin under `src/features/editor/milkdown/` (see `wikilink/` for the full shape: micromark tokenizer, mdast from/to-markdown, schema node, node view, input rule). Anything that is only a paint over existing text is a decoration on `blockDecorations.ts`'s bounded repaint (see `tagDecorations.ts`), never a per-keystroke whole-document walk. Styling goes in `MilkdownEditor.svelte`'s `<style>` block, unless a surface outside the editor needs the same rule — then it goes behind the `src/styles/markdown.css` facade.
- **Theme tokens**: Tailwind v4; `src/styles/theme.css` → `@theme` block (primary, text, border, surface, muted, bg). Dark mode is `[data-theme='dark']` overrides — there is no `dark:` variant.
- **New persisted setting**: add the field to `AppState` (`src/shared/state/appState.ts`), guard it in `sanitize()`, default it in `defaultState()`, then thread it through the `AppPreferences` facade. UI-layout state (sidebar width, open folders, tabs) goes in `.app-config.json` via `getConfig`/`saveConfig` instead.
- **Toasts and dialogs**: `showGlobalToast()` from non-component code; `confirmDialog()` (`src/shared/dialogs/confirmDialog.ts`) for confirmations — never import `@tauri-apps/plugin-dialog` from a component (the platform-discipline gate rejects it). `window.confirm()`/`alert()` do **not** block in Tauri's webview.
- **Platform-specific behavior**: Implement in `PlatformFS` interface, never branch on platform in components.
- **Search**: Full-text search is owned solely by the shared Rust local-note store. UI code consumes ranked note IDs and must not build, persist, or maintain a second body index in JavaScript. Synchronous wikilink completion filters note IDs from `notesCache`.

## Tauri MCP Shortcuts

The dev-only `window.__testSync` hooks and the MCP bridge are documented once, in `apps/tauri/AGENTS.md` (§Tauri MCP).

## Testing

- **Playwright E2E**: `tests/*.spec.ts` — covers markdown rendering, wikilinks, image paste, search, sync.
- **Unit tests**: co-located `*.test.ts` files under each owning feature; platform and generic utility tests remain under `src/lib/`.
- **Regression tests**: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting).

## Verification (Required)

| What changed | Run |
|---|---|
| Components / UI | `just build` → `pnpm run test:e2e:smoke` + the targeted spec |
| lib/ logic | `just build` → `just test-unit` |
| CSS / Tailwind | `just build` → visual spot-check via screenshot |
| Editor behavior | Above + `pnpm run test:e2e:editor-embed` + manual test in `just tauri-dev` (WebView quirks don't always show in Playwright) |

Writing the tests:

- **New interaction or flow** → a new/extended Playwright spec in `tests/`. Launch with
  `page.goto('/#/note/new')`; selectors are `.ProseMirror`, `.title-input`, `.note-row`; capture
  `pageerror` for crash checks.
- **Component logic** → Vitest `*.test.ts` with `vi.mock('$lib/platform')` (in-memory `testFS`).
- **New editor behavior** → a case in the matching `tests/editor-embed-milkdown*.spec.ts`, which
  drives the SAME single-file `editor.html` bundle the native shells ship. Unit-testable pieces
  (commands, decorations, chunk planning) get a co-located `*.test.ts` next to the module.
