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
| Android bridge spec  | `packages/editor/src/bridge.ts` and generated `BridgeSpec.kt`                                                              | The generated Android message types or bridge version are stale; run `just bridge-spec` and commit the result                                 |
| Drift registry       | Copies, locks, and optional scan patterns in `scripts/drift-registry.json`                                                 | A registered copy or lock disappeared, a detection pattern became stale, lock status is inconsistent, or a scan finds a new unregistered copy |
| Debt ratchet         | Current source/spec/registry counts and `scripts/debt-ratchet.json`                                                        | Debt increased, or debt decreased without lowering the checked-in baseline in the same change                                                 |

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

## Scope and limits

These gates are structural source scans, not proofs of runtime behavior. Command reachability
recognizes literal `invoke("name")` calls. Drift detection only discovers new copies for concepts
with a suitable registered scan pattern. The bridge-spec gate proves that Android's generated
contract is current; Android unit tests separately check handler coverage, and behavioral tests
remain responsible for handler correctness.

The individual recipes remain available for focused diagnosis:

```bash
just check-command-reachability
just check-platform-discipline
just bridge-spec-check
just check-drift
just check-debt-ratchet
```

The `check:arch-gate` script in `package.json` owns the check list because the pinned GitLab CI
image does not include `just`. Both the root `justfile` and `.gitlab-ci.yml` call that script. When
adding or removing a gate, change only `check:arch-gate`; do not duplicate the command list in
either caller.
