# AGENTS.md - Stonefruit

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

```
src/                  ← Shared Svelte 5 app (editor, UI, sync client)
apps/
  tauri/              ← Tauri v2 desktop + mobile shell (Rust backend)
  server/             ← Self-hosted Hono sync server (TypeScript, Docker)
  cli/                ← Server setup/management CLI (Go, Bubble Tea TUI)
packages/
  shared/             ← Shared types & utils (sync protocol, filename rules)
```

- **Client stack**: Svelte 5 + Tauri v2 + Vite + Tailwind v4 + CodeMirror 6
- **Server stack**: Hono + better-sqlite3 + Docker. Hash-based sync via `POST /sync`. SSE push notifications. Semantic search with embeddings.
- **CLI stack**: Go + Bubble Tea/Lip Gloss. Deploys and manages the server via Docker Compose.
- **Shared package** (`@futo-notes/shared`): `SyncRequest`/`SyncResponse` types, `NoteSyncMeta`, filename sanitization (`sanitizeTitle`, `validateTitle`). Consumed as TypeScript source (no build step).

Each app has its own `AGENTS.md` with app-specific details.

## Key Constraints

- **The filename IS the title.** `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space, no transformations. `sanitizeFilename()` only strips filesystem-breaking characters. Never mutate filenames into titles.
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **IMPORTANT**: `npm run dev` uses localhost APIs. `npm run build` points to production endpoints.
- **IMPORTANT**: `npm run build` must run from monorepo root. Running from a workspace resolves a different build script — verify output includes `vite build` and `dist/assets/`.
- **IMPORTANT**: Tauri dev ports are split by target to avoid collisions: desktop `5180`, Android `5181`, iOS `5182`.
- **IMPORTANT**: `window.confirm()`/`window.alert()` don't block properly in Tauri's webview. Use `ask()`/`message()` from `@tauri-apps/plugin-dialog` instead.

## Close The Loop (Required)

Do not report a fix or addition as complete until you verify it. If verification fails, iterate until it passes.

**Pick the right verification chain for the change:**

| What changed | Verification |
|---|---|
| Frontend / UI / Svelte | `npm run build` → `npm run test -- <spec>` (broaden Playwright coverage if risk is broad) |
| Unit-testable logic | `npm run build` → `npm run test:unit` |
| Server (sync, auth, API) | `npm run server:test` from root, or `npm test` in `apps/server/` |
| Server + Docker | Above, then `docker compose up --build` in `apps/server/` → `curl -s http://localhost:3005/health` |
| Shared package | `npm run test:shared` |
| CSS / Tailwind only | `npm run build` (catches missing classes) → visual spot-check via Playwright screenshot or `npm run dev` |
| CI / pipeline config | Push branch → check pipeline via GitLab API (see GitLab CI section) |

Always pipe build output through `| tail -20` for readability. Run `npx tsc --noEmit | head -30` before a full build to catch type errors early.

In your final response, include: commands run, pass/fail, and key observed behavior.

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

- **Automation harness**: before building one-off note-moving setups for smart automations, run `npm run automation:loop -- --source ~/Documents/demo-vault-backup`
- The harness copies the source vault into a temp run directory, bootstraps it into an isolated temp server DB, runs the built-in automations through the real server plugin routes, and leaves the source vault untouched
- Default artifacts live under `.tmp/automation-loop/` and include `vault/`, `diff.patch`, `summary.txt`, `report.json`, and `runs/<plugin-id>.json`
- Read `summary.txt` first, then `diff.patch`, then the per-plugin JSON in `runs/` when a transform looks wrong
- Use `--plugin <id>` to narrow the loop to one built-in automation during iteration
- Full docs: `docs/automation-loop.md`

- Regression tests: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting)
- Some Android-native issues (IME, status bar) require device QA even when Playwright passes

## Debugging

```bash
adb logcat | grep "futo\|JS\|error"  # Android logs
# iOS: Xcode → Window → Devices and Simulators → View device logs
```

## Error Handling

When the user pastes an error, stack trace, or log output — act immediately:

1. Grep the codebase for the error message or failing symbol
2. Read the source file at the relevant line
3. Check `git log --oneline -5 -- <file>` for recent changes that may have caused it
4. Propose and apply a fix
5. Run the appropriate verification chain (see table above)

Do not ask clarifying questions unless the error is genuinely ambiguous (e.g., it could originate from multiple unrelated systems). Bias toward action.

## Resources

- Engineering log: @docs/devlog.md
