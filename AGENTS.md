# AGENTS.md — FUTO Notes Operating Manual

@README.md for project overview. @justfile for all commands.

FUTO Notes is an offline-first markdown app with a Svelte 5 editor, shared Rust core, Tauri
desktop, native SwiftUI/Compose mobile shells, and optional E2EE sync.

This root file contains only cross-layer decisions and recurring traps. **CRITICAL** rules protect
user data or shipped behavior; never weaken one to make a test, build, or pipeline pass.
Engineering defaults: the simplest implementation that fully meets the current requirement, and an
established, well-maintained library over a custom one.

**Read the nearest nested `AGENTS.md` before editing a layer.** This includes `src/`,
`packages/editor/`, `crates/futo-notes-{core,sync}/`, each app, `docs/spec/`, and `factory/`.

For structural work, read `docs/architecture/codebase-organization.md`: use the narrowest real
owner, make shared code earn its scope, keep entry points as orchestration, co-locate tests, and
complete moves across code, tests, config, and docs. Its `spec/` means this repo's `docs/spec/`.
CRITICAL rules and behavioral specs take priority; report any conflict.

## 1. Quick start

Use `just` from the repo root (`just install`, `just tauri-dev`, `just check`). The justfile owns
commands, overlays, dev IDs, worktree isolation, and device detection. Never call `cargo tauri`.
`just tauri-dev` is desktop dev: Wayland, port 5180.

## 2. CRITICAL — mobile is native, not Tauri

There is no Tauri mobile shell; the old `cargo tauri ios/android` recipes were removed. Use the
native apps in `apps/ios` and `apps/android` through `just ios-native` / `just android-native`.
Their nested manuals own build, device, release, and test variants. Missing
`vite-plugin-singlefile` means stale node_modules; error 7 launching iOS usually means a locked phone.

## 3. Monorepo map

- `src/`: shared UI, reactive state, and coordination.
- `packages/editor/`: hot-path TS rules, bridge contract, toolbar manifest.
- `crates/`: `-model` (pure note rules, no fs) · `-core` (hashing, E2EE crypto, 3-way merge, path
  safety + atomic files) · `-store` (THE local note engine) · `-sync` (push-first `run_sync`, SSE) ·
  `-search` (Tantivy BM25) · `-ffi` (UniFFI projection; bindings gitignored).
- `apps/`: Tauri desktop plus native iOS and Android shells.
- `docs/spec/`: behavioral truth; `tests/`, `markdown-spec/`, `factory/`: fixture/oracle systems.

Generated and gitignored: native bindings/JNI libraries and `editor.html`. The external sync server
at `~/Developer/futo-notes-server` receives only client-encrypted opaque blobs.

## 4. Where logic lives (decision procedure)

1. **Note rule or note-tree mutation?** Rust model/core/store, projected through Tauri or UniFFI;
   never reimplement it in TS, Swift, or Kotlin.
2. **Needed per keystroke?** The only exception is a conformance-locked hot-path TS mirror, reached
   from the app through `src/lib/rules.ts`; Rust remains canonical and `packages/editor/AGENTS.md`
   owns the procedure (§7.3).
3. **View, reactive state, coordination, or shell?** TypeScript/Svelte in `src/`.
4. **Compute-heavy or protocol-shaped?** Rust.
5. **OS capability?** Extend `PlatformFS`; components never branch on platform, never invoke note
   commands or plugin-fs directly (`pnpm run lint:platform`, `pnpm run check:platform-discipline`).
6. **Two domain calls in sequence?** Make one atomic Rust workflow, not a shell-side stitch.
   This has no reliable gate: an experiment produced a green check-then-act race that resurrected
   a deleted note. If every caller must remember an ordering invariant, push it down.

Before copying auth, validation, parsing, or cleanup at call sites, find or create its narrow
infrastructure owner.

## 5. Cross-cutting conventions

- **Svelte 5 runes only** (`$state`/`$derived`/`$effect`; module state in `.svelte.ts`). Never
  `svelte/store`, `on:click`, or `createEventDispatcher` — use `onclick=` attributes and callback props.
