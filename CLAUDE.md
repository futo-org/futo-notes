# CLAUDE.md - FUTO Notes

## Quick Start

```bash
npm install        # Install all workspace dependencies
npm run dev        # Web dev server (http://localhost:5173)
npm run build      # TypeScript check + Vite build → dist/
npm test           # Playwright end-to-end tests
npm run test:unit  # Vitest unit tests
npm run lint       # ESLint
npm run            # List all available scripts
```

## Monorepo

npm workspaces monorepo. Shared Svelte app at root, platform shells in `apps/`, shared packages in `packages/`.

- `apps/mobile/` — Capacitor (Android/iOS), see `apps/mobile/CLAUDE.md`
- `apps/desktop/` — Electron, see `apps/desktop/CLAUDE.md`
- `apps/server/` — Hono sync server, see `apps/server/CLAUDE.md`
- `packages/shared/` — @futo-notes/shared (sync types, filename sanitization), see `packages/shared/CLAUDE.md`

**Stack**: Svelte 5 + Capacitor 8 + Electron + Vite + Tailwind v4 + CodeMirror 6

## Orchestration Scripts

```bash
# Mobile (Capacitor)
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

## Key Constraints & Gotchas

- **The filename IS the title.** `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space replacement, no transformations. `sanitizeFilename()` only strips characters that would break the filesystem. Never add title-derivation logic that mutates the filename.
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **IMPORTANT**: For local development, always use `npm run dev` or ensure `import.meta.env.DEV` is true. Production builds (`npm run build`) point to production API endpoints, not localhost.
- **IMPORTANT**: `npm run build` must be run from the monorepo root to build the Vite web app. If run from a workspace (e.g. `apps/server`), npm may resolve a different `build` script. Always verify the output includes `vite build` and the `dist/assets/` file list — if you only see `tsup`/`ESM` output, you built the server, not the web app.

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

## Common Tasks

**Add markdown element**: Edit `liveMarkdownTransform.ts` (add processing method) + `markdown.css` (add CSS class). Test with `tests/gfm-test-note.md`.

**Change styling**:
- Tailwind utilities: Use directly in templates
- Theme tokens: `src/styles/app.css` → `@theme` block (primary, text, border, surface, muted, bg)
- Custom CSS: `components.css` (drawer, safe areas, FAB), `markdown.css` (markdown elements)

**Modify storage**: `fileSystem.ts` (delegates to platform) → `platform/capacitor.ts` or `platform/electron.ts`

**Add platform-specific behavior**: Add method to `PlatformFS` interface in `src/lib/platform/types.ts`, implement in each platform file.

## Bugfix Test Workflow

When fixing user-reported bugs, follow this loop:

1. Reproduce and identify code path(s).
2. Implement the fix.
3. Add focused regression tests before closing the bug.
4. Run targeted tests + build/lint locally.
5. Add/refresh manual QA checklist docs for device-only behavior.

### Regression Test Files
- `tests/p0-regressions.spec.ts` — crash/IME safety regressions
- `tests/p1-regressions.spec.ts` — clickable links and table link rendering
- `tests/p2-regressions.spec.ts` — title Enter behavior + trailing-space markdown formatting

Note: Some Android-native issues (IME internals, status bar edge cases) still require device QA even when Playwright passes.

## Resources

- Test files: `tests/gfm-test-note.md`, `tests/editor-theme-test.md`
- Engineering log: [`docs/devlog.md`](docs/devlog.md)
