# CLAUDE.md - FUTO Notes

## Quick Start

```bash
npm install        # Install all workspace dependencies
npm run dev        # Web dev server (http://localhost:5173)
npm run build      # TypeScript check + Vite build → dist/
npm run            # List all available scripts
```

## Monorepo Structure

This is an npm workspaces monorepo. The shared Svelte app lives at the root, platform-specific shells live under `apps/`, and shared packages under `packages/`.

```
futo-notes/
├── package.json              # Root workspace: UI deps + orchestration scripts
├── src/                      # Shared Svelte app (all platforms)
├── apps/
│   ├── mobile/               # Capacitor (Android/iOS) — see apps/mobile/CLAUDE.md
│   ├── desktop/              # Electron (Linux/macOS/Windows) — see apps/desktop/CLAUDE.md
│   └── server/               # Self-hosted sync server — see apps/server/CLAUDE.md
├── packages/
│   └── shared/               # Shared types (@futo-notes/shared) — see packages/shared/CLAUDE.md
├── tests/                    # Playwright tests
├── docs/                     # Engineering docs and plans
└── dist/                     # Vite build output (consumed by all platform shells)
```

## Architecture

**Stack**: Svelte 5 + Capacitor 8 + Electron + Vite + Tailwind v4 + CodeMirror 6
**Storage**: File-first (`.md` files, no database)
**State**: Svelte 5 runes (`$state`, `$derived`, `$effect`)
**Search**: MiniSearch (in-memory, rebuilt on startup)
**Platform**: Abstraction layer detects runtime (Capacitor/Electron/Web), lazy-loads FS implementation

**Key Features**:

- File-first: notes are `.md` files (subfolder on mobile, user-chosen dir on desktop)
- Live markdown transformations (syntax hides as you type)
- Full GitHub Flavored Markdown support
- Auto-save with 500ms debounce
- Fast full-text search
- Offline-first, cross-platform

## Source Structure

```
src/
├── App.svelte, state.svelte.ts      # Root component, global state
├── components/
│   ├── NotesShell.svelte            # Main screen (drawer + editor, auto-save)
│   ├── MarkdownEditor.svelte        # CodeMirror 6 wrapper
│   └── VirtualList.svelte           # Notes list
├── lib/
│   ├── platform/                    # Platform abstraction layer
│   │   ├── types.ts                 # PlatformFS interface (NoteFile, FileChangeEvent)
│   │   ├── index.ts                 # Detection + lazy loading + ensureNotesFolder
│   │   ├── electron.ts              # window.electronAPI wrapper
│   │   ├── capacitor.ts             # Capacitor FS (subfolder, migration, images)
│   │   └── web.ts                   # No-op stub
│   ├── fileSystem.ts                # Delegates to platform layer via getFS()
│   ├── notes.ts                     # CRUD, in-memory cache, search
│   ├── searchIndex.ts               # MiniSearch wrapper
│   ├── liveMarkdownTransform.ts     # Live markdown ViewPlugin
│   ├── listContinuation.ts          # Enter key handler
│   └── tableWidget.ts               # Table rendering
└── styles/
    ├── app.css                      # Tailwind (@theme tokens, @layer base)
    ├── components.css               # Drawer, safe areas, CM6 overrides
    └── markdown.css                 # Markdown element styles

tests/gfm-test-note.md              # Feature test file
```

## Platform Abstraction Layer

`src/lib/platform/` provides a unified `PlatformFS` interface for all platforms:

- **Detection** (`index.ts`): Checks `window.electronAPI` → Electron, `Capacitor.isNativePlatform()` → Capacitor, else Web
- **Lazy loading**: `getPlatformFS()` dynamically imports only the needed implementation
- **Sync access**: `getFS()` returns the initialized FS (throws if called before `getPlatformFS()`)
- **Capacitor-specific**: `ensureNotesFolder()` creates the `futo-notes` subfolder + migrates old files
- **Image helpers**: `saveImageFile()` and `getImageWebPath()` in `fileSystem.ts` dynamically import `platform/capacitor`

`notes.ts` calls `getPlatformFS()` + `ensureNotesFolder()` during `initNotes()`.

## Key Implementation Details

### Svelte 5 Runes
- `$state` for reactive state (global in `state.svelte.ts`, local in components)
- `$derived` for computed values
- `$effect` for lifecycle and side effects

### CodeMirror 6 Live Transformations
- Custom ViewPlugin (`liveMarkdownTransform.ts`) hides markdown syntax via decorations
- Example: `**bold**` → markers hide, text becomes bold as you type
- Cursor-aware: markers reappear when editing inside element
- Full GFM support: headings, emphasis, strikethrough, code, quotes, lists, tables, links

