# AGENTS.md - FUTO Notes

@README.md for project overview. @package.json for all scripts (`npm run` to list).

## Quick Start

```bash
npm install        # Install all workspace dependencies
npm run dev        # Web dev server (http://localhost:5173)
npm run tauri:dev  # Tauri desktop dev (Wayland-first, fixed port 5180)
npm run build      # TypeScript check + Vite build → dist/
npm run test:unit  # Vitest unit tests
npm run lint       # ESLint
```

## Monorepo

npm workspaces. Shared Svelte app at root, platform shells in `apps/`, shared packages in `packages/`.

**Stack**: Svelte 5 + Tauri v2 + Vite + Tailwind v4 + CodeMirror 6

## Key Constraints

- **The filename IS the title.** `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space, no transformations. `sanitizeFilename()` only strips filesystem-breaking characters. Never mutate filenames into titles.
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **IMPORTANT**: `npm run dev` uses localhost APIs. `npm run build` points to production endpoints.
- **IMPORTANT**: `npm run build` must run from monorepo root. Running from a workspace resolves a different build script — verify output includes `vite build` and `dist/assets/`.

## Close The Loop (Required)

- Do not report a fix or addition as complete until you verify it yourself.
- For frontend or UI changes, run Playwright for affected behavior (`npm run test -- <spec>` minimum; broaden coverage when change risk is broad).
- For non-frontend changes, run relevant automated tests and a runtime smoke test of the changed behavior.
- If behavior depends on runtime environment (Docker, emulator or simulator, Tauri runtime), verify in that environment before closing.
- If verification fails, iterate: fix, rerun verification, re-check.
- In the final response, include verification evidence: commands run, pass or fail status, and key observed behavior.

## GitLab CI

`$GITLAB_TOKEN` available in shell (from `~/.zshrc`):

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/justin%2Ffuto-notes/pipelines?ref=main&per_page=1"
```

## Common Patterns

- **Markdown elements**: `liveMarkdownTransform.ts` (processing) + `markdown.css` (styling). Test with `tests/gfm-test-note.md`.
- **Theme tokens**: `src/styles/app.css` → `@theme` block (primary, text, border, surface, muted, bg)
- **Platform-specific behavior**: `PlatformFS` interface in `src/lib/platform/types.ts`, implement in each platform file.

## Testing

- Regression tests: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting)
- Some Android-native issues (IME, status bar) require device QA even when Playwright passes

## Debugging

```bash
adb logcat | grep "futo\|JS\|error"  # Android logs
# iOS: Xcode → Window → Devices and Simulators → View device logs
```

## Resources

- Engineering log: @docs/devlog.md
