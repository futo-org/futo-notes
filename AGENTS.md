# AGENTS.md — FUTO Notes operating manual

@README.md for the project overview. @justfile for every command.

FUTO Notes is an offline-first markdown notes app: one Svelte 5 web editor + one shared Rust core,
shipped as **three apps** — Tauri desktop, native SwiftUI iOS, native Compose Android — with optional
E2EE sync against an external server (`~/Developer/futo-notes-server`). Rules marked **CRITICAL**
protect user data or shipped behavior; never weaken one to pass a test, build, or pipeline.
Engineering defaults: choose the simplest implementation that fully meets the current requirements;
prefer established, well-maintained libraries over custom implementations.

## Before you modify

`docs/architecture/codebase-organization.md` is the canonical standard for code ownership, placement,
naming, comments, and test placement. Read it — and the nested `AGENTS.md` for the layer you touch —
before planning or editing anything but prose docs, and name the narrowest owner. Where it says
`spec/`, this repo means `docs/spec/`. Priority when guidance conflicts: system/user instructions →
CRITICAL rules here → `docs/spec/` + nearest nested `AGENTS.md` → the standard → existing patterns.

Always run `just` from the repo root — it encodes config overlays, dev bundle ids, and per-worktree
isolation; never call `cargo tauri` directly (`just tauri-dev` = desktop dev, Wayland, port 5180).

## Mobile is native, not Tauri (CRITICAL)

On-phone builds use the native shells in `apps/ios` (SwiftUI) and `apps/android` (Compose) over the
shared Rust core (`futo-notes-ffi`) with an embedded web editor — there is no Tauri mobile shell;
build via the `just *-native` recipes. Gotchas: a missing `vite-plugin-singlefile` means stale
node_modules (`pnpm install`); a locked iPhone yields `FBSOpenApplicationErrorDomain error 7`.

## Monorepo map (pnpm + Cargo workspaces)

```
src/                     Shared Svelte 5 app (UI, reactive state, sync coordination, platform shims)
crates/  futo-notes-model (pure note rules, no fs) · -core (hashing, E2EE crypto, 3-way merge,
         path safety + atomic files) · -store (THE local note engine) · -sync (E2EE orchestrator,
         push-first run_sync, SSE) · -search (Tantivy BM25) · -ffi (UniFFI; bindings gitignored)
apps/{tauri,ios,android} desktop shell + the two native shells (generated dirs gitignored)
packages/editor/         canonical TS hot-path rules + futoBridge contract + toolbar manifest
docs/spec/               behavioral source of truth for all three apps
tests/, markdown-spec/, factory/   E2E + sync harness, editor fixtures, Obsidian-oracle harness
```

## Where logic lives

1. Note rule or filesystem mutation on the note tree → **Rust** (`futo-notes-model`/`-core`), via
   `notes_*`/`search_*` Tauri commands (desktop) or the `futo-notes-ffi` facade (native) — M6.
2. **Per-keystroke** note rule → the ONE sanctioned TS copy in `packages/editor/src/*` via
   `src/lib/rules.ts`; Rust stays canonical, held bit-for-bit by `tests/conformance/*` — the only
   rule allowed to live in two places.
3. View / reactive state / sync coordination / platform shell → **TS** (`src/lib`). `notesCache` in
   `notes.svelte.ts` is a projection — apply only the complete `LocalNoteMutation` Rust returns
   (collision outcomes + backlink rewrites included).
4. Compute-heavy / protocol-shaped (vector math, sync delta, hashing, crypto) → Rust.
5. OS access already covered by the platform layer → extend `PlatformFS`; never branch on platform
   inside components (`pnpm run lint:platform`).
6. A workflow of two domain calls (create-then-write, rename-then-relink) belongs in the domain
   (Rust `_impl` / FFI verb), not stitched together at each call site.

## Conventions

- **Svelte 5 runes only** (`$state`/`$derived`/`$effect`, module state in `.svelte.ts`). Never
  `svelte/store`, `on:click`, or `createEventDispatcher` — use `onclick=` attributes + callback props.
- Note/folder/search go through `getLocalNoteStore()`; `PlatformFS` is only shell storage/images/
  capabilities; sync uses `syncServiceE2ee.ts`. Components never invoke note commands or plugin-fs
  directly (`check:platform-discipline`).
- Never hand-build note paths — `pathSafety.ts` (TS) / `futo_notes_core::files::safe_note_path`
  (Rust). Toast/dialog wrappers and the persisted-setting recipe: `src/AGENTS.md`.
- Rust: each Tauri local-note command wraps an `_impl` and registers watcher suppression (the
  `BeforeWrite` hook) before the first syscall. FFI errors are `uniffi::Error` enums; FFI builds use
  dev (iOS) / `release-ffi` (Android) profiles — the workspace release `panic="abort"` breaks
  UniFFI's `catch_unwind`. No `tempfile` crate — hand-roll test tempdirs like existing tests;
  env-var tests serialize on a `static Mutex`.

## Papercuts (file the friction, don't eat it)