### Storage & Note Naming
- File-first: `.md` files (in `futo-notes` subfolder on Capacitor, user-chosen dir on Electron)
- **The filename IS the title.** `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space replacement, no transformations. `sanitizeFilename()` only strips characters that would break the filesystem. Never add title-derivation logic that mutates the filename.
- In-memory cache: rebuilt on startup from `.md` files
- Auto-save: 500ms debounce
- Search: MiniSearch, in-memory, rebuilt on startup

### Capacitor Plugins
- `@capacitor/filesystem` (file I/O), `@capacitor/haptics`, `@capacitor/keyboard`, `@capacitor/status-bar`

## Orchestration Scripts

```bash
# Web
npm run dev                        # Vite dev server
npm run build                      # TypeScript + Vite build

# Mobile (Capacitor)
npm run mobile:sync                # Build + cap sync (both platforms)
npm run mobile:run:android         # Build + sync + run on Android
npm run mobile:run:ios             # Build + sync + run on iOS
npm run mobile:open:android        # Open Android Studio
npm run mobile:open:ios            # Open Xcode

# Desktop (Electron)
npm run desktop:dev                # Dev mode (Vite + Electron)
npm run desktop:build              # Build for distribution
npm run desktop:package:linux      # Package Linux release

# Server
npm run server:dev                 # Dev server with hot reload
```

## GitLab CI

`$GITLAB_TOKEN` is available in the shell environment (from `~/.zshrc`). Use it with the GitLab API:

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/justin%2Ffuto-notes/pipelines?ref=main&per_page=1"
```

## Debugging

```bash
npm run dev                          # Web dev server (http://localhost:5173)
adb logcat | grep "futo\|JS\|error"  # Android logs
# iOS: Xcode → Window → Devices and Simulators → View device logs
```

**IMPORTANT**: For local development and testing, always use `npm run dev` (web) or ensure `import.meta.env.DEV` is true. Production builds (`npm run build`) point to production API endpoints (crash reporting, etc.), not localhost.

## Common Tasks

**Add markdown element**: Edit `liveMarkdownTransform.ts` (add processing method) + `markdown.css` (add CSS class). Test with `gfm-test-note.md`.

**Add Svelte component**: Create `.svelte` file in `components/`. Use `$props()` for inputs, `$state()` for local state, `$effect()` for side effects.

**Change styling**:
- Tailwind utilities: Use directly in templates
- Theme tokens: `app.css` → `@theme` block (primary, text, border, surface, muted, bg)
- Custom CSS: `components.css` (drawer, safe areas, FAB), `markdown.css` (markdown elements)
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CM6 overrides.

**Modify storage**: `fileSystem.ts` (delegates to platform) → `platform/capacitor.ts` or `platform/electron.ts`

**Add platform-specific behavior**: Add method to `PlatformFS` interface in `types.ts`, implement in each platform file.

## Bugfix Test Workflow

When fixing user-reported bugs, follow this loop:

1. Reproduce and identify code path(s).
2. Implement the fix.
3. Add focused regression tests before closing the bug.
4. Run targeted tests + build/lint locally.
5. Add/refresh manual QA checklist docs for device-only behavior.

### Regression Test Files
- `tests/p0-regressions.spec.ts` — crash/IME safety regressions (web-observable subset)
- `tests/p1-regressions.spec.ts` — clickable links and table link rendering regressions
- `tests/p2-regressions.spec.ts` — title Enter behavior + trailing-space markdown formatting regressions

### Manual QA Checklists
- `docs/qa/p0-ime-checklist.md`
- `docs/qa/p1-checklist.md`
- `docs/qa/p2-checklist.md`

### Commands Used During Bugfix Work
- Run `npm run` to view current scripts.
- Use the listed script names for lint/build/test flows.
- For targeted bugfix regressions, run the relevant Playwright spec files in `tests/`.

Note: Some Android-native issues (IME internals, status bar edge cases) still require device QA even when Playwright passes.

## Engineering Log

Detailed technical write-ups: [`docs/devlog.md`](docs/devlog.md)

**Latest (2026-02-06)**: Scroll jumping fix for CM6 external scroll container. `.cm-scroller` has `overflow: visible`, so CM6's scroll compensation is a no-op. Solution: real-time anchor-based compensation in `MarkdownEditor.svelte` using `lineBlockAtHeight()` and `lineBlockAt()`.

## Resources

- [Svelte 5 Docs](https://svelte.dev/docs/svelte) | [CodeMirror 6 Docs](https://codemirror.net/docs/) | [Capacitor Docs](https://capacitorjs.com/docs)
- Test files: `tests/gfm-test-note.md`, `tests/editor-theme-test.md`
