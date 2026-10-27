# Architecture Gates

The architecture gates are fast, static repository checks that prevent known forms of boundary
and cross-platform drift. Run the same set locally with:

```bash
just arch-gate
```

`just check` includes `arch-gate`. Install workspace dependencies first with `just install`; the
bridge-spec check uses `tsx`, while the other checks only read repository files.

## Checks

| Check                | Inputs                                                                                                                     | What fails                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Command reachability | Tauri's `generate_handler!`, literal `invoke("...")` calls under `src/`, and `scripts/command-reachability-allowlist.json` | An uncalled registered command, an unregistered invoked command, or a stale allowlist entry                                                   |
| Platform discipline  | `@tauri-apps/*` imports under `src/` and `scripts/platform-discipline-allowlist.json`                                      | A direct Tauri import outside `src/lib/platform/**` without an explicit exception, or a stale exception                                       |
| Native bridge specs  | `packages/editor/src/bridge.ts` and generated Kotlin/Swift specs                                                           | Generated message types or bridge versions are stale; run `just bridge-spec` and commit the results                                           |
| Tauri sync contract  | Rust records in `apps/tauri/src-tauri/src/sync/frontend_contract.rs` and generated TypeScript                              | Generated frontend types are stale; run `just sync-contract` and commit the result                                                            |
| Drift registry       | Copies, locks, and optional scan patterns in `scripts/drift-registry.json`                                                 | A registered copy or lock disappeared, a detection pattern became stale, lock status is inconsistent, or a scan finds a new unregistered copy |
| Agent instructions   | Commands, paths, and linked skills named by repository instruction surfaces                                                | An instruction points at a missing recipe, script, path, or skill                                                                             |
| QA input safety      | Instruction surfaces (README, CONTRIBUTING, every `AGENTS.md`, `docs/**`, `.claude/skills/**`, `.claude/agents/**`, `.claude/workflows/*`) and `scripts/qa-input-safety-allowlist.json` | An instruction file teaches OS-level input into this app, a process-name/PID lookup against it, or a relative `find -newermt` check; or a pinned exception went stale |
| Single-pace theming  | Theme-dependent CSS transitions, Android top bars, and iOS appearance overrides                                            | A theme swap could repaint one surface later than the rest                                                                                    |

Each gate must observe something no other gate already observes. Prefer extending the gate that
owns a boundary over adding a second number about it.

## QA input safety, and the resolver it points at

On 2026-08-10 a QA agent drove the desktop app with real OS keystrokes after
resolving a PID by process name. Every build ships the same binary name — the
installed release app's executable is literally
`/Applications/FUTO Notes.app/Contents/MacOS/futo-notes-tauri` — and several run
at once during parallel QA, so the lookup resolved to the user's production app
on their real, sync-connected vault. The keystrokes went there.

Two mechanisms, doing different jobs:

- `scripts/qa-target.mjs` is the **only** sanctioned way to turn a port or PID
  into a drivable desktop target. It classifies by the executable's real path
  against this repo's worktree list, plus the instance's own data dir and vault,
  and fails closed: exit 3 for an installed bundle, a system package, a release
  profile build, a sibling worktree's instance, or an instance whose vault it
  cannot prove is isolated. It deliberately offers no way to send OS input.
- `scripts/check-qa-input-safety.mjs` keeps the technique from being taught
  again. Its allowlist pins **exact lines**, so prose that names a banned
  technique in order to forbid it stays legal while a fresh occurrence — even in
  the same file — fails, and a pinned line that disappears fails as stale.

What is enforced versus merely written down: an unsafe *resolution* is
impossible through the resolver, and an unsafe *instruction* is impossible to
land in a scanned surface. An agent that improvises OS input from its own memory
is still only discouraged — nothing inside this repo can revoke a shell's access
to the window server. Related runtime guard: M3's dev/prod split, which is what
makes an isolated QA vault possible in the first place.

## Fixing failures

- Prefer removing an unnecessary command, import, or duplicate instead of adding an exception.
- Add an allowlist entry only when the boundary crossing is intentional, and include a concrete
  reason. Both allowlist gates reject entries once they become stale.
- When duplicated logic is genuinely required across platforms, register every copy and its
  fixture, generator, or test in `scripts/drift-registry.json`. Use `partial` or `unlocked`
  honestly when full conformance coverage does not exist.

## Targeted gate red-proofs

A gate that is green because it silently does nothing is worse than no gate at all — six commits
(`d87173eb`, `54d1cc41`, `90a62902`, `a6c6e2d5`, `db31586c`, `f81a61d0`) fixed guards that stepped
over real violations while reporting success. When you add or change a gate, seed one violation it
claims to catch and confirm it exits non-zero **and names what it found**; an exit-code-only pass is
not evidence, because a gate that dies on a missing module also exits non-zero.

