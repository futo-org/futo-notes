# AGENTS.md - FUTO Notes

@README.md for project overview. @justfile for all commands.

## Quick Start

```bash
just install         # Install all workspace dependencies
just tauri-dev       # Tauri DESKTOP dev (Wayland-first, fixed port 5180)
just build           # TypeScript check + Vite build → dist/
just check           # Lint + tests + build sanity pass
# Mobile = NATIVE shells (see below), NOT the Tauri mobile shell:
just ios-native         # Native iOS app on a booted simulator
just ios-native-device  # Native iOS app on a connected iPhone (Debug)
just android-native     # Native Android (Compose) app on device/emulator
```

> **CRITICAL — mobile is native, not Tauri.** When asked to run, build, or
> **install the app on a phone (iPhone/Android)**, use the **native shells** in
> `apps/ios` and `apps/android` — NOT the Tauri mobile recipes. The Tauri iOS
> recipes (`ios-dev`, `ios-offline`, `deploy-ios`, bundle id `com.futo.notes`)
> and Android (`android-dev`, `android-offline`) are the **legacy** webview
> shell; we now ship native SwiftUI/Compose apps on the shared Rust core
> (`futo-notes-ffi`) with an embedded editor. Native bundle ids are
> `com.futo.notes.native` (Release) / `com.futo.notes.native.dev` (Debug) —
> distinct from Tauri's, so they can coexist. Don't run `deploy-ios`/`ios-dev`
> for a "install on my phone" request.
>
> **Production native on a physical iPhone:** `just ios-native-device` only
> builds Debug (`com.futo.notes.native.dev`). For a Release/production install,
> run that script's pipeline (`build-rust-ios.sh` → `vite build --config
> vite.editor.config.ts` → `xcodegen generate` in `apps/ios`) then
> `xcodebuild -scheme FutoNotesNative -configuration Release -destination
> 'generic/platform=iOS' -allowProvisioningUpdates` and install the resulting
> `FutoNotesNative.app` with `xcrun devicectl`. If the editor bundle build fails
> with a missing `vite-plugin-singlefile`, run `pnpm install` first (stale
> node_modules). A locked iPhone yields `FBSOpenApplicationErrorDomain error 7`
> on launch — unlock and relaunch.

**Always use `just` from the monorepo root.** All Tauri commands (dev, build, deploy) live in the justfile — never call `cargo tauri` directly, because the justfile encodes the correct config overlays (dev bundle IDs, ORT fetch steps, device detection). The package.json only has toolchain scripts (vite, vitest, playwright, eslint).

## Monorepo

npm workspaces. Shared Svelte app at root, platform shells in `apps/`, shared packages in `packages/`.

```
src/                  ← Shared Svelte 5 app (editor, UI, sync client)
crates/
  futo-notes-core/    ← Rust crate (hashing, sync payload, search vectors, graph layout)
apps/
  tauri/              ← Tauri v2 desktop + mobile shell (Rust backend)
packages/
  shared/             ← Shared TS types & utils (auth types, filename rules, tag parsing)
```

- **Client stack**: Svelte 5 + Tauri v2 + Vite + Tailwind v4 + CodeMirror 6
- **Sync server**: External E2EE server at `/home/justin/Developer/futo-notes-server` ([GitLab](https://gitlab.futo.org/futo-notes/futo-notes-server)). The client uploads opaque encrypted blobs through collection/object/blob APIs.
- **Rust crates**: `futo-notes-model` owns the note domain — CRUD (`scan_notes`, `read_note`, `write_note`, `create_note`, `delete_note`, `rename_note`, `move_note`, `create_folder`), the note rules (`sanitize_title`, `make_id`, `split_id`, `extract_tags`, `extract_wikilinks`, `make_preview`), and full-text search. `futo-notes-core` owns hashing, sync payload prep/apply, vector search (UMAP + K-Means), graph layout, and merge. Both are imported by the Tauri app (via `apps/tauri/src-tauri/src/notes.rs`, `search.rs`) and by the native shells (via the `futo-notes-ffi` UniFFI crate). Do not reimplement logic that exists in these crates — there is one definition of every note rule and CRUD primitive, shared across all three apps.
- **Tauri ↔ TS boundary**: The note domain lives in Rust and is reached through `#[tauri::command]` wrappers (`notes_*`, `search_notes`) registered with `tauri::generate_handler!`. (The note rules live in `futo-notes-model` but are not behind Tauri commands: desktop calls the conformance-locked TS copy `src/lib/rules.ts` to avoid a per-keystroke IPC hop, and the native shells reach them via the `futo-notes-ffi` facade.) TypeScript (`src/lib/`) owns the Svelte UI, reactive app state (`notesCache` in `notes.svelte.ts`), sync coordination, and the platform shell; it calls the Rust commands rather than touching `@tauri-apps/plugin-fs` for note I/O. The hard never-gate-render constraint is unchanged: the scan that populates `notesCache` runs un-awaited after `initialized = true` (see Key Constraints), so a slow Rust scan can only delay list population, never the shell.
- **Shared package** (`@futo-notes/shared`): Auth protocol types and image-extension validation (`IMAGE_EXTENSIONS`, `isImageFilename`) consumed by both the client and the external sync server. Filename and tag rules (`sanitizeTitle`, `validateTitle`, `extractTags`) duplicate `futo-notes-model`'s canonical Rust rules; the TS copies are kept deliberately (desktop per-keystroke paths and the sync server) and held bit-for-bit in lockstep via `tests/conformance/*` — there are no `rules_*` Tauri commands. Consumed as TypeScript source (no build step).

