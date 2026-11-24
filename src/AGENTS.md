# AGENTS.md - Shared Svelte App

Svelte 5 frontend for Tauri desktop and browser development. Mobile uses the native Rust-backed renderers in `apps/ios` and `apps/android`.

From the monorepo root, prefer `just build`, `just tauri-dev`, `just test-unit`, and `just check` for the standard workflows.

## Architecture

- **`app/`** owns application composition, routing, bootstrap, and Tauri shell wiring. `App.svelte` and `main.ts` are thin framework entry points.
- **`features/`** owns complete capabilities. Components, reactive state, boundary shims, and tests stay with the feature that changes them.
- **`features/editor/`** owns the note editor: shared chrome (`NoteTagBar.svelte`), the paste sink, the fence-language set, and the keyboard shell hook.
- **`features/editor/desktop/`** owns the desktop editor, mounted by `app/components/NoteWorkspace.svelte`: a `contenteditable` view over the Rust editor engine (WASM), with each open note attached to the desktop host (`lib/platform/tauri/editorHost.ts`, `docs/architecture/text-first-editor-desktop-host.md`), which saves it and owns which note it is (moves a store workflow makes included) and what it last saved. The note session follows it (`onnote`, `onsaved`, `savedSource`) and asks only for a title's rename (`rename`), a save now (`save`) and a switch (`openNote`); the session never writes a body or keeps its own baseline.
- **`features/notes/`** owns reactive note projection state. `notes.svelte.ts` holds `notesCache`, applies committed `LocalNoteMutation` results, and never predicts collision, relink, migration, or search behavior.
- **`features/sync/`** owns the E2EE client, sync lifecycle, watcher batching, write suppression, and external-change coordination.
- **`features/search/`** owns search presentation. The Rust local-note store owns the sole BM25 lifecycle.
- **`features/images/`** owns image-file listing, deletion, and renderable vault URLs; sidebar and editor consume that boundary. `vaultImageSrc.ts` is the single owner of the vault-filename -> loadable-URL mapping (per-file `PlatformFS.getImageUrl` on desktop via `vaultImageUrlResolver.ts`).
- **`lib/platform/`** is the platform boundary. Components and features use `PlatformFS`; native command details stay in the Tauri adapter.
- **`shared/`** contains small, genuinely cross-feature contracts and named capabilities for async work, dialogs, DOM behavior, media rules, notifications, persisted state, and time formatting.

## Key Constraints

- **Editor styling lives with the editor.** `features/editor/desktop/desktopEditor.css` and its siblings (`desktopCodeBlocks.css`, `desktopCodeColours.css`, `desktopLinks.css`, `desktopTables.css`, …) own the editor surface and every element rendered inside it; there is no shared `src/styles` markdown facade.
- **IMPORTANT**: Styles in `@layer(components)` lose to _any_ unlayered CSS — on cascade origin, not
  specificity. Every `.css` a Svelte component imports directly (`folderTree.css`, `tabsStrip.css`,
  `settings.css`, `modal.css`, `feedback.css`, `crashReportDialog.css`, …) is unlayered; none of
  them declare `@layer`. A layered rule can look applied on an ancestor's computed style and still
  lose on those elements.
- **Svelte 5 reactivity**: Use `$state()` runes, not stores. Read `onchange` lazily inside callbacks (not in `$effect` body) to avoid tracking it as a dependency — prevents editor destruction/recreation.
- **Editor responsiveness is sacred.** Never let background operations (sync, search indexing, save) block or delay typing.
- **Images**: the desktop editor resolves a vault filename to a URL through `vaultImageSrc.ts` and re-renders the image when it lands. Images are served via the Tauri asset protocol (`asset://`).
- **Note/folder/search work goes through `getLocalNoteStore()`.** `PlatformFS` is only for shell storage, images, and capabilities; components never invoke note commands or plugin-fs directly. Sync keeps its dedicated `syncServiceE2ee.ts` shim; user-facing sync errors are localized catalog messages, with `classifySyncError()` deciding transient vs actionable and `syncErrorDedupeKey()` collapsing transport variants so a flapping outage toasts once.
- **Never hand-build note paths** — use `pathSafety.ts` for any path formed before a command call.

## Common Patterns

- **Adding markdown elements**: the Rust editor engine (`crates/futo-notes-editor`, compiled to WASM) owns what a construct is and how it round-trips; the desktop view only paints it. Spec line first, then the engine change with its tests, then the desktop paint (a renderer/decoration under `features/editor/desktop/` and its `desktop*.css`). Styling goes in the matching `desktop*.css`.
- **Theme tokens**: Tailwind v4; `src/styles/theme.css` → `@theme` block (primary, text, border, surface, muted, bg). Dark mode is `[data-theme='dark']` overrides — there is no `dark:` variant.
- **New persisted setting**: add the field to `AppState` (`src/shared/state/appState.ts`), guard it in `sanitize()`, default it in `defaultState()`, then thread it through the `AppPreferences` facade. UI-layout state (sidebar width, open folders, tabs) goes in `.app-config.json` via `getConfig`/`saveConfig` instead.
- **Toasts and dialogs**: `showGlobalToast()` from non-component code; confirmations go through `confirmDialog()` and the shared in-app modal host. Keep `@tauri-apps/plugin-dialog` for file/folder pickers only. `window.confirm()`/`alert()` do **not** block in Tauri's webview.
- **Platform-specific behavior**: Implement in `PlatformFS` interface, never branch on platform in components.
- **Search**: Full-text search is owned solely by the shared Rust local-note store. UI code consumes ranked note IDs and must not build, persist, or maintain a second body index in JavaScript. Synchronous wikilink completion filters note IDs from `notesCache`.

## Tauri MCP Shortcuts

The dev-only `window.__testSync` hooks and the MCP bridge are documented once, in `apps/tauri/AGENTS.md` (§Tauri MCP).

## Testing

- **Playwright E2E**: `tests/*.spec.ts` — covers search, sync, shell flows. Desktop editor behaviour is covered by Puppet stories (`tests/desktop-editor-*-stories.mjs`) and unit tests under `src/features/editor/desktop/`.
- **Unit tests**: co-located `*.test.ts` files under each owning feature; platform and generic utility tests remain under `src/lib/`.

## Verification (Required)

| What changed    | Run                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Components / UI | `just build` → the targeted spec (`pnpm exec playwright test tests/<spec>`), or the desktop editor stories |
| lib/ logic      | `just build` → `just test-unit`                                                                            |
| CSS / Tailwind  | `just build` → visual spot-check via screenshot                                                            |
| Editor behavior | Above + the matching `tests/desktop-editor-*-stories.mjs` Puppet story + manual test in `just tauri-dev`   |

Writing the tests:

- **New interaction or flow** → a new/extended Playwright spec in `tests/`. Launch with
  `page.goto('/#/note/new')`; selectors are `.title-input`, `.note-row`; capture
  `pageerror` for crash checks.
- **Component logic** → Vitest `*.test.ts` with `vi.mock('$lib/platform')` (in-memory `testFS`).
- **New editor behavior** → a Puppet story in the matching `tests/desktop-editor-*-stories.mjs`. Unit-testable pieces
  (commands, decorations, caret maths) get a co-located `*.test.ts` next to the module.
