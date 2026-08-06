# Tauri frontend platform adapter contract rewrite

## Scope and starting point

- Starting commit: `9ecd1f521254cc4c5101fa720249f56eece62f84` (`origin/main`, clean detached worktree).
- Owner: `src/lib/platform/tauri/`.
- Stable facade: `src/lib/platform/tauri.ts`.
- Out of scope: the Rust Tauri shell, note-store domain, sync domain, and unrelated frontend features.
- The optional contract-rewrite guides `references/futo-notes.md` and `references/ledger.md`
  were absent from the installed skill. The phase and gate definitions in `SKILL.md`, root
  `AGENTS.md`, and the repository suite map are used directly instead.

## Pre-rewrite architecture

The live implementation was a 469-line `tauri.ts` module that owned storage, vault-root caching,
image URL probing, event subscriptions, and app-config persistence. Five files under
`platform/tauri/` duplicated parts of that behavior but were not composed by the live facade;
`tauriPaths.ts` held vault command wrappers outside the declared owner. The adapter therefore had
three competing structural centers even though only `tauri.ts` shipped.

Initial physical-line accounting (tests excluded from production):

| Kind                                                   | Files | Lines |
| ------------------------------------------------------ | ----: | ----: |
| Production (`tauri.ts`, `tauri/*.ts`, `tauriPaths.ts`) |     7 |   703 |
| Focused adapter tests                                  |     5 |   582 |

## Executable contract baseline

