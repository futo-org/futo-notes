# AGENTS.md - Stonefruit

@README.md for project overview. @justfile for the preferred repo-root commands. @package.json for the underlying scripts (`pnpm run` to list).

## Quick Start

```bash
just install      # Install all workspace dependencies
just tauri-dev    # Tauri desktop dev (Wayland-first, fixed port 5180)
just android-dev  # Android dev
just ios-dev      # iOS dev
just build        # TypeScript check + Vite build → dist/
just check        # Lint + tests + build sanity pass
```

Prefer `just` from the monorepo root for the common workflows above. Use raw `pnpm` commands only when you need a script that is not wrapped in `justfile`.

## Monorepo

npm workspaces. Shared Svelte app at root, platform shells in `apps/`, shared packages in `packages/`.

```
src/                  ← Shared Svelte 5 app (editor, UI, sync client)
crates/
  stonefruit-core/    ← Shared Rust crate (hash, sync logic, search, graph)
apps/
  tauri/              ← Tauri v2 desktop + mobile shell (Rust backend)
packages/
  shared/             ← Shared types & utils (sync protocol, filename rules)
```

- **Client stack**: Svelte 5 + Tauri v2 + Vite + Tailwind v4 + CodeMirror 6
- **Sync server**: External E2EE server repo at `/home/justin/Developer/stonefruit-server`. The client uploads opaque encrypted blobs through collection/object/blob APIs.
- **Shared Rust crate** (`stonefruit-core`): Hash computation, sync logic, search (UMAP + K-Means), graph layout, file operations. Tauri imports core functions directly — do not reimplement logic that exists in `stonefruit-core`.
- **Shared package** (`@futo-notes/shared`): Filename sanitization (`sanitizeTitle`, `validateTitle`). Consumed as TypeScript source (no build step).

## Browser Tools

**Use `agent-browser` over Playwright MCP** for interactive browser tasks — poking around, testing UI, taking screenshots, inspecting state. It's faster, handles CodeMirror typing natively, and supports annotated screenshots with element labels. For the Tauri app (desktop, Android, iOS), use the Tauri MCP bridge tools (`driver_session`, `webview_*`) — the bridge is included in debug builds on all platforms.

When switching sync servers in debug builds, prefer the dev-only `window.__testSync` hook over UI automation. It is exposed in Tauri dev webviews and supports:

- `await window.__testSync.connect(serverUrl, password)`
- `await window.__testSync.status()`
- `await window.__testSync.syncNow()`
- `await window.__testSync.disconnect()`

For Android emulator runs, use `10.0.2.2` instead of `127.0.0.1` for host services.

## Key Constraints