## Where Logic Lives

**The note domain is Rust.** CRUD, note rules (title/tag/id/wikilink/preview), and full-text search live in `futo-notes-model` and are shared verbatim by the Tauri app and the native iOS/Android shells. Do not re-implement any of these in TypeScript — call the `notes_*` / `search_notes` commands. (The note rules are the one exception: they are not exposed as Tauri commands — desktop uses the conformance-locked TS copy `src/lib/rules.ts` to dodge a per-keystroke IPC hop, native uses the FFI facade, both held in lockstep with `futo-notes-model`.) This single-source rule is what keeps the three apps behaviorally identical; a rule that exists in two places will drift.

**TypeScript owns the UI and reactive state.** The Svelte components, `notesCache` and its derived stores, sync coordination, tab/session state, and the platform shell stay in TS — that is where TS's ergonomics and the lack of an IPC round-trip pay off. When adding code that is plainly view/state logic, write it in TS; when it is a note rule or a filesystem mutation on the note tree, route it through Rust. Reserve net-new Rust for the note domain and the existing compute-heavy paths (vector math, sync delta, hashing); ad-hoc OS access the platform layer already covers (filesystem watcher, clipboard image extraction) stays where it is.

## Platform Build & Webview Notes

### Android emulator — running JS against the webview

Tauri apps enable CSP which blocks ad-hoc inline scripts, so `webview_execute_js` through the MCP bridge fails with *"Resolve-ref helper was not available"*. On Android the webview DevTools socket is exposed and bypasses CSP. Use it via:

```bash
# Find the socket name for the running com.futo.notes process
adb shell 'cat /proc/net/unix' | grep webview_devtools_remote
# → @webview_devtools_remote_<pid>

# Forward and invoke
adb forward tcp:9228 localabstract:webview_devtools_remote_<pid>
node scripts/cdp-invoke.mjs "await window.__TAURI__.core.invoke('my_command', { arg: 1 })"
```

`scripts/cdp-invoke.mjs` wraps the Chrome DevTools Protocol in a tiny wrapper that calls `Runtime.evaluate` with `awaitPromise:true`. Useful for any Tauri command on Android, not just inference.

### Android — ONNX Runtime `.so` for the inference crate

The Android build of `futo-notes-inference` links against `libonnxruntime.so` dynamically (via the `load-dynamic` feature). Tauri's Gradle plugin doesn't fetch it; `scripts/fetch-ort-android.mjs` does. Run before `cargo tauri android build`:

```bash
# Fetches Microsoft's ONNX Runtime Android AAR from Maven, extracts the per-ABI
# .so into apps/tauri/src-tauri/gen/android/app/src/main/jniLibs/<abi>/.
node scripts/fetch-ort-android.mjs                          # default: arm64-v8a
node scripts/fetch-ort-android.mjs --abis arm64-v8a,x86_64  # + emulator
```

Version is pinned to `ort-sys 2.0.0-rc.12`'s target (ORT 1.24.2). If you bump the `ort` dep, bump `DEFAULT_VERSION` in the fetch script. The `.so` files are gitignored.

### Linux — ONNX Runtime `.so` for the inference crate

On Linux the `futo-notes-inference` crate uses ORT's `load-dynamic` feature:
ORT is NOT statically linked at build time. Instead, `scripts/fetch-ort-linux.mjs`
downloads Microsoft's official `onnxruntime-linux-x64-${ver}.tgz` (glibc 2.17
floor, no `__isoc23_*` symbols — so it links on any distro the `.deb`/`.rpm`
targets) and drops `libonnxruntime.so` into `apps/tauri/src-tauri/gen/linux/`
plus `target/{debug,release}/`.

