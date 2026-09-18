# AGENTS.md — scripts/

Everything the justfile actually runs: architecture gates, code generators, build and release
steps, QA device tooling, and CI helpers. **The justfile is the invocation authority** — add a
recipe for a new script rather than teaching people a raw `node` invocation. Every script's
header comment is its spec, and several of them explain a specific past failure; read the header
before changing behavior.

## Categories

- **Gates** (`check-*.mjs`, `drift-check.mjs`): deny-by-default checks. Most are wired into
  `pnpm run check:arch-gate`, which is what CI's mandatory test job runs; `package.json` owns that
  membership because the pinned CI image has no `just`. `check-rust-dependency-boundaries.mjs` is
  the exception — it needs `cargo metadata`, so it runs only in CI's Rust workspace job.
  `language-catalogs.mjs` is a gate too but does not match that filename pattern: it backs
  `pnpm run check:languages`, which every new user-visible string must pass, and its `--audit` mode
  backs the deliberately non-blocking `test:localization-audit` CI job. Neither is in
  `check:arch-gate`, so check the membership before assuming a local `just check` covered your
  change.
- **Generators**: `gen-toolbar-spec.ts`, `gen-title-spec.ts` and `gen-bridge-spec.ts` each take
  `--write` and `--check`, so the same script both regenerates and gates.
  `generate-native-language-resources.mjs` takes `--android` / `--ios` / `--all` instead and is
  driven by the native builds. All four write files nobody may hand-edit (AGENTS.md M8).
- **Build and release** (`build-rust-{ios,android}.sh`, `release-build.mjs`, `patch-appimage.mjs`,
  `verify-updater-signature.mjs`, `build-updater-manifest.mjs`, `publish_playstore.py`).
- **QA and device tooling** (`qa.mjs`, `qa-target.mjs`, `qa-shot.mjs`, `android-drive.mjs`,
  `cdp-invoke.mjs`, `describe-ios-ui.mjs`, `tauri-dev.mjs`, `win-vm/`).
- **CI helpers** (`ci-*.sh`, `ci-cargo-cache-freshness.mjs`, `remote-test.mjs`).
- **Shared** (`lib/`): `slot.mjs` derives every per-worktree port and device slot; `sync-server.mjs`
  runs the pinned sync-server release; `spawn-result.mjs` normalizes child-process results.

## Rules

The root manual's M11 (silent green), M12 (CI path assumptions), M24 and M25 (QA input and pattern
kills) all land hardest here; it is loaded every session, so this file adds only what is specific
to writing a script in this directory.

- **A gate that can be green while a violation exists is worse than no gate.** The gates themselves
  have been the culprit five separate times — the history is in `gate-redproofs.mjs`'s header.
  Adding or changing one means adding a red-proof there and running `just gate-redproofs`. It
  proves both directions: green on a pristine checkout, and red on one seeded violation *with the
  violation named in the output*, because an exit code alone also fires when the gate crashes on a
  missing module.
- **A new allowlist entry is a decision, not a fix.** `command-reachability-allowlist.json`,
  `platform-discipline-allowlist.json`, `qa-input-safety-allowlist.json` and `drift-registry.json`
  each carry a written justification per entry (`drift-registry.json` calls its field
  `description`), and a stale entry fails its own gate. Widening one to get green is the thing the
  gate exists to make visible.
- **Cleanup deletes only paths the script itself created**, never a computed ancestor.
- **Device and process safety is enforced, not advisory.** `check-qa-input-safety.mjs` scans every
  instruction surface in the repo, including this file, and `qa-target.mjs` is the only sanctioned
  way to turn a port or PID into something you may drive. Read their headers before working around
  either — each one exists because of a specific incident.

## Testing

Most scripts have a co-located `*.test.mjs`. `vitest.config.ts` includes `scripts/**/*.test.mjs`,
so `just check` (via `pnpm run test:full`) runs all of them; the minimal set in
`pnpm run test:unit` is a faster subset.

```bash
just test-unit            # includes the script tests in the minimal set
just test-one scripts/qa-target.test.mjs
just gate-redproofs       # only when you changed a gate
just arch-gate            # the focused checks CI's mandatory job runs
```
