# CLAUDE.md - FUTO Notes

## Quick Start

```bash
# Install dependencies
npm install

# List all available project scripts
npm run
```

## Architecture

**Stack**: Svelte 5 + Capacitor 8 + Vite + Tailwind v4 + CodeMirror 6
**Storage**: File-first (`.md` files in Documents directory, no database)
**State**: Svelte 5 runes (`$state`, `$derived`, `$effect`)
**Search**: MiniSearch (in-memory, rebuilt on startup)

**Key Features**:

- File-first: notes are `.md` files at root of Documents directory
- Live markdown transformations (syntax hides as you type)
- Full GitHub Flavored Markdown support
- Auto-save with 500ms debounce
- Fast full-text search
- Offline-first, cross-platform (iOS/Android/Web)

## Project Structure

```
src/
├── App.svelte, state.svelte.ts      # Root component, global state
├── components/
│   ├── NotesShell.svelte            # Main screen (drawer + editor, auto-save)
│   ├── MarkdownEditor.svelte        # CodeMirror 6 wrapper
│   └── VirtualList.svelte           # Notes list
├── lib/
│   ├── fileSystem.ts, notes.ts      # Storage layer (CRUD, in-memory cache)
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

### Storage
- File-first: `.md` files in Documents directory (no subdirectory)
- In-memory cache: rebuilt on startup from `.md` files
- Auto-save: 500ms debounce
- Search: MiniSearch, in-memory, rebuilt on startup

### Capacitor Plugins
- `@capacitor/filesystem` (file I/O), `@capacitor/haptics`, `@capacitor/keyboard`, `@capacitor/status-bar`

## Debugging

```bash
npm run dev                          # Web dev server (http://localhost:5173)
adb logcat | grep "futo\|JS\|error"  # Android logs
# iOS: Xcode → Window → Devices and Simulators → View device logs
```

## Common Tasks

**Add markdown element**: Edit `liveMarkdownTransform.ts` (add processing method) + `markdown.css` (add CSS class). Test with `gfm-test-note.md`.

**Add Svelte component**: Create `.svelte` file in `components/`. Use `$props()` for inputs, `$state()` for local state, `$effect()` for side effects.

**Change styling**:
- Tailwind utilities: Use directly in templates
- Theme tokens: `app.css` → `@theme` block (primary, text, border, surface, muted, bg)
- Custom CSS: `components.css` (drawer, safe areas, FAB), `markdown.css` (markdown elements)
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CM6 overrides.

**Modify storage**: `fileSystem.ts` (file ops), `notes.ts` (CRUD, cache)

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