```bash
# Fetches to apps/tauri/src-tauri/gen/linux/libonnxruntime.so.
node scripts/fetch-ort-linux.mjs
```

`init_ort_dylib_path()` in `lib.rs` sets `ORT_DYLIB_PATH` at app startup by
looking for the `.so` next to the exe (AppImage, dev) or in
`../lib/futo-notes/` (`.deb`/`.rpm` install layout). `tauri.conf.json`'s
`bundle.linux.{deb,rpm,appimage}.files` maps the `.so` into the right place
in each package. Version is pinned to `ort-sys 2.0.0-rc.12`'s target (ORT
1.24.2). If you bump the `ort` dep, bump `DEFAULT_VERSION` in the fetch
script in lockstep with the Android and iOS scripts.

### iOS — ONNX Runtime xcframework for the inference crate

The iOS build of `futo-notes-inference` links ORT statically via an xcframework with CoreML EP. `scripts/fetch-ort-ios.mjs` downloads Microsoft's prebuilt pod-archive and extracts the xcframework. Run before `cargo tauri ios build`:

```bash
# Downloads ~50 MB, extracts to apps/tauri/src-tauri/gen/apple/onnxruntime.xcframework/
node scripts/fetch-ort-ios.mjs
```

The xcframework path is automatically set via `ORT_IOS_XCFWK_PATH` in the Xcode pre-build script (`project.yml`). The `just deploy-ios` recipe includes this step. The xcframework is gitignored.

## Behavioral Spec — Source of Truth

`docs/spec/` is the source of truth for **what the app should do**, by surface
(editor, list, nav, search, settings, sync, plus cross-cutting `app.md`). It
spans all three apps — Tauri desktop, native iOS, native Android — so a
requirement exists in one place even when a platform doesn't satisfy it yet.

- **Before** changing behavior in an area, read `docs/spec/<area>.md` so you
  don't break an existing requirement.
- **After** establishing or changing a behavior, add or update the line.
- A known missing/divergent behavior is recorded as a `> **Gap:**` note — surface
  these when relevant; don't silently leave them undocumented.

This is the behavioral layer. It sits above `tests/conformance/*.json` (TS↔Rust
rule parity) and `markdown-spec/cases/*.yaml` (editor decoration/cursor
fixtures) — reference those, don't duplicate them.

## Key Constraints