Hit a dead-end tool call, a stale doc, a broken `just` recipe, a footgun config, a missing helper?
File it before moving on — don't stop working, don't fix-and-forget:

    papercuts add "<what you hit and what would have prevented it>" --tag <area>

Severity: `minor` (default) annoyance · `--severity major` time sink · `--severity blocker` hard wall.
Tool failures take `--cmd`/`--exit`/`--stderr-file` (never raw env dumps). `papercuts schema` is the
full contract; `papercuts list --format md` is the review digest. The log is `.papercuts.jsonl` at the
repo root — append-only, committed, `merge=union` so parallel worktrees never conflict on it.

## Named mistakes (institutional memory — cited elsewhere by number; the rule that prevents each)

**Data/render safety (CRITICAL):**
- **M1** Gated render — `initialized=true` flips synchronously; never await prefs/scan/`invoke`
  before it (loads apply reactively).
- **M2** Title transformation — the filename IS the title; `sanitizeTitle()` only strips fs-breaking
  chars. Never case- or dash-massage a filename into a title.
- **M3** Dev build touches prod data — dev = `com.futo.notes.dev` + `~/Documents/fake-notes`, release
  = `com.futo.notes` + `~/Documents/futo-notes`; split in Rust `vault_location.rs` / iOS
  `#if FUTO_DEBUG_BUILD` / Android `BuildConfig.DEBUG`; the TS resolver MUST delegate to
  `resolve_default_notes_root` because `documentDir()` looks identical in dev and release, so
  resolving in JS silently points dev at prod; `FUTO_NOTES_DATA_DIR` overrides both. Never weaken.
- **M4** Piecemeal destructive reset — clear every module-level cache (appState, sync watermarks);
  stop live sync first and prefer reloading the process.
- **M5** Editor jank — responsiveness is sacred; per-keystroke work stays synchronous TS, everything
  else backgrounds.

**Single source:** **M6** don't reimplement a note rule in TS/Swift/Kotlin · **M7** a rule change
touches canonical TS (`packages/editor`) AND Rust (`futo-notes-model`) + regenerates fixtures
(`tests/conformance/generate.mjs`) · **M8** edit sources, not generated files (`GAPS.md`,
`ToolbarSpec.*`/`TitleSpec.*`, uniffi bindings + `jniLibs`, the **bundled** `editor.html` — the root
`editor.html` is the hand-written source), then regenerate (`just spec-gaps` / `just toolbar-spec` /
`just title-spec` / `scripts/build-rust-{ios,android}.sh` /
`vite build --config vite.editor.config.ts`) · **M9** rebuild FFI bindings (`just build-rust-ios` /
`just build-rust-android`) after any FFI-visible crate change — the `just *-native` recipes do this,
direct `xcodebuild`/gradle invocations do not · **M10** a new `futoBridge`/toolbar surface needs BOTH
native hosts.

**CI/release:** **M11** no silent green (assert outcomes, keep the non-zero exit) · **M12**
`$CI_PROJECT_DIR`-anchored paths, no cwd assumptions · **M13** exercise tag-gated jobs before tagging
(secrets into nested VMs explicitly, caches `when: always`; `/ci-doctor`) · **M14** every new test
job goes in `release:gate.needs` · **M15** don't loosen timeouts/assertions/skips to kill a flake —
root-cause it, wait on conditions not fixed timeouts, and never assert exact user-facing strings in
cross-platform tests · **M16** never commit generated dirs or temp debug code.

**Fix discipline:** **M17** fix every sibling occurrence (grep first) · **M18** run the verification
chain before claiming done · **M19** update `docs/spec/` with any behavior change · **M20** build from
the repo root (`pnpm run dev` uses localhost APIs, `pnpm run build` points at production endpoints;
`cargo build` needs a repo-root `dist/` to exist — `mkdir -p dist`).

**Platform traps:** **M21** don't trust synthetic input or stale screenshots — DOM `click()` does not
fire Svelte 5 handlers, an unfocused Android emulator throttles Compose frames so `adb screencap`
shows stale UI, and iOS `axe gesture`/`axe tap` report success while doing nothing. Suspect the tool
before the app, and **never record a gap from one tool's silence**; mechanics + failure modes: the
`/verify` skill's `references/{ios,android}.md` · **M22** Playwright/WebKit can't prove Windows
WebView2 (qemu harness: `scripts/win-vm/`) or the real iOS keyboard (duplicate `@codemirror/*` blanks
the editor) · **M23** the updater `.sig` must be the last touch on artifact bytes — after the Linux
mesa patch / macOS notarize / Windows Authenticode; trust boundary + local rehearsal:
`docs/release/updater.md`, `keys/README.md`, `just updater-localdev` (a prod client can never accept
a localdev-signed artifact — that asymmetry is the design, not a bug).

## Testing & quality bar

Every logic change ships a test; a bug fix's regression test fails before the fix and passes after.
Run `just build` first — it truncates `tsc`/`vite build` under `pipefail`; never hand-pipe them
through `head`/`tail` yourself (swallows the exit code). Then per layer, reporting commands + results:
- **Note rule** (filename/tag/image/preview/wikilink) → canonical TS + Rust,
  `pnpm exec tsx tests/conformance/generate.mjs`, then `pnpm run test:editor:minimal` + `just test-rust`.