- Never hand-build note paths: use TS `pathSafety.ts` or Rust `safe_note_path`.
- The note cache (`notesCache` in `src/features/notes/notes.svelte.ts`) is a projection. Apply the
  complete post-commit `LocalNoteMutation`; do not optimistically reconstruct collision or backlink
  outcomes.
- FFI requires the iOS dev profile / Android `release-ffi`; plain release uses `panic = "abort"`
  and breaks UniFFI unwinding. Errors crossing the boundary are `uniffi::Error` enums.
- Commits use `type(scope): imperative summary` — types `feat|fix|docs|chore|ci|perf|refactor|build|test`,
  scope is a surface or platform. A nontrivial fix's body names the exact failure (pipeline number,
  error string), the root cause, and a `Verified:` line listing the commands run. Risky work uses a
  branch + GitLab MR; migrations and perf land as small per-concern commits. Releases: `/release`.
- Repo-tooling friction (dead-end tool call, stale doc, broken recipe, missing helper) is a
  **papercut**: file it without stopping the task, `papercuts add "<what you hit>" --tag <area>`.
  Product bugs and spec gaps are never papercuts. Full procedure: `docs/agents/papercuts.md`.

## 6. Named mistakes — and the rule that prevents each

These are observed failures, not generic advice.

### A. Data and render safety (CRITICAL)

- **M1 — Gated render.** Flip `initialized = true` synchronously; start all I/O un-awaited and
  apply results reactively. A scan may delay content, never the shell. Native uses background I/O
  plus `hasBootstrapped` to distinguish loading from empty.
- **M2 — Title transformation.** "Improving" a filename into a title (case, dash→space).
  **The filename is the title:** `"grocery list.md"` → `"grocery list"`; sanitizing only removes
  filesystem-breaking characters. Never prettify filenames, even when asked plausibly. A measured
  agent without this rule shipped the change and edited the spec to bless it. Say no and cite M2.
- **M3 — Dev touches prod data.** Desktop/iOS dev use `com.futo.notes.dev` + `~/Documents/fake-notes`
  (release: `com.futo.notes` + `~/Documents/futo-notes`); Android package storage uses `.dev` and
  DEVICE mode uses `FUTO Notes Dev`. The TS resolver MUST delegate to Rust
  `resolve_default_notes_root`, because `documentDir()` looks identical in dev and release — resolve
  it in JS and dev silently points at prod. Never weaken these independent guards or the
  `FUTO_NOTES_DATA_DIR` test override.
- **M4 — Piecemeal reset.** Stop live sync, reset disk plus every module cache/watermark, and prefer
  a webview/process reload over trusting partial invalidation.
- **M5 — Background jank.** Typing is sacred: only sanctioned hot-path TS runs per keystroke;
  saves, indexing, and sync stay in the background.

### B. The single-source rule

- **M6 — Reimplemented note rule.** Rust owns the domain. The only TS mirrors live in
  `packages/editor` behind conformance fixtures; never add Swift/Kotlin copies.
- **M7 — One-sided rule edit.** Change canonical Rust + TS, update the hand-reviewed
  `tests/conformance/*` goldens, pass the differential lock, and test both consumers;
  `packages/editor/AGENTS.md` owns the procedure.
- **M8 — Generated-file edit.** Edit the registered source of truth and regenerate; never hand-edit
  `GAPS.md`, `ToolbarSpec.*`/`TitleSpec.*`, uniffi bindings/JNI libs, or the **bundled**
  `editor.html` — the root `editor.html` IS the hand-written source. Regenerate with
  `just spec-gaps` / `just toolbar-spec` / `just title-spec` / `scripts/build-rust-ios.sh` (and its
  android sibling) / `vite build --config vite.editor.config.ts`.
- **M9 — Stale FFI bindings.** Rebuild Rust bindings (`just build-rust-ios` /
  `just build-rust-android`) before native testing. `just *-native` does; direct Xcode/Gradle
  does not.