- **CRITICAL: never gate UI render on filesystem I/O.** `App.svelte` flips `initialized = true` synchronously; theme, prefs, notes, and the search index all load in the background and apply reactively. Past hangs (`bootstrapSearchIndex`, `scanNotePreviewsWithBodies`, `loadPreferences`, even `getPlatformFS`) all came from awaiting something — anything — before flipping `initialized`. The note scan is now a single Rust command (`invoke('notes_scan')`) fired from inside the already-backgrounded `initNotes()` promise, which does its own `notes_root()` + `create_dir_all` — so the iOS cold-sandbox `@tauri-apps/plugin-fs` hang class no longer sits in front of the scan. The rule is unchanged regardless of data source: do not add any `await` (including `await invoke('notes_scan')`) before `initialized = true`. A hung/slow scan can only delay list population, never the shell. Render the shell with empty state; let `$state` updates propagate.
- **The filename IS the title.** `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space, no transformations. `sanitizeFilename()` only strips filesystem-breaking characters. Never mutate filenames into titles.
- **IMPORTANT**: Styles in `@layer(components)` lose to CM6's unlayered CSS. Use `!important` on CodeMirror overrides inside layered CSS.
- **IMPORTANT**: `pnpm run dev` uses localhost APIs. `pnpm run build` points to production endpoints.
- **IMPORTANT**: `pnpm run build` must run from monorepo root. Running from a workspace resolves a different build script — verify output includes `vite build` and `dist/assets/`.
- **IMPORTANT**: Tauri dev ports are split by target to avoid collisions: desktop `5180`, Android `5181`, iOS `5182`.
- **IMPORTANT**: `window.confirm()`/`window.alert()` don't block properly in Tauri's webview. Use `ask()`/`message()` from `@tauri-apps/plugin-dialog` instead.
- **CRITICAL: Dev/debug builds MUST NOT overwrite the user's production app or notes.**
  - **Bundle ID**: Dev/debug builds must use `com.futo.notes.dev` (product name "FUTO Notes Dev"). Pass `--config src-tauri/tauri.ios.dev.conf.json` (iOS) or `--config src-tauri/tauri.dev.conf.json` (desktop) to `cargo tauri build --debug`. Never run `cargo tauri ios build --debug` without the dev config — it installs over the production app. The `just` recipes (`ios-dev`, `ios-offline`, `tauri-dev`) handle this automatically.
  - **Notes root**: Debug builds default to **`~/Documents/fake-notes`** (see `default_notes_root` in `apps/tauri/src-tauri/src/core.rs`). Release builds default to `~/Documents/futo-notes`. Do not remove or weaken this guard.
  - The TS resolver (`src/lib/platform/tauriPaths.ts:getDefaultNotesRoot`) must delegate to the Rust `resolve_default_notes_root` command — never resolve the default in JS, because `documentDir()` gives the same path in dev and release.
  - `FUTO_NOTES_DATA_DIR` env var overrides both (used by `scripts/tauri-dev.mjs` and cross-platform tests for per-worktree isolation — writes go to `{data_dir}/notes`).
  - Dev sync points at the external E2EE server when configured. Release builds start empty.

## Push Concerns Down, Not Out

When adding cross-cutting behavior (auth, validation, error handling, coordination, persistence), make it an infrastructure concern — not something every call site must remember. If an agent (or a human) forgetting to add a line would cause a bug, that line shouldn't need to exist.

**Good examples already in this repo:**
- Filename/path safety is pushed down to `packages/shared/src/filename.ts` and `src/lib/platform/pathSafety.ts` — callers don't think about filesystem rules.
- Platform-specific I/O is behind `src/lib/platform/index.ts` — components never branch on platform.
- `src/lib/syncServiceE2ee.ts` centralizes E2EE sync fetches, auth tokens, encryption, and object-map persistence.

**When writing new code:** If you find yourself copying a pattern from another file (auth headers, try/parse/catch, validation checks), stop and check whether a shared helper already exists or should be created.

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

For demos, migrations, or "make the whole thing work on my machine" requests — own the full client + server + data + launcher path until the user can open the app and see the result. Do not hand off operational steps you can do yourself.

## GitLab CI

`$GITLAB_TOKEN` available in shell (from `~/.zshrc`):

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/pipelines?ref=main&per_page=1"
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
| Sync logic (client) | Unit tests in `src/lib/` + cross-platform tests when protocol changes |
| Shared package (`@futo-notes/shared`) | Unit test in `packages/shared/` |
| Bug fix (any layer) | Regression test that reproduces the bug BEFORE the fix, then passes after |
| New UI interaction or flow | Playwright spec in `tests/` |
| Full-stack sync (client ↔ server) | Cross-platform scenario in `tests/cross-platform-sync.mjs` |
| Path/filename handling | Shared package test + TS platform test (`pathSafety.test.ts`) |

### Where tests live

- **Rust core**: `crates/futo-notes-core/src/*.rs` `#[cfg(test)]` modules + `crates/futo-notes-core/tests/`.
- **Tauri commands**: `apps/tauri/src-tauri/src/core.rs` `#[cfg(test)]` module. Test `_impl` functions directly.
- **Shared package**: `packages/shared/src/*.test.ts`.
- **Playwright E2E**: `tests/*.spec.ts`.
- **Unit tests**: `src/lib/*.test.ts` — notes, search index, sync, platform modules.
- **Cross-platform sync**: `tests/cross-platform-sync.mjs`. Two real Tauri instances + server, 12 multi-client scenarios through the full client stack. Shared helpers in `tests/lib/`.

### How to run

| Suite | Command |
|---|---|
| Rust tests | `just test-rust` |
| Shared package | `just test-shared` |
| Unit tests | `just test-unit` |
| Playwright E2E | `just test-e2e` |
| Cross-platform sync | `just test-cross-platform` |
| Everything | `just test` then `just test-e2e` |

## Browser Tools

**Use `agent-browser` over Playwright MCP** for interactive browser tasks — poking around, testing UI, taking screenshots, inspecting state. It's faster, handles CodeMirror typing natively, and supports annotated screenshots with element labels. Run `agent-browser` with no args to see the full command reference and tips. For the Tauri app (desktop, Android, iOS), use the Tauri MCP bridge tools (`driver_session`, `webview_*`) — the bridge is included in debug builds on all platforms.

When switching sync servers in debug builds, prefer the dev-only `window.__testSync` hook over UI automation. It is exposed in Tauri dev webviews and supports:

- `await window.__testSync.connect(serverUrl, password)` — simplified connect (auto-creates test user)
- `await window.__testSync.connectE2ee(serverUrl, email, name, password)` — explicit E2EE connect
- `await window.__testSync.status()`
- `await window.__testSync.syncNow()` — trigger sync (uses stored credentials)
- `await window.__testSync.syncE2ee(password)` — sync with explicit password
- `await window.__testSync.disconnect()` / `disconnectE2ee()`

For Android emulator runs, use `10.0.2.2` instead of `127.0.0.1` for host services.

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