- **The filename IS the title.** `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space, no transformations. `sanitizeFilename()` only strips filesystem-breaking characters. Never mutate filenames into titles.
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **IMPORTANT**: `pnpm run dev` uses localhost APIs. `pnpm run build` points to production endpoints.
- **IMPORTANT**: `pnpm run build` must run from monorepo root. Running from a workspace resolves a different build script — verify output includes `vite build` and `dist/assets/`.
- **IMPORTANT**: Tauri dev ports are split by target to avoid collisions: desktop `5180`, Android `5181`, iOS `5182`.
- **IMPORTANT**: `window.confirm()`/`window.alert()` don't block properly in Tauri's webview. Use `ask()`/`message()` from `@tauri-apps/plugin-dialog` instead.
- **CRITICAL: Dev builds MUST NOT touch the user's production notes folder (`~/Documents/stonefruit`).**
  - Debug builds default the notes root to **`~/Documents/fake-notes`** (see `default_notes_root` in `apps/tauri/src-tauri/src/core.rs`). Release builds default to `~/Documents/stonefruit`. Do not remove or weaken this guard when refactoring path resolution.
  - The TS resolver (`src/lib/platform/tauriPaths.ts:getDefaultNotesRoot`) must delegate to the Rust `resolve_default_notes_root` command — never resolve the default in JS, because `documentDir()` gives the same path in dev and release.
  - `STONEFRUIT_DATA_DIR` env var overrides both (used by `scripts/tauri-dev.mjs` and cross-platform tests for per-worktree isolation — writes go to `{data_dir}/notes`).
  - Dev sync points at the external E2EE server when configured. Release builds start empty.

## Push Concerns Down, Not Out

When adding cross-cutting behavior (auth, validation, error handling, coordination, persistence), make it an infrastructure concern — not something every call site must remember. If an agent (or a human) forgetting to add a line would cause a bug, that line shouldn't need to exist.

**Good examples already in this repo:**
- Filename/path safety is pushed down to `packages/shared/src/filename.ts` and `stonefruit-core` — callers don't think about filesystem rules.
- Platform-specific I/O is behind `src/lib/platform/index.ts` — components never branch on platform.
- `src/lib/syncServiceE2ee.ts` centralizes E2EE sync fetches, auth tokens, encryption, and object-map persistence.

**When writing new code:** If you find yourself copying a pattern from another file (auth headers, try/parse/catch, validation checks), stop and check whether a shared helper already exists or should be created. The less each feature has to do, the fewer ways it can go wrong.

## Close The Loop (Required)

Do not report a fix or addition as complete until you verify it. If verification fails, iterate until it passes.

**Pick the right verification chain for the change:**

| What changed | Verification |
|---|---|
| Frontend / UI / Svelte | `just build` → `pnpm run test -- <spec>` (broaden Playwright coverage if risk is broad) |
| Unit-testable logic | `just build` → `just test-unit` |
| Shared package | `just test-shared` |
| CSS / Tailwind only | `just build` (catches missing classes) → visual spot-check via Playwright screenshot |
| Sync client stack (full) | `just test-cross-platform` (boots 2 Tauri instances + server, runs 12 scenarios) |
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

- Regression tests: `tests/p0-regressions.spec.ts` (crash/IME), `tests/p1-regressions.spec.ts` (links), `tests/p2-regressions.spec.ts` (title/formatting)
- Markdown spec + cursor movement coverage: `tests/markdown-spec.spec.ts` and `markdown-spec/cases/**`. The movement-path editor cases run in CI via `pnpm run test:markdown-spec`.
- Some Android-native issues (IME, status bar) require device QA even when Playwright passes

## Test Requirements

Every code change that touches logic must include or update tests. No exceptions.

### When to add tests

| What you changed | Required test |
|---|---|
| New Tauri `#[tauri::command]` | Rust unit test in `core.rs` for the underlying `_impl` function |
| Sync logic | Unit tests for client logic here; server tests live in `/home/justin/Developer/stonefruit-server` |
| Shared package (`@futo-notes/shared`) | Unit test in `packages/shared/` |
| Bug fix (any layer) | Regression test that reproduces the bug BEFORE the fix, then passes after |
| New UI interaction or flow | Playwright spec in `tests/` |
| Full-stack sync (client ↔ server) | Cross-platform scenario in `tests/cross-platform-sync.mjs` |
| Path/filename handling | Both: server test (sanitization) + Rust test (path safety) |

### Where tests live

- **Rust core**: `apps/tauri/src-tauri/src/core.rs` `#[cfg(test)]` module. Test `_impl` functions directly.
- **Shared package**: `packages/shared/src/*.test.ts`.
- **Playwright E2E**: `tests/*.spec.ts`.
- **Cross-platform sync**: `tests/cross-platform-sync.mjs`. Two real Tauri instances + server, 12 multi-client scenarios through the full client stack. Shared helpers in `tests/lib/`.
- **What cross-platform now covers well**: real CodeMirror typing and save flush, real `syncManager` completion handling, open-note remote rename propagation, active-note reload, edit-during-sync draft protection, and native watcher behavior for clean vs dirty open notes.

### How to run

| Suite | Command |
|---|---|
| Rust tests | `just test-rust` |
| Shared package | `just test-shared` |
| Unit tests | `just test-unit` |
| Playwright E2E | `just test-e2e` |
| Cross-platform sync | `just test-cross-platform` |
| Everything | `just test` then `just test-e2e` |

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