| Command                                                       | Result before acceptance additions                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm exec vitest run ...` (7 focused adapter/consumer files) | 45/45 passed                                                      |
| `just test-unit`                                              | 150/150 passed                                                    |
| `pnpm run test:unit:full`                                     | 788 passed, 10 skipped (798 total)                                |
| `pnpm exec tsc --noEmit \| head -30`                          | passed, no output                                                 |
| `just build \| tail -20`                                      | passed; Vite emitted `dist/assets/`                               |
| `just test-e2e`                                               | 2/2 passed                                                        |
| `just test-desktop-smoke`                                     | blocked before tests: recipe omits required `--port`/`--log-file` |

## Behavioral invariants

| ID  | Invariant                                                                                                                                                                                                  | Source                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| I1  | Every consumer-backed `PlatformFS` capability remains available; clipboard writing is a required shell capability, while platform identity is owned by the platform facade.                                  | `src/lib/platform/types.ts`, direct consumers                |
| I2  | App-data paths stay beneath the active vault; absolute, empty-component, dot, and traversal paths are rejected before plugin I/O.                                                                          | root `AGENTS.md` path-safety rule, `pathSafety.test.ts`      |
| I3  | Missing app-data files translate to `null`/empty lists and missing deletes are idempotent; permission and other non-missing failures propagate.                                                            | current consumers and baseline tests                         |
| I4  | Text app-data writes remain same-directory atomic writes and read-modify-write config saves never clobber fields after a failed read.                                                                      | app-state/config safety, `atomicWrite.test.ts`, config tests |
| I5  | `.app-config.json` retains the shipped keys and JSON shapes for widths, expanded folders, and tab order/active tab/per-tab state. `null`, missing, and empty-list meanings remain distinct.                | `tabs.md`, root `AGENTS.md`, config tests                    |
| I6  | The active notes root is a persisted override or the Rust-resolved default; TypeScript never reconstructs the default path.                                                                                | CRITICAL M3, `app.md`, `desktop-rust.md`                     |
| I7  | `FUTO_NOTES_DATA_DIR` and the debug `fake-notes`/release `futo-notes` split remain delegated to `resolve_default_notes_root` in Rust.                                                                      | CRITICAL M3, `vault_location.rs`, path tests                 |
| I8  | Changing or clearing the override validates absolute paths, creates an accepted directory, persists through the shipped command, and invalidates cached root state.                                        | Settings behavior and config tests                           |
| I9  | File-change listeners forward payloads, return idempotent cleanup functions, and dispose native unlisteners even when teardown wins the async registration race.                                           | `startNativeShell.test.ts`, direct consumer                  |
| I10 | File watching starts through the shipped `fs_start_watcher` command; Rust remains the single watcher owner and continues to emit `fs:change`.                                                              | `desktop-rust.md`, `filesystem_watcher.rs`                   |
| I11 | Image import uses shipped commands/accepted extensions; byte paste writes the generated vault-relative image and inline rendering uses an actually decodable asset URL or a correctly typed blob fallback. | `editor.md`, image tests                                     |
| I12 | The asset-protocol result is capability-cached for the adapter lifetime; blob URLs are handed to the editor image cache, which revokes replaced and cleared blob URLs.                                     | `editor.md`, `liveMarkdownTransform.imageBase.test.ts`       |
| I13 | Flat image deletion and URL resolution reject traversal and non-image filenames before disk access.                                                                                                        | `list.md`, `imageFiles.test.ts`                              |
| I14 | Tauri command/plugin failures retain actionable messages; only explicitly recognized missing-file errors become absence sentinels.                                                                         | consumers, config/crash tests                                |
| I15 | First render remains synchronous: `initialized = true` occurs before platform, preference, notes, crash, sync-password, or updater I/O resolves.                                                           | CRITICAL M1, `app.md`, `createAppBootstrap.svelte.ts`        |
| I16 | Platform initialization remains lazy and synchronous `getFS()` remains unavailable until the async adapter load has completed.                                                                             | `platform/index.ts`, editor/crash consumers                  |
| I17 | App-state, crash logs, E2EE state probes, and app config continue to share the active vault without moving note CRUD into `PlatformFS`.                                                                    | root ownership rules, app/sync consumers                     |

## Test-disposition ledger captured before replacement

Definitions used here: **Fast** is rebuilt against the new public design; **Acceptance** remains an
outside-in application or facade gate; **Core** is owned by an unchanged lower layer;
**Obsolete** protects only a retired mechanism; **Follow-up** needs deliberate fault injection.

All 45 tests in the untouched focused baseline are translated below. Parametrized tests name their
exact executed case count.

| Existing test                                         | Plain-English promise                                                                         | Disposition                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| `tauriConfig.test.ts` — default config                | With no override/config file, use the Rust default and no optional layout values.             | Fast                              |
| `tauriConfig.test.ts` — custom directory              | A persisted override becomes the active root and is reported as custom.                       | Fast                              |
| `tauriConfig.test.ts` — sidebar widths                | Both shipped width keys deserialize from `.app-config.json`.                                  | Fast                              |
| `tauriConfig.test.ts` — read denied                   | A startup config read denial degrades to defaults instead of blocking the UI.                 | Fast                              |
| `tauriConfig.test.ts` — invalid JSON                  | Malformed layout JSON degrades to absent optional values.                                     | Fast                              |
| `tauriConfig.test.ts` — merge sidebar width           | Updating one key preserves unrelated persisted keys and writes atomically.                    | Fast                              |
| `tauriConfig.test.ts` — null width                    | Explicit `null` is persisted, not conflated with an omitted update.                           | Fast                              |
| `tauriConfig.test.ts` — expanded folders              | `openFolders` persists beside unrelated config fields.                                        | Fast                              |
| `tauriConfig.test.ts` — denied save read              | A read-modify-write save fails without writing when the current file cannot be read.          | Fast                              |
| `tauriConfig.test.ts` — no folder key                 | Missing `openFolders` means “never persisted” (`null`).                                       | Fast                              |
| `tauriConfig.test.ts` — missing file                  | A missing config file also means “never persisted” (`null`).                                  | Fast                              |
| `tauriConfig.test.ts` — filter folders                | Only string folder paths survive deserialization.                                             | Fast                              |
| `tauriConfig.test.ts` — empty folders                 | Persisted `[]` remains distinct from missing (`null`).                                        | Fast                              |
| `tauriConfig.test.ts` — absolute override             | An absolute selected directory is created and saved through the shipped command.              | Fast                              |
| `tauriConfig.test.ts` — clear override                | `null` clears the persisted custom directory.                                                 | Fast                              |
| `tauriConfig.test.ts` — relative override             | Relative custom roots are rejected before persistence.                                        | Fast                              |
| `tauriPaths.test.ts` — override present               | `notes_dir_override_load` results pass through unchanged.                                     | Fast                              |
| `tauriPaths.test.ts` — override absent                | A missing override remains `null`.                                                            | Fast                              |
| `tauriPaths.test.ts` — save override                  | Custom roots use `notes_dir_override_save { dir }`.                                           | Fast                              |
| `tauriPaths.test.ts` — clear override                 | Clearing uses the same command with `dir: null`.                                              | Fast                              |
| `tauriPaths.test.ts` — env-derived default            | Default-root lookup delegates to `resolve_default_notes_root`, including worktree isolation.  | Fast + Core (`vault_location.rs`) |
| `tauriPaths.test.ts` — production default passthrough | The exact Rust-resolved default is returned without TS rewriting.                             | Fast + Core (`vault_location.rs`) |
| `tauriPaths.test.ts` — overridden active root         | An override is preferred and recursively created.                                             | Fast                              |
| `tauriPaths.test.ts` — default active root            | With no override, the Rust result is recursively created and used.                            | Fast + Core                       |
| `tauriPaths.test.ts` — isolated active root           | An env-derived Rust root is used as the active root.                                          | Fast + Core                       |
| `tauriPaths.test.ts` — ensure directory               | Directory creation is recursive.                                                              | Fast                              |
| `imageMime.test.ts` — 10 MIME cases                   | Every accepted extension maps to its correct blob content type.                               | Fast                              |
| `imageMime.test.ts` — SVG regression                  | SVG never falls back to `image/png`.                                                          | Fast                              |
| `imageMime.test.ts` — case folding                    | MIME lookup is case-insensitive.                                                              | Fast                              |
| `imageMime.test.ts` — unknown fallback                | Unknown/empty extensions safely default to PNG MIME.                                          | Fast                              |
| `imageMime.test.ts` — accepted-set coverage           | The MIME map covers the editor-owned image extension set.                                     | Fast + Core (image conformance)   |
| `imagePasteWhite.test.ts` — undecodable asset         | A saved image whose asset URL cannot decode renders the exact saved bytes through a blob URL. | Acceptance                        |
| `imagePasteWhite.test.ts` — decodable asset           | A decodable asset URL remains the zero-copy render path.                                      | Acceptance                        |
| `tauri/clipboard.test.ts` — native write              | Copy-file-path text is delegated unchanged to the clipboard plugin.                           | Fast                              |
| `startNativeShell.test.ts` — late teardown            | App teardown disposes file/window handlers even when async registration finishes later.       | Acceptance                        |
| `startTabsPersistence.test.ts` — late hydration       | Teardown prevents delayed config/notes readiness from hydrating or installing persistence.    | Acceptance                        |

The MIME parameter row executes 10 cases, so the table accounts for 36 declarations and 45
executed tests. Additional unchanged guarding suites are classified as **Core** rather than copied:
`atomicWrite.test.ts` (12), `pathSafety.test.ts` (29), `imageFiles.test.ts` (20),
`liveMarkdownTransform.imageBase.test.ts` (blob revocation), `crashHandler.test.ts` (6), and
`appState.test.ts` (2). The full unit and Playwright suites remain **Acceptance** gates.

## Replacement report

### Architecture after replacement

`src/lib/platform/tauri.ts` is now a 20-line composition boundary. It constructs exactly one
adapter and one app-config store, then exports the stable frontend facade. `PlatformFS`
intentionally gains required clipboard writing so consumers no longer import a Tauri-private
module. The implementation is owned by the narrow subsystem:

- `tauri/adapter.ts` is the single owner of adapter construction and shared lifetime state: the
  active root and watcher-start promises. It composes `PlatformFS` and owns listener lifecycle
  without owning note-domain behavior.
- `tauri/storage.ts` owns concrete text app-data and root-file plugin I/O through an injected root
  accessor; it has no ambient root state.
- `tauri/images.ts` owns concrete image import, byte-save, render-URL, MIME policy, picker
  operations, and the asset-protocol capability promise through an injected root accessor.
- `tauri/appConfig.ts` owns the `.app-config.json` schema and persistence policy through an
  injected `PlatformFS` storage boundary.
- `tauri/notesRoot.ts` owns the concrete command projection for persisted overrides and the Rust
  default-root resolver. It contains no frontend path policy.
- Clipboard writing is part of the shared `PlatformFS` boundary and is projected directly by the
  adapter; it no longer requires a Tauri-private forwarding module.

The replacement preserved all shipped command names, consumer-backed public TypeScript contracts,
persisted keys, and plugin behavior. A final consumer audit then removed four surfaces that never
represented shipped behavior: the un-emitted `menu:action` path, unused binary app-data methods,
the constant `getPlatformName()` storage method, and the facade re-export of the image-owned MIME
helper. The old implementation had one observed bug: simultaneous `onFileChange`
registrations could each invoke `fs_start_watcher` because a boolean was set only after the first
command resolved. The acceptance regression was observed failing against the old implementation
(`expected 1 invocation, received 2`); the adapter now caches the in-flight promise. No second
strike occurred, so the rewrite did not fall back to an old seam.

### G1 — executable target and counts

The subsystem has an explicit target, `pnpm run test:platform-tauri`, and the same files are wired
into `just test-unit` rather than living outside the default local gate.

| Command | Baseline | Replacement |
| ------- | -------- | ----------- |
| Focused platform/consumer Vitest | 45/45, 7 files | 59/59, 9 files |
| `just test-unit` | 150/150, 19 files | 199/199, 27 files |
| `pnpm run test:unit:full` | 788 passed, 10 skipped (798 total) | 805 passed, 10 skipped (815 total) |
| `pnpm exec tsc --noEmit \| head -30` | passed, no output | passed, no output |
| `just build \| tail -20` | passed | passed; `dist/assets/` emitted |
| `just test-e2e` | 2/2 | 2/2 |
| `pnpm exec playwright test tests/image-paste.spec.ts` | not separately run | 3/3 |
| Desktop smoke | zero-argument recipe blocked before tests | supported manual invocation 4/4 |
| `just check` | not run as a baseline suite | passed after regenerating `GAPS.md` |

The first post-rewrite `just check` correctly failed at `spec-gaps-check` because the edited specs
made generated `docs/spec/GAPS.md` stale. `just spec-gaps` regenerated 12 gaps, and the rerun passed
the architecture gates, Rust conformance (6/6), frontend units, editor tests (341/341), typecheck,
and Vite build. The Tauri application also compiled and launched from a cold worktree through
`just tauri-dev`; `node tests/desktop-smoke.mjs --port 9224` then passed backend, JavaScript bridge,
editor typing, and screenshot checks (4/4). The repository's `just test-desktop-smoke` recipe
itself remains unusable without a running-app `--port` or `--log-file` argument.

### G2 — final disposition of replaced tests

No baseline behavioral promise was classified **Obsolete** or **Follow-up**, and no baseline
promise was deleted. The private mechanisms were disposable; the behavior was not. Exact
replacement accounting is:

| Baseline test source | Final guard |
| -------------------- | ----------- |
| `src/lib/platform/tauriConfig.test.ts` (16) | Same named scenarios in `src/lib/platform/tauri/appConfig.test.ts`, now against the injected store composed by the public facade. |
| `src/lib/platform/tauriPaths.test.ts` (10) | Same command/root scenarios in `src/lib/platform/tauri/notesRoot.test.ts`, plus `keeps environment isolation and the debug/production split Rust-owned`. |
| `src/lib/platform/imageMime.test.ts` (14 executed cases) | Same MIME and accepted-extension scenarios in `src/lib/platform/tauri/images.test.ts`. |
| `src/lib/platform/imagePasteWhite.test.ts` (2) | `imageRendering.contract.test.ts > (A) asset URL undecodable...` and `(B) asset URL decodable...`. |
| `src/lib/platform/tauri/clipboard.test.ts` (1) | `adapter.contract.test.ts > writes text through the native clipboard plugin`. The obsolete forwarding module is gone. |
| `src/app/startNativeShell.test.ts` (1) | Retained acceptance scenario `disposes handlers that finish registering after teardown`. |
| `src/app/startTabsPersistence.test.ts` (1) | Retained acceptance scenario `does not hydrate or install a persister after teardown`. |

New outside-in coverage is explicit rather than inferred from private helpers:

- `adapter.contract.test.ts`: full `PlatformFS` capability surface; missing/error translation;
  atomic text storage; root-file metadata; flat-image safety; command delegation; exact tab JSON;
  root invalidation; watcher coalescing; payload forwarding; late file-change unlisten.
- `createAppBootstrap.contract.test.ts > marks the shell initialized before any background I/O
  resolves`: the CRITICAL non-gated render promise.
- `index.contract.test.ts > keeps synchronous access gated only until the lazy Tauri adapter
  resolves`: lazy adapter loading and synchronous capability behavior.

The mechanisms removed as precisely obsolete are the duplicate, unused implementations in
`tauri/events.ts` and `tauri/notesRoot.ts`, the out-of-owner `tauriPaths.ts` forwarding layer, and
the second app-config implementation embedded in the old facade. Their public behavior is guarded
above; no test remains coupled to those old module seams. After the replacement, two new
mechanism-only tests were also removed: binary app-data round-tripping had no product consumer, and
late `menu:action` teardown guarded an event no Tauri code emitted. The live file-subscription
teardown race was transferred to
`adapter.contract.test.ts > disposes a file-change unlistener that resolves after subscription
teardown`.

### G3 — physical line and module accounting

Counts use physical lines, including comments and blanks. Production and tests are deliberately
separate; deleting or moving tests is not credited as production reduction.

| Scope | Before | After | Delta |
| ----- | -----: | ----: | ----: |
| Production files/modules | 7 | 6 | -1 (-14.3%) |
| Production lines | 703 | 454 | -249 (-35.4%) |
| In-scope test files | 7 | 9 | +2 (+28.6%) |
| In-scope test lines | 716 | 1,083 | +367 (+51.3%) |
| Production + test lines | 1,419 | 1,537 | +118 (+8.3%) |

The smaller production result therefore comes from deleting duplicate runtime structure, not from
deleting behavioral verification. Compatibility is concentrated in the earned 20-line facade; there are no
deprecated aliases or private forwarding modules left.

### G4 — invariant-to-guard map

| Invariant | Exact guarding test or scenario |
| --------- | ------------------------------- |
| I1 | `adapter.contract > exposes every required PlatformFS operation and native capability` |
| I2 | `pathSafety.test > rejects absolute paths / .. traversal / empty components / . components`; `adapter.contract > rejects unsafe flat image operations before plugin I/O` |
| I3 | `adapter.contract > translates only missing app-data operations into absence sentinels` |
| I4 | `adapter.contract > writes text app data atomically beneath the active root`; `appConfig.test > does not write a partial config when the existing config read is denied`; all 12 `atomicWrite.test.ts` cases |
| I5 | `adapter.contract > preserves the shipped open-tab persistence shape in .app-config.json`; `appConfig.test` config merge/null/openFolders cases; `startTabsPersistence.test` late-hydration acceptance |
| I6 | `notesRoot.test > returns override dir when set and creates it`; `returns Rust-resolved default dir when no override and creates it` |
| I7 | `notesRoot.test > delegates to Rust (honors FUTO_NOTES_DATA_DIR)`; `keeps environment isolation and the debug/production split Rust-owned` |
| I8 | `adapter.contract > caches the active root until changing the override invalidates it`; `appConfig.test` absolute/clear/relative `setNotesDir` cases |
| I9 | `adapter.contract > forwards native payloads and requests the Rust-owned watcher`; `disposes a file-change unlistener that resolves after subscription teardown`; `startNativeShell.test > disposes handlers that finish registering after teardown` |
| I10 | `adapter.contract > coalesces concurrent watcher starts into one Rust command`; `forwards native payloads and requests the Rust-owned watcher` |
| I11 | Both `imageRendering.contract.test.ts` A/B scenarios; all `images.test.ts` MIME/accepted-extension cases; Playwright `image-paste.spec.ts` (3/3) |
| I12 | Both image-rendering A/B scenarios; `liveMarkdownTransform.imageBase.test.ts > revokes a replaced blob...` and `clearLocalImageUrlCache revokes all...` |
| I13 | `adapter.contract > rejects unsafe flat image operations before plugin I/O`; `imageFiles.test > rejects traversal attempts` for filename generation and deletion |
| I14 | `adapter.contract` missing/error and command-failure scenarios; `appConfig.test` denied-read scenarios; `crashHandler.test > still queues to localStorage when immediate write fails` |
| I15 | `createAppBootstrap.contract > marks the shell initialized before any background I/O resolves`; Playwright P0 smoke (2/2) |
| I16 | `index.contract > keeps synchronous access gated only until the lazy Tauri adapter resolves`; desktop smoke `execute JS` and `editor present + typing` |
| I17 | `adapter.contract > writes text app data atomically beneath the active root`; `syncPassword.test.ts` `.app-state.json` round trips; `crashHandler.test` write scenarios; `appConfig.test` persistence scenarios |

### G5 — consumer verification

- Public facade and every direct import compile under TypeScript; command reachability reports 33
  registered commands and zero intentionally dead commands.
- The platform-discipline gate reports zero unsanctioned Tauri imports outside platform shims.
- The default unit gate, full frontend/editor suites, targeted image Playwright suite, and P0 E2E
  suite are green with the counts above.
- The Rust Tauri shell compiled both through `check:sync-contract` and a full `just tauri-dev`
  launch. No Rust source or command registration changed.
- Real Tauri-facing application behavior passed the four-check MCP desktop smoke against isolated
  worktree data at `.tauri-data`; no production vault was touched.

### G6 — documentation and file disposition

Updated behavioral/ownership specifications: `docs/spec/app.md`, `desktop-rust.md`, `editor.md`,
`settings.md`, and `tabs.md`; regenerated `docs/spec/GAPS.md`; added this ledger/report.

Removed production modules:

- `src/lib/platform/tauri/events.ts` — unused duplicate listener/watcher state.
- The baseline implementation of `src/lib/platform/tauri/notesRoot.ts` — unused duplicate root
  cache; the path is reused below for the replacement root-resolution owner.
- `src/lib/platform/tauriPaths.ts` — forwarding layer outside the chosen owner.

Added production modules:

- `src/lib/platform/tauri/adapter.ts` — sole adapter construction and shared-lifecycle owner.
- `src/lib/platform/tauri/storage.ts` — stateless concrete shell-storage capability.
- `src/lib/platform/tauri/images.ts` — concrete image capability and image-protocol state owner.
- `src/lib/platform/tauri/notesRoot.ts` — co-located concrete notes-root command projection.

Removed after capability consolidation:

- `src/lib/platform/tauri/imageUrls.ts` — MIME, decode, and asset capability policy now lives with
  the image operations in `images.ts`.
- `src/lib/platform/tauri/clipboard.ts` — the one-line forwarding layer is now represented by the
  shared `PlatformFS.writeClipboardText` capability and concrete platform implementations.

Retained or rewritten:

- `src/lib/platform/tauri.ts` — retained because the stable 20-line facade/composition boundary is
  consumed throughout the app.
- `tauri/appConfig.ts` — rewritten and activated as the sole config owner.
- Image policy remains co-located with `images.ts`; clipboard delegation moved to the public
  adapter contract; the two application acceptance tests remain in place.

### Comparison-ready assessment

Strengths: explicit lifecycle owners, no competing implementations, preserved consumer-backed and
persisted contracts, a 35.4% production-line reduction, coalesced asynchronous lifecycle
operations, and substantially stronger outside-in coverage wired into the normal gate.

Tradeoffs: total production-plus-test lines grew 8.3%; extracting the concrete storage and image
capabilities increased production from the rewrite's initial 440-line form, while consolidating
image URL policy, clipboard projection, and unused capability cleanup brought the final shape to
454 lines and reduced `adapter.ts` from 239 to 76 lines. Each capability owns only its
resource-specific state, so the implementation modules do not compete with adapter construction.
The stable facade is compatibility surface, not a second implementation.

Residual risks: fast tests mock Tauri plugins, so asset-protocol and filesystem permission behavior
still depend on the real desktop smoke and platform QA. Removing `onMenuAction` assumes the native
menu remains absent; adding one later should introduce its Rust emitter and frontend contract
together. Finally, the zero-argument desktop-smoke `just` recipe remains miswired; the underlying
supported smoke command passed, but repairing the general test harness was outside this subsystem
rewrite.
