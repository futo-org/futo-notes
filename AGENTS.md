# AGENTS.md - Stonefruit

@README.md for project overview. @package.json for all scripts (`pnpm run` to list).

## Quick Start

```bash
pnpm install        # Install all workspace dependencies
pnpm run dev        # Web dev server (http://localhost:5173)
pnpm run tauri:dev  # Tauri desktop dev (Wayland-first, fixed port 5180)
pnpm run build      # TypeScript check + Vite build → dist/
pnpm run test:unit  # Vitest unit tests
pnpm run lint       # ESLint
```

## Monorepo

npm workspaces. Shared Svelte app at root, platform shells in `apps/`, shared packages in `packages/`.

```
src/                  ← Shared Svelte 5 app (editor, UI, sync client)
apps/
  tauri/              ← Tauri v2 desktop + mobile shell (Rust backend)
  server/             ← Self-hosted Hono sync server (TypeScript, Docker)
  cli/                ← Server setup/management CLI (Rust, Ratatui TUI)
packages/
  shared/             ← Shared types & utils (sync protocol, filename rules)
```

- **Client stack**: Svelte 5 + Tauri v2 + Vite + Tailwind v4 + CodeMirror 6
- **Server stack**: Hono + better-sqlite3 + Docker. Hash-based sync via `POST /sync`. SSE push notifications. Semantic search with embeddings.
- **CLI stack**: Rust + Clap + Ratatui. Deploys and manages the server via Docker Compose.
- **Shared package** (`@futo-notes/shared`): `SyncRequest`/`SyncResponse` types, `NoteSyncMeta`, filename sanitization (`sanitizeTitle`, `validateTitle`). Consumed as TypeScript source (no build step).

Each app has its own `AGENTS.md` with app-specific details.

## Browser Tools

**Use `agent-browser` over Playwright MCP** for interactive browser tasks — poking around, testing UI, taking screenshots, inspecting state. It's faster, handles CodeMirror typing natively, and supports annotated screenshots with element labels. For the Tauri app (desktop, Android, iOS), use the Tauri MCP bridge tools (`driver_session`, `webview_*`) — the bridge is included in debug builds on all platforms.

## Key Constraints

- **The filename IS the title.** `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space, no transformations. `sanitizeFilename()` only strips filesystem-breaking characters. Never mutate filenames into titles.
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **IMPORTANT**: `pnpm run dev` uses localhost APIs. `pnpm run build` points to production endpoints.
- **IMPORTANT**: `pnpm run build` must run from monorepo root. Running from a workspace resolves a different build script — verify output includes `vite build` and `dist/assets/`.
- **IMPORTANT**: Tauri dev ports are split by target to avoid collisions: desktop `5180`, Android `5181`, iOS `5182`.
- **IMPORTANT**: `window.confirm()`/`window.alert()` don't block properly in Tauri's webview. Use `ask()`/`message()` from `@tauri-apps/plugin-dialog` instead.

## Close The Loop (Required)

Do not report a fix or addition as complete until you verify it. If verification fails, iterate until it passes.

**Pick the right verification chain for the change:**

| What changed | Verification |
|---|---|
| Frontend / UI / Svelte | `pnpm run build` → `pnpm run test -- <spec>` (broaden Playwright coverage if risk is broad) |
| Unit-testable logic | `pnpm run build` → `pnpm run test:unit` |
| Server (sync, auth, API) | `pnpm run server:test` from root, or `pnpm test` in `apps/server/` |
| Server + Docker | Above, then `docker compose up --build` in `apps/server/` → `curl -s http://localhost:3005/health` |
| Shared package | `pnpm run test:shared` |
| CSS / Tailwind only | `pnpm run build` (catches missing classes) → visual spot-check via Playwright screenshot or `pnpm run dev` |
| CI / pipeline config | Push branch → check pipeline via GitLab API (see GitLab CI section) |

Always pipe build output through `| tail -20` for readability. Run `pnpm exec tsc --noEmit | head -30` before a full build to catch type errors early.

In your final response, include: commands run, pass/fail, and key observed behavior.

## Own The E2E Experience

For demos, migrations, or “make the whole thing work on my machine” requests — own the full client + server + data + launcher path until the user can open the app and see the result. Do not hand off operational steps you can do yourself.

Full checklist: @docs/e2e-demo-checklist.md

## GitLab CI

`$GITLAB_TOKEN` available in shell (from `~/.zshrc`):

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/stonefruit%2Fstonefruit/pipelines?ref=main&per_page=1"
```

## Testing

- **Automation harness**: before building one-off note-moving setups for smart automations, run `pnpm run automation:loop -- --source ~/Documents/demo-vault-backup`
- The harness copies the source vault into a temp run directory, bootstraps it into an isolated temp server DB, runs the built-in automations through the real server plugin routes, and leaves the source vault untouched
- Default artifacts live under `.tmp/automation-loop/` and include `vault/`, `diff.patch`, `summary.txt`, `report.json`, and `runs/<plugin-id>.json`
- Read `summary.txt` first, then `diff.patch`, then the per-plugin JSON in `runs/` when a transform looks wrong
- Use `--plugin <id>` to narrow the loop to one built-in automation during iteration
- Full docs: `docs/automation-loop.md`

- Regression tests: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting)
- Markdown spec + cursor movement coverage: `tests/markdown-spec.spec.ts` and `markdown-spec/cases/**`. The movement-path editor cases run in CI via `pnpm run test:markdown-spec`.
- Some Android-native issues (IME, status bar) require device QA even when Playwright passes

## Test Requirements

Every code change that touches logic must include or update tests. No exceptions.

### When to add tests

| What you changed | Required test |
|---|---|
| New Tauri `#[tauri::command]` | Rust unit test in `core.rs` for the underlying `_impl` function |
| Sync logic (client or server) | Server integration test in `apps/server/tests/integration/` |
| Sync state transitions | Multi-client test using `SyncClient` helper in `multi-client-sync.test.ts` |
| Shared package (`@futo-notes/shared`) | Unit test in `packages/shared/` |
| Bug fix (any layer) | Regression test that reproduces the bug BEFORE the fix, then passes after |
| New UI interaction or flow | Playwright spec in `tests/` |
| Path/filename handling | Both: server test (sanitization) + Rust test (path safety) |

### Where tests live

- **Rust core**: `apps/tauri/src-tauri/src/core.rs` `#[cfg(test)]` module. Test `_impl` functions directly.
- **Server integration**: `apps/server/tests/integration/`. Use `createTestEnv()` + `setupAndLogin()` from `tests/helpers/setup.ts`.
- **Multi-client sync**: `apps/server/tests/integration/multi-client-sync.test.ts`. Use `SyncClient` class for stateful multi-client scenarios.
- **Shared package**: `packages/shared/src/*.test.ts`.
- **Playwright E2E**: `tests/*.spec.ts`. For server-connected tests, follow `dashboard.spec.ts` pattern.
- **Chaos/adversarial**: `apps/server/tests/integration/chaos-sync.test.ts` (server), Rust chaos tests in `core.rs`.

### How to run

| Suite | Command |
|---|---|
| All server tests | `pnpm run server:test` |
| Rust tests | `pnpm run tauri:test:rust` |
| Shared package | `pnpm run test:shared` |
| Unit tests | `pnpm run test:unit` |
| Playwright E2E | `pnpm run test` |
| Everything | `pnpm run test:all` then `pnpm run test` |

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

- Engineering log: `docs/devlog.md`
- E2E demo flow: @docs/e2e-demo-checklist.md
