# AGENTS.md — FUTO Notes Operating Manual

@README.md for project overview. @justfile for all commands.

FUTO Notes is an offline-first markdown app with a Svelte 5 editor, shared Rust core, Tauri
desktop, native SwiftUI/Compose mobile shells, and optional E2EE sync.

This root file contains only cross-layer decisions and recurring traps. **CRITICAL** rules protect
user data or shipped behavior; never weaken one to make a test, build, or pipeline pass.

**Read the nearest nested `AGENTS.md` before editing a layer.** This includes `src/`,
`packages/editor/`, `crates/futo-notes-{core,sync}/`, each app, `docs/spec/`, and `factory/`.

For structural work, read `docs/architecture/codebase-organization.md`: use the narrowest real
owner, make shared code earn its scope, keep entry points as orchestration, co-locate tests, and
complete moves across code, tests, config, and docs. Its `spec/` means this repo's `docs/spec/`.
CRITICAL rules and behavioral specs take priority; report any conflict.

## 1. Quick start

Use `just` from the repo root (`just install`, `just tauri-dev`, `just check`). The justfile owns
commands, overlays, dev IDs, worktree isolation, and device detection. Never call `cargo tauri`.

## 2. CRITICAL — mobile is native, not Tauri

There is no Tauri mobile shell; the old `cargo tauri ios/android` recipes were removed. Use the
native apps in `apps/ios` and `apps/android` through `just ios-native` / `just android-native`.
Their nested manuals own build, device, release, and test variants. Missing
`vite-plugin-singlefile` means stale node_modules; error 7 launching iOS usually means a locked phone.

## 3. Monorepo map

- `src/`: shared UI, reactive state, and coordination.
- `packages/editor/`: hot-path TS rules, bridge contract, toolbar manifest.
- `crates/`: Rust core/model/store/sync/search and UniFFI projection.
- `apps/`: Tauri desktop plus native iOS and Android shells.
- `docs/spec/`: behavioral truth; `tests/`, `markdown-spec/`, `factory/`: fixture/oracle systems.

Generated and gitignored: native bindings/JNI libraries and `editor.html`. The external sync server
at `~/Developer/futo-notes-server` receives only client-encrypted opaque blobs.

## 4. Where logic lives (decision procedure)

1. **Note rule or note-tree mutation?** Rust model/core/store, projected through Tauri or UniFFI;
   never reimplement it in TS, Swift, or Kotlin.
2. **Needed per keystroke?** The only exception is a conformance-locked hot-path TS mirror;
   Rust remains canonical and `packages/editor/AGENTS.md` owns the procedure (§7.3).
3. **View, reactive state, coordination, or shell?** TypeScript/Svelte in `src/`.
4. **Compute-heavy or protocol-shaped?** Rust.
5. **OS capability?** Extend `PlatformFS`; components never branch on platform.
6. **Two domain calls in sequence?** Make one atomic Rust workflow, not a shell-side stitch.
   This has no reliable gate: an experiment produced a green check-then-act race that resurrected
   a deleted note. If every caller must remember an ordering invariant, push it down.

Before copying auth, validation, parsing, or cleanup at call sites, find or create its narrow
infrastructure owner.

## 5. Cross-cutting conventions

- Never hand-build note paths: use TS `pathSafety.ts` or Rust `safe_note_path`.
- The note cache is a projection. Apply the complete post-commit `LocalNoteMutation`; do not
  optimistically reconstruct collision or backlink outcomes.
- FFI requires the iOS dev profile / Android `release-ffi`; plain release uses `panic = "abort"`
  and breaks UniFFI unwinding.
- Commits use `type(scope): imperative summary`; risky work uses GitLab MRs.

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
- **M3 — Dev touches prod data.** Desktop/iOS dev use `.dev` + `fake-notes`; Android package
  storage uses `.dev` and DEVICE mode uses `FUTO Notes Dev`. TS delegates root resolution to Rust.
  Never weaken these independent guards or the `FUTO_NOTES_DATA_DIR` test override.
- **M4 — Piecemeal reset.** Stop live sync, reset disk plus every module cache/watermark, and prefer
  a webview/process reload over trusting partial invalidation.
- **M5 — Background jank.** Typing is sacred: only sanctioned hot-path TS runs per keystroke;
  saves, indexing, and sync stay in the background.

### B. The single-source rule

