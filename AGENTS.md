# AGENTS.md — FUTO Notes Operating Manual

@README.md for project overview. @justfile for all commands.

FUTO Notes is an offline-first markdown notes app: one Svelte 5 web editor and one shared Rust
core, shipped as **three apps** — Tauri desktop, native SwiftUI iOS, native Compose Android — with
optional E2EE sync against an external server. This file is the operating manual: where code goes,
the named mistakes that recur in this codebase and the rule that prevents each, what "done" means
per kind of change, and exactly when to stop and ask.

Every rule here is load-bearing. Rules marked **CRITICAL** protect user data or shipped behavior —
never weaken one to make a test pass, a build compile, or a pipeline go green.

---

## 1. Quick start

```bash
just install         # Install all workspace dependencies
just tauri-dev       # Tauri DESKTOP dev (Wayland-first, fixed port 5180)
just build           # TypeScript check + Vite build → dist/
just check           # spec-gaps + toolbar-spec + rust conformance + lint + tests + build
# Mobile = NATIVE shells (see §2), NOT Tauri:
just ios-native         # Native iOS app on a booted simulator
just ios-native-device  # Native iOS app on a connected iPhone (Debug)
just android-native     # Native Android (Compose) app on device/emulator
```

**Always use `just` from the monorepo root.** The justfile encodes config overlays, dev bundle
IDs, per-worktree isolation, and device detection. Never call `cargo tauri` directly. The
package.json has toolchain scripts only (vite, vitest, playwright, eslint).

## 2. CRITICAL — mobile is native, not Tauri

When asked to run, build, or install the app on a phone, use the **native shells** in `apps/ios`
and `apps/android`. There is no Tauri mobile shell — the legacy `cargo tauri ios/android` recipes
were **removed**. The native apps are SwiftUI/Compose on the shared Rust core (`futo-notes-ffi`)
with an embedded web editor.

| Goal | Command |
| --- | --- |
| iOS on the booted simulator | `just ios-native` |
| iOS on a connected iPhone (Debug, `com.futo.notes.dev`) | `just ios-native-device` |
| iOS **Release** on a connected iPhone (prod `com.futo.notes`) | `just deploy-ios` |
| Android (Compose) on a device/emulator | `just android-native` |
| Compile-only sanity (no install) | `just build-ios-native` / `just build-android-native` |

Gotchas: a missing `vite-plugin-singlefile` during the editor-bundle build means stale
node_modules — run `pnpm install`. A locked iPhone yields `FBSOpenApplicationErrorDomain error 7`
on launch — unlock and relaunch.

## 3. Monorepo map

pnpm workspaces + a Cargo workspace. Layer-specific conventions live in nested AGENTS.md files
(`src/`, `apps/tauri/`, `crates/futo-notes-core/`, `docs/spec/`, `factory/`) —
read the one for the layer you're editing.

```
src/                    ← Shared Svelte 5 app (UI, reactive state, sync coordination)
  lib/rules.ts          ← Hot-path shim re-exporting the note rules from @futo-notes/editor
  lib/platform/         ← PlatformFS abstraction (tauri.ts / web.ts), pathSafety, tauriPaths
  editor-embed/         ← Entry for the single-file editor.html embedded in the native shells
crates/
  futo-notes-core/      ← Hashing, E2EE crypto, sync payload prep/apply, 3-way merge,
                          path safety + title primitives (files.rs)
  futo-notes-model/     ← THE NOTE DOMAIN: CRUD, rules (id/tags/wikilinks/preview), scan
  futo-notes-sync/      ← E2EE SyncSession (push-first cycles), SSE live loop
  futo-notes-search/    ← Tantivy BM25 engine + background indexer
  futo-notes-ffi/       ← Single UniFFI facade for native shells (NoteStore, SearchEngine,
                          SyncClient, rule functions). Generated bindings are gitignored.
apps/
  tauri/                ← Tauri v2 DESKTOP shell (notes_* / search_* / e2ee_* / fs_* commands)
  ios/                  ← Native SwiftUI app (xcodegen; Sources/Generated is generated)
  android/              ← Native Compose app (UniFFI Kotlin bindings + jniLibs are generated)
packages/
  editor/               ← Canonical TS hot-path note/image rules + the versioned futoBridge contract +
                          the toolbar manifest (toolbar.ts — source of truth for native toolbars)
docs/spec/              ← Behavioral source of truth for all three apps (§10)
tests/                  ← Playwright E2E, conformance fixtures, cross-platform sync harness
markdown-spec/          ← Editor decoration/cursor fixture corpus (YAML cases)
factory/                ← Obsidian-as-oracle editor comparison harness
```