- **M10 — One-shell bridge change.** `bridge.ts` and `toolbar.ts` are authoritative. A new message
  needs both native hosts; toolbar behavior belongs in shared `TOOLBAR_EXEC`, never a shell.

### C. CI and release (the single most-churned area of this repo)

- **M11 — Silent green.** A job that misses its purpose fails red; assert outputs/counts, never mask
  failure with `-f`, `|| true`, or special-case success.
- **M12 — CI path assumptions.** Use `$CI_PROJECT_DIR`-anchored paths and verify cleanup effects;
  `cd` persists across GitLab script lines.
- **M13 — Untested tag job.** Exercise tag-gated work before tagging, propagate secrets into nested
  VMs, and upload caches `when: always`. Use `/ci-doctor`.
- **M14 — Missing release dependency.** Every new test job enters `release:gate.needs` in the same
  commit or it cannot block publication. One deliberate exception: `test:audit` is non-blocking by
  design (docs/architecture-gates.md).
- **M15 — Loosening instead of diagnosing.** Wait on conditions, not sleeps; avoid exact
  cross-platform UI strings. A second timeout bump means stop and root-cause.
- **M16 — Landed artifacts/debugging.** Gitignore generated paths before building, inspect status,
  and never land temporary instrumentation.

### D. Fix and verification discipline

- **M17 — Fixed 1 of N.** Search every sibling occurrence; centralize or fix all.
- **M18 — Done after compile.** Run the owning layer's complete chain (§7) and report results.
- **M19 — Spec drift.** Read and update `docs/spec/<area>.md` with behavior; use `/spec-sync`.
- **M20 — Wrong build directory.** Run builds from repo root through `just`: `pnpm run dev` uses
  localhost APIs while `pnpm run build` points at production endpoints, and `cargo build` needs a
  repo-root `dist/` to exist (`mkdir -p dist`).

### E. Platform traps (things that lie to you)

- **M21 — Synthetic input/stale screenshot.** DOM `click()` misses Svelte handlers; unfocused
  Android throttles frames; iOS 26 nav items evade a11y taps, and `axe gesture`/`axe tap` report
  success while doing nothing. Suspect the tool before the app, and **never record a spec gap from
  one tool's silence**; mechanics live in `/verify`'s `references/ios.md` + `references/android.md`.
- **M22 — Wrong browser.** Playwright cannot prove WebView2 or real iOS keyboard behavior. Use the
  Windows VM/device; after dependency changes, blank CM6 often means duplicate `@codemirror/*`.
- **M23 — Updater signing order.** The detached `.sig` must be the LAST touch on artifact bytes —
  after patching/notarization/Authenticode. Read `docs/release/updater.md` and `keys/README.md`, and
  rehearse locally with `just updater-localdev`; localdev signatures must never verify in production.
- **M24 — QA input hit the production app.** OS-level input (AppleScript UI scripting, `cliclick`)
  goes to the FOCUSED window, and every build shares the binary name — so a name/PID lookup sent
  real keystrokes into the user's live vault. Resolve any desktop QA target ONLY through
  `scripts/qa-target.mjs`, and drive the webview bridge, never the window server.
- **M25 — Pattern kill across worktrees.** `pkill -f vite` / `pkill -f "cargo tauri dev"` reach every
  checkout on the machine, and fail silently as a wrong answer: the peer gets an orphan that still
  serves its bridge but never rebuilds, or a screenshot of a dead dev server instead of a test
  failure. Terminate by identity only — `just qa-target kill`, the PID/process group you started, or
  a port from `just ports` — never by process name. `just check-qa-input-safety` enforces it.

## 7. Quality bar per deliverable

Every logic change gets a test; a bug regression fails before the fix. Report commands and results.

