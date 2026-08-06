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
| Debt ratchet         | Current source/spec/registry counts and `scripts/debt-ratchet.json`                                                        | Debt increased, or debt decreased without lowering the checked-in baseline in the same change                                                 |
| Gate red-proofs      | Every gate above plus the spec/contract generators, each re-run against one seeded violation in a throwaway `git worktree`  | A gate exits 0 on a seeded violation, exits non-zero without naming it, or is already red on a pristine checkout                              |

The platform allowlist and debt ratchet answer different questions. The allowlist records direct
Tauri access that is currently accepted. The ratchet still counts accepted legacy exceptions so
their total cannot grow and cleanup cannot silently regress.

## Fixing failures

- Prefer removing an unnecessary command, import, or duplicate instead of adding an exception.
- Add an allowlist entry only when the boundary crossing is intentional, and include a concrete
  reason. Both allowlist gates reject entries once they become stale.
- When duplicated logic is genuinely required across platforms, register every copy and its
  fixture, generator, or test in `scripts/drift-registry.json`. Use `partial` or `unlocked`
  honestly when full conformance coverage does not exist.
- When a debt count decreases, update only that count in `scripts/debt-ratchet.json` to the newly
  reported value. An increase is a regression; do not raise the baseline to make it pass.

## The gate red-proof harness

`scripts/gate-redproofs.mjs` is a gate about the gates. For each entry above it seeds exactly one
violation into a throwaway `git worktree` (system temp dir, never inside the repo) and requires the
gate to exit non-zero **and** name the seeded violation. Exit code alone is not accepted: a gate that
dies on a missing module also exits non-zero, and treating that as "the gate works" is the failure
the harness exists to catch. It also proves the other direction — a gate that is already red on a
pristine checkout makes its own red-proof vacuous — and self-tests against fixture gates
(`scripts/__fixtures__/gate-redproofs/`) so it cannot report green vacuously.

Six commits fixed guards that were green while stepping over real violations: `d87173eb`,
`54d1cc41`, `90a62902`, `a6c6e2d5`, `db31586c`, `f81a61d0`. Several proofs are written directly
against those regressions.

```bash
just gate-redproofs            # all proofs, including the cargo-dependent one
pnpm run check:gate-redproofs  # the portable set CI runs (no cargo)
```

Adding a gate means adding its red-proof in the same change. What the harness cannot prove is listed
in its own `NOT COVERED` output on every run, and untracked files are absent from the proof worktree
(it names them rather than pretending they were covered).

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
just check-debt-ratchet
just gate-redproofs
```

The `check:arch-gate` script in `package.json` owns the check list because the pinned GitLab CI
image does not include `just`. Both the root `justfile` and `.gitlab-ci.yml` call that script. When
adding or removing a gate, change only `check:arch-gate`; do not duplicate the command list in
either caller.