- **Sync server**: external repo at `~/Developer/futo-notes-server`
  ([GitLab](https://gitlab.futo.org/futo-notes/futo-notes-server)). The client uploads opaque
  encrypted blobs; content is encrypted client-side.

## 4. Where logic lives (decision procedure)

Ask, in order:

1. **Is it a note rule or a filesystem mutation on the note tree?** → Rust
   (`futo-notes-model` / `futo-notes-core`). Reach it via `notes_*`/`search_*` Tauri commands on
   desktop and the `futo-notes-ffi` facade on native. **Never re-implement it in TS, Swift, or
   Kotlin** — one definition, three consumers, is what keeps the apps behaviorally identical.
2. **Is it one of the note rules needed per keystroke?** (title/tag/id/preview/image) → the ONE
   sanctioned exception: a conformance-locked TS copy lives in
   `packages/editor/src/{filename,tags,preview,images}.ts`, imported through the editor facade.
   Rust stays canonical; the TS copy is held bit-for-bit by `tests/conformance/*` (§7.3).
3. **Is it view/reactive state/sync coordination/platform shell?** → TypeScript (`src/lib/`,
   components). `notesCache` in `notes.svelte.ts` is the single reactive source of truth.
4. **Is it compute-heavy or protocol-shaped?** (vector math, sync delta, hashing, crypto) → Rust.
5. **Is it ad-hoc OS access already covered by the platform layer?** (watcher, clipboard) → leave
   it where it is; extend `PlatformFS`, never branch on platform inside components
   (`pnpm run lint:platform` enforces this).
6. **Is the workflow two domain calls in sequence?** (create-then-write, rename-then-relink) → the
   workflow itself belongs in the domain (Rust `_impl` / FFI verb), not stitched together at every
   call site — otherwise each shell must remember the ordering invariant and one WILL drift (M6/M7).

**Push concerns down, not out.** If forgetting to add a line at every call site would cause a bug,
that line belongs in infrastructure. Existing examples: filename/path safety
(`packages/editor/src/filename.ts`, `src/lib/platform/pathSafety.ts`,
`futo_notes_core::files`), platform I/O behind `src/lib/platform/index.ts`, E2EE fetch/auth/
persistence centralized in `src/lib/syncServiceE2ee.ts`. Before copying a pattern from another
file (auth headers, try/parse/catch, validation), check whether a shared helper exists or should.

## 5. Conventions

### Code — TypeScript / Svelte
- Svelte 5 runes only: `$state`/`$derived`/`$effect`, module-level state in `.svelte.ts` files
  exposed as functions/getter-objects. **Never** `svelte/store`, `on:click`, or
  `createEventDispatcher` — use `onclick={...}` attributes and callback props
  (`onclose?`, `onchange?`). Props: `interface Props {...}` + `let {...}: Props = $props()`.
- Inside `$effect`, read callbacks/objects like `scrollParent`/`onchange` **lazily inside inner
  callbacks**, not in the effect body — otherwise they become dependencies and destroy/recreate
  the editor.
- Note/file I/O goes through `getFS()`/`getPlatformFS()` (the `PlatformFS` interface) — never raw
  `invoke()` or `@tauri-apps/plugin-fs` in components. Sync and search have their own dedicated
  shims (`syncServiceE2ee.ts`, `searchEngine.ts`); add new commands to the matching shim.
- Optimistic cache mutations must revert on failure before rethrowing (see
  `notes.svelte.ts:moveNote`). Shims backing a fallback return `null` rather than throw
  (`searchEngine.ts`). User-facing sync errors funnel through `getSyncErrorMessage()`.
- Never hand-build note paths: `pathSafety.ts` (TS) / `futo_notes_core::files::safe_note_path`
  (Rust).
- New persisted setting: add the field to `AppState` (`src/lib/appState.ts`), guard it in
  `sanitize()`, default it in `defaultState()`, thread through the `AppPreferences` facade.
  UI-layout state (sidebar width, open folders, tabs) goes in `.app-config.json` via
  `getConfig`/`saveConfig`.
- Toasts from non-component code: `showGlobalToast()`. Dialogs: `confirmDialog()` /
  `ask()`/`message()` from `@tauri-apps/plugin-dialog` — **`window.confirm()`/`alert()` do not
  block in Tauri's webview.**

### Code — Rust
- Every Tauri command: `pub async fn`, FS work in `tauri::async_runtime::spawn_blocking`,
  `Result<T, String>`, errors mapped with `task_join_err`. Commands wrap a pure
  `*_impl(base: &Path, ...)` that the `#[cfg(test)]` module tests directly.
- Every note-tree mutation registers its filenames in the watcher-suppression map (5s window)
  **before** writing, so the app doesn't react to its own writes (see `note_commands.rs` head comment).
- Tempdirs in tests are hand-rolled (`temp_dir().join(format!(...))` + `AtomicU32` counter + pid)
  — no `tempfile` crate. Env-var tests serialize on a `static Mutex`.
- FFI errors are `#[derive(uniffi::Error, thiserror::Error)]` enums. The FFI builds use the dev
  profile (iOS) / `release-ffi` profile (Android) because the workspace release profile's
  `panic = "abort"` breaks UniFFI's `catch_unwind` — never "fix" the FFI build by switching it to
  the plain release profile.

### CSS
- Tailwind v4; theme tokens in the `@theme` block of `src/styles/app.css`; dark mode via
  `[data-theme='dark']` overrides (no `dark:` variant).
- **IMPORTANT**: styles in `@layer(components)` lose to CodeMirror's unlayered CSS. CM6 overrides
  need `!important` inside layered CSS; `editor-ux.css` is imported unlayered on purpose.

### Git / process
- Commits: `type(scope): imperative summary` — types `feat|fix|docs|chore|ci|perf|refactor|build|test`,
  scopes are surfaces/platforms (`android`, `ios`, `editor`, `sync`, `ci`, ...). Nontrivial fixes
  get a body naming the exact failure (pipeline number, error string), the root cause, and a
  verification line ("Verified: assembleDebug green; …").
- Features and risky work go through branches + GitLab MRs; small self-contained fixes may land on
  main. Land migrations and perf work as **small per-concern commits** so pieces can be reverted
  individually.
- Releases are annotated `vX.Y.Z` tags. Android `versionCode = MAJOR*1e6 + MINOR*1e3 + PATCH`.
- GitLab API access: `$GITLAB_TOKEN` is in the shell:
  ```bash
  curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/pipelines?ref=main&per_page=1"
  ```

### Docs
- Behavior changes update `docs/spec/<area>.md` in the same change (§10).
- Hard-won debugging knowledge (a class of bug, not a single fix) becomes a
  `docs/learnings/*.md` postmortem.

## 6. Named mistakes — and the rule that prevents each

These are the failure modes that actually recur in this repo's history. If you feel yourself about
to do one, stop and apply the rule.

### A. Data and render safety (CRITICAL)

- **M1 — Gated render.** Awaiting *anything* (prefs, scan, `getPlatformFS`, `invoke`) before
  `App.svelte` flips `initialized = true`. Every historical hang came from this.
  **Rule:** `initialized = true` flips synchronously; all loads run un-awaited afterward and apply
  reactively. Render the shell with empty state. A slow scan may delay list population, never the
  shell. Native mirrors this: I/O on `NoteVault` actor / `Dispatchers.IO`, `hasBootstrapped`
  distinguishes loading from empty.
- **M2 — Title transformation.** "Improving" a filename into a title (case, dash→space).
  **Rule:** the filename IS the title. `"grocery list.md"` → `"grocery list"`. `sanitizeTitle()`
  only strips filesystem-breaking characters. Never mutate filenames into titles.
- **M3 — Dev build touches prod data.** A debug build writing the user's real notes, or dev/prod
  resolving the same path. This burned badly enough to become three layered guards.
  **Rule:** dev/debug = bundle id `com.futo.notes.dev` ("FUTO Notes Dev") + notes root
  `~/Documents/fake-notes` (release: `com.futo.notes` + `~/Documents/futo-notes`). The split lives
  in Rust `default_root` (`apps/tauri/src-tauri/src/vault_location.rs`), iOS
  `#if FUTO_DEBUG_BUILD`, Android `BuildConfig.DEBUG`. The TS resolver MUST delegate to the Rust
  `resolve_default_notes_root` command — `documentDir()` looks identical in dev and release, so
  resolving in JS silently points dev at prod. `FUTO_NOTES_DATA_DIR` overrides both (worktree/test
  isolation). Never remove or weaken any of this.
- **M4 — Piecemeal destructive reset.** Wiping disk state but leaving module-level caches alive
  (`appState`, sync version watermarks), so the next sync resumes from a stale watermark and
  pulls nothing. **Rule:** a destructive reset must reset every module-level cache — stop live
  sync first, and prefer reloading the webview/process over trusting piecemeal invalidation.
- **M5 — Editor jank introduced by background work.** **Rule:** editor responsiveness is sacred.
  Sync, indexing, and saves must never block or delay typing; anything per-keystroke stays
  synchronous TS (see §4.2), everything else is backgrounded.

### B. The single-source rule

- **M6 — Reimplementing a note rule.** Writing tag/title/preview/CRUD logic in TS/Swift/Kotlin
  because it's "just a small helper". A rule that exists in two places WILL drift.
  **Rule:** the note domain is Rust (§4). If you need a rule in TS, it must already be in
  `packages/editor` and imported via `src/lib/rules.ts`; if it isn't there, add it to Rust and the
  conformance fixtures first.
- **M7 — One-sided rule edit.** Changing a rule in TS or Rust without the other side + fixtures.
  **Rule:** any rule change touches canonical TS (`packages/editor`) AND Rust
  (`futo-notes-model`), then regenerates fixtures (`pnpm exec tsx tests/conformance/generate.mjs`)
  and runs BOTH consumers (§7.3). CI's `--check` will catch you, but locally is cheaper.
- **M8 — Editing generated files.** `docs/spec/GAPS.md`, `ToolbarSpec.swift`/`ToolbarSpec.kt`,
  `apps/ios/Sources/Generated/*`, Android `uniffi/` bindings + `jniLibs`, `editor.html`.
  **Rule:** edit the source of truth (spec gap notes / `packages/editor/src/toolbar.ts` / the FFI
  crate / the web editor) and regenerate (`just spec-gaps`, `just toolbar-spec`,
  `scripts/build-rust-{ios,android}.sh`, `vite build --config vite.editor.config.ts`).
- **M9 — Stale FFI bindings.** Changing `futo-notes-ffi` (or a crate it re-exports) and testing
  against a native app built with old bindings — symptoms look like "my change did nothing" or
  Kotlin/Swift compile errors on missing symbols. **Rule:** after any FFI-visible crate change,
  rebuild via `just build-rust-ios` / `just build-rust-android` before building the shells (the
  `just *-native` recipes do this; direct `xcodebuild`/gradle invocations do not).
- **M10 — New cross-shell surface added to one shell.** A new `futoBridge` message or toolbar item
  handled on only one platform. **Rule:** the bridge contract (`packages/editor/src/bridge.ts`,
  `BRIDGE_VERSION`) is the source of truth; a new message needs BOTH hand-written hosts
  (`EditorWebView.swift` + `EditorWebView.kt`). Toolbar items go in `toolbar.ts` + regenerate
  (`just toolbar-spec`); behavior goes in the shared `TOOLBAR_EXEC` map — never in a shell.

### C. CI and release (the single most-churned area of this repo)

- **M11 — Silent green.** Special-casing an error to `exit 0` (or `-f`/`|| true` masking a
  failure), so a job "succeeds" while publishing nothing. **Rule:** a job that did not accomplish
  its purpose fails red. Assert outcomes (artifact exists, N objects uploaded), not the absence of
  exceptions. Keep the diagnostic, keep the non-zero exit.
- **M12 — CWD/path assumptions in CI.** A `cd` on one script line persists to the next; a relative
  path resolves somewhere else and `-f` hides it. **Rule:** in `.gitlab-ci.yml` scripts use
  `$CI_PROJECT_DIR`-anchored absolute paths only, and verify the effect of every destructive/
  cleanup line actually happened.
- **M13 — Tag-only jobs fail on first contact.** Publish/release jobs that only run at tag time
  fail on their first real run (missing env propagation into nested VMs, cold caches, wrong
  artifact paths) — this repo's tag list shows same-day retag pairs from exactly this.
  **Rule:** exercise any tag-gated job before tagging (manual trigger / temp branch rule); pass
  secrets into nested VMs explicitly; upload caches `when: always`. Use the `/ci-doctor` skill.
- **M14 — Test job not wired into `release:gate`.** A new test job that isn't in `release:gate`'s
  `needs:` list cannot stop a publish — this nearly shipped a broken release twice.
  **Rule:** every new CI test job gets added to `release:gate.needs`, same commit.
- **M15 — Loosening instead of root-causing.** Bumping timeouts, softening assertions, skipping
  scenarios to make a flake go away — history shows each of these came back.
  **Rule:** wait on conditions/events, not fixed timeouts; don't assert exact user-facing strings
  in cross-platform tests; one timeout bump with a comment is tolerable, a second bump on the same
  job means root-cause it now.
- **M16 — Committing artifacts and temp debug code.** Generated sources from a dev build, or a
  "(temp) debug trace" commit, landing on main and breaking release builds later.
  **Rule:** gitignore generated dirs before first build; review `git status` for `gen/`/generated
  paths before committing; temp debugging never lands on main.

### D. Fix and verification discipline

- **M17 — Fixing 1 of N occurrences.** The same constant/typo/pattern exists in sibling files and
  only one gets fixed. **Rule:** after any fix, grep for every other occurrence of the
  pattern/constant before committing; if it's duplicated, centralize or fix all and say so.
- **M18 — Claiming done without the chain.** Reporting a change complete after it compiles.
  **Rule:** run the verification chain for the deliverable type (§7) and report commands + results.
  If verification fails, iterate until it passes — do not report partial success as success.
- **M19 — Spec drift.** Changing behavior without touching `docs/spec/`.
  **Rule:** before changing behavior in an area, read `docs/spec/<area>.md`; after, update the
  line (and gaps → `just spec-gaps`). Use the `/spec-sync` skill.
- **M20 — Building from the wrong directory.** `pnpm run build` from a workspace resolves a
  different build script. **Rule:** build from the monorepo root; verify output includes
  `vite build` and `dist/assets/`. Also: `pnpm run dev` uses localhost APIs, `pnpm run build`
  points at production endpoints; `cargo build` needs a repo-root `dist/` to exist
  (`mkdir -p dist`).

### E. Platform traps (things that lie to you)

- **M21 — Trusting synthetic input and stale screenshots.** Programmatic DOM `click()` does NOT
  fire Svelte 5 handlers (tap at CSS-rect-center × devicePixelRatio via `adb input tap` instead);
  an unfocused Android emulator throttles Compose frames so `adb screencap` shows stale UI
  (verify via disk/logcat or force a real scroll); iOS 26 nav-bar toolbar items are invisible to
  the a11y tree and idb taps (list rows and the FAB work). **Rule:** when UI automation reports
  "nothing happened", suspect the tool before the app — check the playbooks in the `/verify`
  skill's `references/ios.md` and `references/android.md`.
- **M22 — Believing the wrong browser.** Playwright/agent-browser run WebKit/Chromium — they can
  never prove Windows WebView2 behavior (native drag-drop, NSIS installer, clean-machine launch:
  use the qemu VM harness in `scripts/win-vm/`), the real iOS keyboard (toolbar/inset bugs are
  invisible), or duplicate-dependency breakage. If the editor goes blank or decorations vanish
  after a dependency change, check for duplicated `@codemirror/*` packages first.
- **M23 — Updater signing order.** The detached `.sig` must be the LAST touch on artifact bytes —
  after the Linux mesa patch / macOS notarize / Windows Authenticode — or verification fails.
  Architecture + keys/trust boundary: `docs/release/updater.md`, `keys/README.md`. Local
  rehearsal: `just updater-localdev`. A localdev-signed artifact can never be accepted by a prod
  client — that asymmetry is the design, not a bug.

## 7. Quality bar per deliverable (checkable)

Run `pnpm exec tsc --noEmit | head -30` before any full build; pipe builds through `| tail -20`.
Every logic change ships with a test — no exceptions. A bug fix's regression test must fail before
the fix and pass after. In your final report, include commands run, pass/fail, and key observed
behavior.

### 7.1 UI / Svelte / component change
- [ ] `just build` passes (tsc + vite from root)
- [ ] Relevant Playwright spec passes: `pnpm run test:e2e:smoke` minimum; the targeted spec
      (`pnpm exec playwright test tests/<spec>.spec.ts`) when one covers the area
- [ ] New interaction/flow → new or extended spec in `tests/` (launch `page.goto('/#/note/new')`,
      selectors `.cm-content`/`.title-input`/`.note-row`, `pageerror` capture for crash checks)
- [ ] Component logic → Vitest `*.test.ts` with `vi.mock('$lib/platform')` (in-memory `testFS`)
- [ ] CSS-only → `just build` + visual spot-check screenshot
- [ ] Spec line updated in `docs/spec/<area>.md` if behavior changed

### 7.2 Editor behavior (CM6 live preview)
- [ ] `just build` passes
- [ ] `pnpm run test:markdown-spec` passes
- [ ] New behavior → YAML case in `markdown-spec/cases/<NN-topic>/` (static: `cursor` +
      `expect.decorations/widgets/visible_text*`; movement: `start_cursor`/`moves`/
      `checkpoints`/`expect_final`, `require_wrapped_start_line` if wrapping matters)
- [ ] Relevant `src/lib/*.test.ts` (reveal/continuation/table) pass
- [ ] Manual check in `just tauri-dev` (CM6 quirks don't always show in Playwright)
- [ ] `docs/spec/editor.md` updated

### 7.3 Note rule change (filename/title, tags, image, preview, wikilinks)
- [ ] Rule changed in BOTH canonical TS (`packages/editor/src/*`) and Rust (`futo-notes-model`)
- [ ] Fixtures regenerated: `pnpm exec tsx tests/conformance/generate.mjs` (new inputs added to
      the relevant group first)
- [ ] TS side green: `pnpm run test:editor:minimal`
- [ ] Rust side green: `just test-rust` (= `cargo test -p futo-notes-model --test conformance`)
- [ ] No new un-fixtured copies created anywhere (grep Swift/Kotlin for siblings — see §12)

### 7.4 Rust core / Tauri command
- [ ] New `#[tauri::command]` wraps an `_impl`; `#[cfg(test)]` unit test for the `_impl` added
- [ ] `just test-rust` green; `just test-rust-full` (`cargo test --workspace`, needs `dist/`) for
      anything beyond model rules
- [ ] Command registered in `lib.rs` `generate_handler!` and added to the matching TS shim
- [ ] Mutations register watcher suppression before writing
- [ ] Dep-guard intact: portable crates must not pull `tantivy`/`ort` (CI `test:rust:dep-guard`)

### 7.5 Sync change
- [ ] `cargo test -p futo-notes-sync` green
- [ ] Protocol/sync-engine changes → scenario added/updated in `tests/cross-platform-sync.mjs`
      (register in the `scenarios` array) and `just test-cross-platform` run locally
- [ ] Server-contract changes → F-series integration tests against an ISOLATED server
      (`FUTO_TEST_SERVER=http://127.0.0.1:3055 cargo test -p futo-notes-sync --test
      server_integration -- --ignored --test-threads=1`) — never the :3005 demo server
- [ ] Push-first invariant untouched: dirty local edits are PUT before any pull writes disk
- [ ] `docs/spec/sync.md` line updated, naming its guarding test/scenario
- [ ] High-stakes (crypto/merge/tombstones)? → run `/sync-adversarial` and consider `/slow-review`

### 7.6 Native iOS
- [ ] `just build-ios-native` compiles
- [ ] Simulator or device QA of the changed flow (there is no iOS test target — record what you
      exercised; keyboard/safe-area/scroll changes need the full matrix: new note, existing note,
      toolbar, scroll-during-IME)
- [ ] Testable logic pushed down into the Rust crates rather than Swift
- [ ] Spec line updated with a dated verification note

### 7.7 Native Android
- [ ] `just build-android-native` compiles
- [ ] `just test-android-native` green (JVM unit tests — local gate only, CI doesn't run them)
- [ ] New pure-logic seams get a JUnit test in `apps/android/app/src/test/java/com/futo/notes/`
- [ ] Emulator/device QA of the changed flow (respect `$ANDROID_SERIAL`; see M21)

### 7.8 CI / pipeline change
- [ ] Every path `$CI_PROJECT_DIR`-anchored; no cwd assumptions; no silent-green exits (M11–M12)
- [ ] New test job added to `release:gate.needs` (M14)
- [ ] Verified on a real pipeline (push branch/MR; for tag-only jobs see `/ci-doctor`)

### 7.9 Bug fix (any layer)
- [ ] Regression test written FIRST and observed failing (use `/bugfix`)
- [ ] Root cause named (not just the symptom patched)
- [ ] Sibling occurrences grepped (M17)
- [ ] Chain for the touched layer (above) run and green

### 7.10 Before merge / release
- [ ] `just check` green (spec-gaps-check + toolbar-spec-check + rust conformance + lint +
      test:full + tsc + build)
- [ ] MR pipelines auto-run every suite whose `changes:` paths the MR touches: hard gates
      (lint + `lint:platform` + `test:full` + Rust conformance + dep-guard) always; E2E +
      markdown-spec on web/editor changes (blocking); cross-platform sync on sync-critical
      paths (blocking); macOS jobs on Rust/desktop changes (`allow_failure` — single runner).
      Only the Windows chain (protected secrets) and image publish stay manual on MRs.
      Everything is MANDATORY on tags — still run locally what your change risks (M13)
- [ ] Release flow itself: use `/release` (tests → MR → changelog → tag → pipeline watch → Zulip)

## 8. Testing map

| Suite | Command | What it is |
|---|---|---|
| Rust conformance (fast) | `just test-rust` | model rules vs golden fixtures |
| Rust full workspace | `just test-rust-full` | all crates (needs `dist/`) |
| TS unit (curated) | `just test-unit` | whitelisted `src/lib` + scripts tests |
| TS unit full | `pnpm run test:unit:full` | all vitest |
| Editor package | `just test-editor` | `packages/editor` |
| Conformance staleness | `pnpm exec tsx tests/conformance/generate.mjs --check` | fixtures fresh? |
| Playwright smoke | `just test-e2e` | `tests/p0-regressions.spec.ts` |
| Playwright full | `just test-e2e-full` | all specs |
| Markdown spec corpus | `just test-markdown-spec` | decoration/cursor YAML cases |
| Cross-platform sync | `just test-cross-platform` | 2 real Tauri instances + server, ~26 scenarios |
| Android JVM | `just test-android-native` | native pure-logic tests |
| Desktop smoke | `just test-desktop-smoke` | MCP-bridge 4-check smoke |
| Everything local | `just check` | the pre-merge umbrella |

Where tests live: Rust → inline `#[cfg(test)]` modules + `crates/*/tests/`; Tauri `_impl` tests live
at the bottom of their owning files in `apps/tauri/src-tauri/src/`; TS → `src/lib/*.test.ts`;
editor rules/bridge → `packages/editor/src`; E2E → `tests/*.spec.ts`; sync scenarios →
`tests/cross-platform-sync.mjs` (helpers in `tests/lib/`).

## 9. Verification tooling (drive the real apps)

- **Web/desktop UI poking**: `agent-browser` (faster than Playwright MCP, handles CM6 typing,
  annotated screenshots — run with no args for the reference). **Tauri desktop**: the MCP bridge
  (`driver_session`, `webview_*`) ships in desktop debug builds.
- **Native mobile has NO MCP bridge**: iOS via `xcrun simctl` + `idb`; Android via `adb` /
  uiautomator + CDP (`just cdp-forward`, then `node scripts/cdp-invoke.mjs "document.title"`).
  Full playbooks: `/verify` skill `references/ios.md`, `references/android.md`. Android emulator →
  host services via `10.0.2.2`.
- **Sync in debug builds**: prefer the `window.__testSync` hook over UI automation —
  `connect(serverUrl, password)`, `connectE2ee(...)`, `status()`, `syncNow()`, `syncE2ee(pw)`,
  `disconnect()`/`disconnectE2ee()`.
- **Parallel QA isolation**: `just qa-claim` / `qa-status` / `qa-release` / `qa-server` — worktree
  → slot → pooled devices (`futo-qa-0..6`) + per-slot sync server. Never touch devices you didn't
  claim; adb forward ports are machine-global.
- **Logs**: `just emu-logs` (tag-scoped logcat), `just sim-logs` (os_log; `print()` needs
  `xcrun simctl launch --console-pty booted com.futo.notes.dev`).
- **Windows/WebView2**: qemu Win11 harness in `scripts/win-vm/` (see its README).

## 10. Behavioral spec — source of truth

`docs/spec/` states what the app should do, by surface (`app`, `editor`, `list`, `nav`, `tabs`,
`search`, `settings`, `sync`), across all three apps. A requirement exists in one place even when
a platform doesn't satisfy it yet.

- **Before** changing behavior in an area: read `docs/spec/<area>.md`.
- **After** establishing/changing behavior: add or update the line (one behavior per line,
  platform tags `*(iOS)*` etc., `→ path` authority refs).
- Known missing/divergent behavior = an inline `> **Gap:** ...` note. Adding or closing a gap =
  update the note, run `just spec-gaps`, commit the regenerated `GAPS.md`. `just spec-gaps-check`
  (in `just check`) fails on staleness and runs closure probes — when one fires, verify and update
  the spec, don't ignore it.
- Layering: spec (behavior) sits above `tests/conformance/*.json` (TS↔Rust rule parity) and
  `markdown-spec/cases/*.yaml` (editor fixtures) — reference those, don't duplicate them.
- The `/spec-sync` skill encodes the full lifecycle including the hidden-affordance checklist
  required before recording any gap.

## 11. When uncertain — escalation rules

**Resolve on your own, in this order.** (1) `docs/spec/<area>.md`; (2) the fixture corpora
(`tests/conformance/`, `markdown-spec/cases/`); (3) the Rust crate source (canonical for the note
domain); (4) `git log` on the file + `docs/learnings/`; (5) the nested AGENTS.md for the layer.
Never resolve uncertainty by inventing a new pattern — find the existing one.

**Act without asking** on anything reversible and in-repo that follows from the request: fixes,
tests, refactors within a layer, running suites, dev builds, local installs of dev builds, spec
edits reflecting verified behavior. When the user pastes an error: grep the message → read the
source → `git log --oneline -5 -- <file>` → fix → verify. Bias toward action; don't ask
clarifying questions unless the error is genuinely ambiguous.

**Stop and ask first — exact list:**
1. Anything under `keys/`, signing keys, or the updater trust boundary (M23).
2. Weakening or removing a CRITICAL guard: dev bundle id, `fake-notes` root, push-first sync,
   `release:gate` needs, the dep-guard, hash/crypto functions (`hash.rs` changes break sync for
   every existing client).
3. Destructive operations on real data: the user's `~/Documents/futo-notes`, the production
   server (elitedesk), dropping databases you didn't create, deleting tags, `git push --force`.
4. Publishing anything: Play/TestFlight uploads, tagging a release, posting to Zulip, F-Droid.
5. Changing intent: if a fix requires changing behavior the spec records (rather than closing a
   gap), surface the conflict — spec says what SHOULD be, code says what IS; don't silently
   change either.
6. Cross-cutting protocol changes: sync payload shape, `BRIDGE_VERSION` bumps, `AppState` schema
   migrations.

**Two-strikes rule.** If the same fix approach has failed twice, stop patching. Re-diagnose from
scratch, write down the competing hypotheses, and pick the cheapest discriminating experiment. A
second opinion is available via `/codex:rescue`.

**Contradiction rule.** If what you find contradicts the task's premise ("fix X" but X provably
works; "delete Y, it's unused" but Y has callers), report the evidence before acting on the
premise.

**Flake rule.** First flake → root-cause it. You may bump one timeout once, with a comment naming
what you actually waited for. A second bump on the same job is forbidden (M15).

## 12. Drift watchlist (same logic in ≥2 places — move in lockstep)

Conformance-locked or generated (safe, but regenerate on change): note and image rules TS↔Rust;
safe note IDs TS↔Rust; toolbar and bridge manifests → generated native specs; Rust vault image
extensions → generated UniFFI bindings for Swift/Kotlin; Rust Tauri sync records → generated TS.

Partially locked: `validateServerUrl` ×3 (TS/Kotlin/Swift — **the Swift copy has no automated
fixture check**); title constraints across the hot-path/native surfaces.

**Not locked — real drift risk.** If you touch one, touch all, and say so in the commit:
- Default notes-root split, 3 independent copies: Rust `vault_location.rs`, iOS `NotesStore.swift`,
  Android `NotesStore.kt`.
- Note sort order (`modified desc, id asc`): `notes.svelte.ts`, Rust `scan_notes`, iOS
  `resortInPlace`.
- Unique note-ID generation in Rust, TypeScript, Swift, and Kotlin.

## 13. Own the E2E experience

For demos, migrations, or "make the whole thing work on my machine" requests — own the full
client + server + data + launcher path until the user can open the app and see the result. Do not
hand off operational steps you can do yourself.