| ID | Change | Required chain |
|---|---|---|
| **7.1** | UI/Svelte | `src/AGENTS.md` |
| **7.2** | CM6 editor | `src/AGENTS.md` |
| **7.3** | Note/editor rule | `packages/editor/AGENTS.md` + both Rust/TS consumers + `just test-rust` (goldens + TS↔Rust differential) |
| **7.4** | Rust core/Tauri | nearest crate or `apps/tauri/AGENTS.md` |
| **7.5** | Sync | `crates/futo-notes-sync/AGENTS.md`; preserve push-first |
| **7.6** | iOS | `apps/ios/AGENTS.md` |
| **7.7** | Android | `apps/android/AGENTS.md` |
| **7.8** | CI | real pipeline + `/ci-doctor` |
| **7.9** | Any bug | failing regression first, then owner chain |
| **7.10** | Before merge | `just check`; use `just prepush` for broad/risky work |

## 8. Testing map

The justfile is the command authority; the nearest nested manual maps changes to recipes.
`just check` is the normal umbrella, `just prepush` the environment-dependent maximal chain.
Run `just build` rather than hand-piping `tsc`/`vite build` through `head`/`tail`: the recipe sets
`pipefail` so a failing build still exits non-zero, while a hand-rolled pipe swallows it (M11).

## 9. Driving the real apps

Use `/verify`; desktop debug has an MCP bridge, native mobile does not. Claim QA devices and never
touch an unclaimed one. Tear down only what you started (M25). Prefer `window.__testSync`; WebView2
requires `scripts/win-vm/`.

## 10. Behavioral spec — source of truth

`docs/spec/` states cross-platform behavior once. Read/update the area file with behavior; record
divergence as an inline `> **Gap:**` note, then `just spec-gaps` and commit the regenerated
`GAPS.md` (`just spec-gaps-check` fails on staleness). `docs/spec/README.md` owns the line
conventions (one behavior per line, platform tags, `→ path` authority refs);
`docs/spec/AGENTS.md` and `/spec-sync` own the verification workflow.

## 11. When uncertain

Resolve from spec → fixtures → canonical Rust → `git log` + `docs/learnings/` → nearest manual. Find
the existing pattern; do not invent one. **Act without asking** on reversible in-repo work: fixes,
tests, refactors within a layer, running suites, dev builds/installs, spec edits that record
verified behavior, and force-pushing a feature branch (`--force-with-lease`, never bare `--force`).

**Stop and ask first — exact list:**
1. Anything under `keys/`, signing keys, or the updater trust boundary (M23).
2. Weakening a CRITICAL guard: dev/prod data, push-first, release gate, dep guard, hash/crypto.
3. Real-data destruction or expensive local state: the user's `~/Documents/futo-notes`, the prod
   server, force-pushing `main`, deleting tags, dropping DBs you did not create, or a recursive delete
   outside your scratchpad — gitignored ≠ disposable, and `target/` is a 31GB rebuild. Cleanup
   removes only paths the script itself created, never a computed ancestor: `rmSync(rel.split('/')[0])`
   ate a worktree's `target/` and a tracked `factory/`.
4. Publishing: Play/TestFlight uploads, tagging a release, posting to Zulip, F-Droid.
5. Changing specified intent rather than closing a Gap.
6. Sync payload, `BRIDGE_VERSION`, or `AppState` schema changes.

After two failed approaches, stop, write competing hypotheses, and run the cheapest discriminator;
two strikes on the same fix means re-diagnosing with `/codex:rescue`. If evidence contradicts the
task premise, report it before acting.

## 12. Drift watchlist (same logic in ≥2 places — move in lockstep)

**`scripts/drift-registry.json` is the watchlist** — every permitted duplicate is enumerated there
with its copies and a `lockStatus`; `unlocked` means nothing but you keeps the copies in sync, so
touch all of them in one commit and say so. `just check-drift` is deny-by-default: adding a duplicate
means adding a registry entry. Keep the list there, not here — a prose copy of it is itself drift.

The `notes-root-triplet` unlocked entry is the intentional dev/prod split (M3). Note sort order is
owned only by the Rust store; shells splice engine-reported positions verbatim (ADR-0001), so never
reintroduce a shell comparator or a shell final-id heuristic.

## 13. Own the E2E experience

For demos/migrations, own client + server + data + launcher until the user sees the result.