`scripts/gate-redproofs.mjs` retains the reusable proof harness without putting it on every
`just check`, `prepush`, or CI `test:` run. For each covered gate it seeds exactly one violation in
a throwaway worktree and requires the gate to fail while naming the seeded violation; it also
requires the pristine gate to pass and self-tests the harness against fixture gates.

Run it when adding or changing a gate:

```bash
node scripts/gate-redproofs.mjs --include-cargo  # all proofs, including the cargo-dependent one
pnpm run check:gate-redproofs                     # portable proofs only
```

Add or update the corresponding proof in the same change. This preserves the red evidence at the
point where it can change without re-proving unchanged gates on every unrelated commit.

## Scope and limits

These gates are structural source scans, not proofs of runtime behavior. Command reachability
recognizes literal `invoke("name")` calls. Drift detection only discovers new copies for concepts
with a suitable registered scan pattern. The bridge-spec gate proves that the generated native
contract is current; Android unit tests separately check handler coverage, and behavioral tests
remain responsible for handler correctness.

The individual recipes remain available for focused diagnosis:

```bash
just check-command-reachability
just check-platform-discipline
just bridge-spec-check
just check-drift
just check-agent-docs
just check-qa-input-safety
just check-theme-single-pace
node scripts/gate-redproofs.mjs --include-cargo
```

The `check:arch-gate:portable` script in `package.json` owns the shared check list; `check:arch-gate`
adds the cargo sync-contract test on top. The root `justfile` calls `check:arch-gate` and
`.gitlab-ci.yml` calls the portable script. CI installs pinned `just` through `ci/install-just.sh` before
running the docs gate, which reads recipe names and alias targets from its JSON metadata. When
adding or removing a gate, change only `check:arch-gate:portable`; do not duplicate the command list in
either caller.

## Not here: the dependency vulnerability scan

`node scripts/audit.mjs` runs `cargo audit` and `pnpm audit --prod`. It stays out of `arch-gate`
because it needs the network — the RUSTSEC database and the npm registry — while every gate above is
an offline source scan.

**It fails only on a vulnerability in code that ships.** On npm that is `--prod`. On Rust it is a
crate `cargo tree -e normal --target all` reaches from `futo-notes-tauri` or `futo-notes-ffi`; a
vulnerability in a dev- or build-only crate is listed as `unshipped`, and unmaintained/unsound
warnings are listed too, but neither fails the run. The app is offline-first, not offline: sync,
license activation and the updater all speak TLS, so a shipped-crate advisory is worth a yellow.

**CI runs it as a reporter, not a blocker.** `test:audit` is `allow_failure: true` and is deliberately
*absent* from `release:gate.needs` — a documented exception to M14. An advisory appears when the
database moves, not when our code does, so a hard gate would stop a release over a finding nobody
has had time to read. Restoring
either turns this back into a release blocker, which is a product decision rather than a hardening
fix.

Acknowledgments live in the tools' own ignore lists:

- Rust: `[advisories] ignore` in `.cargo/audit.toml`
- npm: `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`

An id there says a person looked at that advisory and decided it is fine to ship, so nothing is
added on anyone else's behalf. Silencing an advisory is a choice someone makes and signs, not a step
in going green: the normal fix is the bump, and an acknowledgment is for an advisory with no fixed
release that does not reach users (the zip entries in `.cargo/audit.toml` are the model). Add the id with a comment
recording whether it ships, how it goes away, and who owns it.

`node scripts/audit.mjs` also names ignore entries the audits no longer report, and
`node scripts/audit.mjs --fix` removes them with the comment explaining them — the only thing
keeping the lists from growing forever. It is not automatic: a wrong "no longer detected" would
delete hand-written analysis, and a self-healing `audit.mjs` means a self-healing CI job. How that
is detected without trusting a tool that under-reports is documented in `scripts/audit.mjs` itself,
which both a local run and CI's `test:audit` call directly — the pinned CI image has no `just`, the
same reason arch-gate's command list lives in `package.json`.

## Not here: the puppet gates

`check-puppet-verbs` (a UI handler or labelled control no `futo-puppet` verb claims, or a stale
`scripts/puppet-verbs-allowlist.json` entry) and `check-puppet-first` (an instruction surface that
teaches driving the app with anything but `just puppet`) are described in
`docs/agents/justfile-notes.md`. They warn rather than block, by design: CI runs both in
`test:puppet-gates`, `allow_failure: true` and deliberately absent from `release:gate.needs`, and
`just arch-gate` leaves them out. Run them with `just check-puppet-verbs` and `just check-puppet-first`.

## Not here: the localization completeness audit

`pnpm run audit:languages` reports missing, extra, unchanged, and placeholder-omitting translations.
It stays outside `arch-gate` because it is a translation-completeness check, not a source scan, but
CI's `test:localization-audit` is blocking and in `release:gate.needs`: every committed catalog
translates every `en.json` message. Catalog syntax and executable message structure are checked
separately by the language-catalog unit test in the mandatory `test` job.