- **M6 — Reimplemented note rule.** Rust owns the domain. The only TS mirrors live in
  `packages/editor` behind conformance fixtures; never add Swift/Kotlin copies.
- **M7 — One-sided rule edit.** Change canonical Rust + TS, regenerate fixtures, and test both
  consumers; `packages/editor/AGENTS.md` owns the procedure.
- **M8 — Generated-file edit.** Edit the registered source of truth and regenerate; never hand-edit
  GAPS, native specs/bindings/JNI libs, or `editor.html`.
- **M9 — Stale FFI bindings.** Rebuild Rust bindings before native testing. `just *-native` does;
  direct Xcode/Gradle does not.
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
  commit or it cannot block publication.
- **M15 — Loosening instead of diagnosing.** Wait on conditions, not sleeps; avoid exact
  cross-platform UI strings. A second timeout bump means stop and root-cause.
- **M16 — Landed artifacts/debugging.** Gitignore generated paths before building, inspect status,
  and never land temporary instrumentation.

### D. Fix and verification discipline

- **M17 — Fixed 1 of N.** Search every sibling occurrence; centralize or fix all.
- **M18 — Done after compile.** Run the owning layer's complete chain (§7) and report results.
- **M19 — Spec drift.** Read and update `docs/spec/<area>.md` with behavior; use `/spec-sync`.
- **M20 — Wrong build directory.** Run builds from repo root through `just`; workspace scripts and
  dev/prod endpoints differ.

### E. Platform traps (things that lie to you)

- **M21 — Synthetic input/stale screenshot.** DOM `click()` misses Svelte handlers; unfocused
  Android throttles frames; iOS 26 nav items evade a11y taps. Suspect the tool and use `/verify`.
- **M22 — Wrong browser.** Playwright cannot prove WebView2 or real iOS keyboard behavior. Use the
  Windows VM/device; after dependency changes, blank CM6 often means duplicate `@codemirror/*`.
- **M23 — Updater signing order.** The detached `.sig` must be the LAST touch on artifact bytes —
  after patching/notarization/Authenticode. Read updater docs and `keys/README.md`; localdev
  signatures must never verify in production.

## 7. Quality bar per deliverable

Every logic change gets a test; a bug regression fails before the fix. Report commands and results.

| ID | Change | Required chain |
|---|---|---|
| **7.1** | UI/Svelte | `src/AGENTS.md` |
| **7.2** | CM6 editor | `src/AGENTS.md` |
| **7.3** | Note/editor rule | `packages/editor/AGENTS.md` + both Rust/TS consumers |
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

## 9. Driving the real apps

Use `/verify`; desktop debug has an MCP bridge, native mobile does not. Claim QA devices and never
touch an unclaimed one. Prefer `window.__testSync`; WebView2 requires `scripts/win-vm/`.

## 10. Behavioral spec — source of truth

`docs/spec/` states cross-platform behavior once. Read/update the area file with behavior; record
divergence as an inline Gap. `docs/spec/AGENTS.md` and `/spec-sync` own the workflow.

## 11. When uncertain

Resolve from spec → fixtures → canonical Rust → history/learnings → nearest manual. Find the
existing pattern; do not invent one.

**Stop and ask first — exact list:**
1. Anything under `keys/`, signing keys, or the updater trust boundary (M23).
2. Weakening a CRITICAL guard: dev/prod data, push-first, release gate, dep guard, hash/crypto.
3. Real-data destruction, production-server mutation, deleting tags, or force-push.
4. Publishing: Play/TestFlight uploads, tagging a release, posting to Zulip, F-Droid.
5. Changing specified intent rather than closing a Gap.
6. Sync payload, `BRIDGE_VERSION`, or `AppState` schema changes.

After two failed approaches, stop, write competing hypotheses, and run the cheapest discriminator.
If evidence contradicts the task premise, report it before acting.

## 12. Drift watchlist (same logic in ≥2 places — move in lockstep)

`just check-drift` owns registered copies. Three unlocked risks must move together:
- Notes-root split: Rust `vault_location.rs`, iOS `NotesStore.swift`, Android `NotesStorage.kt`.
- Sort order: Rust `note_list_order` + browser `compareNoteOrder`; shells consume engine positions.
- Unique note-ID generation in Rust, TypeScript, Swift, and Kotlin.

## 13. Own the E2E experience

For demos/migrations, own client + server + data + launcher until the user sees the result.