- UI/Svelte → `just build` + the targeted Playwright spec. Editor (CM6) → `just test-markdown-spec` +
  a `markdown-spec/` YAML case. Rust/Tauri command → `_impl` unit test + `just test-rust[-full]`,
  registration + watcher rules per `apps/tauri/AGENTS.md`, dep-guard intact (portable crates must not
  pull `tantivy`/`ort` — CI `test:rust:dep-guard`). Sync → `cargo test -p futo-notes-sync` + a
  `tests/cross-platform-sync.mjs` scenario, push-first untouched (dirty local edits PUT before any
  pull writes disk); a server-contract change also runs the F-series against an **isolated** server
  (`FUTO_TEST_SERVER=http://127.0.0.1:3055 cargo test -p futo-notes-sync --test server_integration
  -- --ignored --test-threads=1`) — never the :3005 demo server or elitedesk. Native →
  `just build-ios-native` / `just build-android-native` (+ `just test-android-native`, storage/vault
  paths also `just test-android-storage`) + device QA.
- Full suite list: the `@justfile` (`just check` = pre-merge umbrella, `just prepush` = maximal gate).
  A new CI test job goes in `release:gate.needs` the same commit (M14).

## Committing

`type(scope): imperative summary` — types `feat|fix|docs|chore|ci|perf|refactor|build|test`, scopes
are surfaces or platforms (`android`, `ios`, `editor`, `sync`, `ci`, …). A nontrivial fix's body names
the exact failure (pipeline number, error string), the root cause, and a `Verified:` line with the
commands run. Features and risky work go through a branch + GitLab MR; small self-contained fixes may
land on main; migrations and perf land as small per-concern commits. Releases: `/release`.

## Driving the apps

Web/desktop: `agent-browser`; Tauri debug builds ship the MCP bridge. Native has no bridge — iOS via
`xcrun simctl` + `axe` (a11y tree via `node scripts/describe-ios-ui.mjs`, never a raw dump), Android
via `just android-drive` + CDP (`just cdp-forward`); prefer its `state` hook to a UI read (M21).
Sync hooks in debug builds: `window.__testSync` (surface: `src/features/sync/testSync.ts`). Parallel
isolation: `just qa-claim` / `qa-status` / `qa-release` / `qa-server`; logs: `just emu-logs` /
`just sim-logs`. Full playbooks: `/verify`.

## Spec is the source of truth

`docs/spec/*` states what each surface should do across all three apps. Read `docs/spec/<area>.md`
before changing behavior; update the line after (one behavior per line, platform tags, `→ path`
authority refs). Known divergence = an inline `> **Gap:**` note; adding/closing one → `just spec-gaps`
+ commit the regenerated `GAPS.md` (`just spec-gaps-check` fails on staleness). Use `/spec-sync`.

## When uncertain

Resolve yourself, in order: `docs/spec/<area>.md` → the fixture corpora → the Rust crate source →
`git log` + `docs/learnings/` → the nested `AGENTS.md`. Act without asking on reversible in-repo work
(fixes, tests, refactors within a layer, running suites, dev builds/installs, spec edits reflecting
verified behavior). For demos/migrations, own the full path — client + server + data + launcher —
until the user can open the app and see the result; don't hand off steps you can do yourself.

**Stop and ask first:** (1) anything under `keys/`, signing keys, or the updater trust boundary;
(2) weakening a CRITICAL guard (dev bundle id, `fake-notes` root, push-first sync, `release:gate.needs`,
the dep-guard, hash/crypto in `hash.rs`); (3) destructive ops on real data (the user's
`~/Documents/futo-notes`, the prod server, `git push --force`, dropping DBs you didn't create);
(4) publishing (Play/TestFlight/F-Droid uploads, tagging a release, posting to Zulip); (5) changing
behavior the spec records — surface the conflict; (6) cross-cutting protocol changes (sync payload,
`BRIDGE_VERSION`, `AppState` schema).

Two strikes: same fix failed twice → re-diagnose (`/codex:rescue`). Evidence contradicts the task
premise → report before acting. Flakes: root-cause first; one commented timeout bump max (M15).

## Drift watchlist

Some logic legitimately exists in more than one place. **`scripts/drift-registry.json` is the
watchlist** — every permitted duplicate is enumerated there with its copies and a `lockStatus`;
`unlocked` means **nothing but you keeps the copies in sync — touch all copies in one commit and say
so**. `just check-drift` is deny-by-default; adding a duplicate means adding a registry entry, so
keep the list there, not here — a prose copy of a drift list is itself drift.

Two `unlocked` entries deserve their reasoning recorded: `notes-root-triplet` is the dev/prod split
(M3), and `sort-tiebreaker-modified-id` is note sort order, where the Rust store is canonical —
shells splice engine-reported positions verbatim (ADR-0001), so never reintroduce a shell comparator
or a shell final-id heuristic; its only permitted twin is the browser test harness.
