# Scaffolding simplification — approved scope

Status: approved and executed (2026-08-24), then narrowed in review before merge. Follow-up to a
full inventory of the repo's standing meta-systems. The final disposition removes two systems,
removes one redundant CI path, and takes an expensive proof harness out of routine execution while
retaining the small or safety-relevant guards identified during review.

This file records **what was cut, what was narrowed, and what review deliberately kept**. The
original removals landed as one commit each on `chore/remove-meta-scaffolding`; the final review
restored the protections named below before merge.

## The re-add rule

**A removed system earns its way back only via a recurred incident.** Not a hypothetical, not a
near-miss reasoned about in review, not "it would have caught this if it had been running" — an
actual failure that reached a person. Everything below is recoverable with `git revert` (or by
lifting the file out of history), so the cost of being wrong is one command, and the cost of being
right is a permanently smaller standing surface.

Corollary: a *new* incident must argue for a new standing system rather than getting one by default.

## Final disposition

| # | Decision | Why |
|---|---|---|
| 1 | Remove `gate-redproofs` from `check:arch-gate:portable` and `prepush`, but retain the harness, fixtures, package script, and explicit `just gate-redproofs` recipe. | A gate about the gates was re-proving unchanged conclusions on every `just check` and CI `test:` job. Its evidence is still valuable when a gate changes, so the targeted command remains without the per-commit cost. |
| 2 | `spec-gaps` generator, `docs/spec/GAPS.md`, and the hand-authored closure probes | Three layers deep (gaps → probes → dead-probe meta-check) to maintain a generated index of notes that already live in the spec files. The inline `> **Gap:**` notes stay — they are the source of truth — and `rg '> \*\*Gap' docs/spec/` lists them at zero standing cost. |
| 3 | Narrow `scripts/premerge-test-parity.test.mjs`; retain its release, publishing, platform-coverage, and CI-routing contracts. Retain `scripts/typescript-script-runtime.test.mjs`. | The deleted file mixed redundant restatements with contracts that protect shipped behavior. Review removed only the former; runtime safety already had concrete failure history and is cheap to enforce. |
| 4 | Remove the CI docs-only fast path (`scripts/ci-test-scope.mjs` + its test and the fork in the mandatory `test:` job). | The full path is a strict superset, so the branch bought a few minutes on documentation MRs in exchange for a permanent way for two paths to diverge. The `test:` job now always runs full. |
| 5 | Remove `factory/`, the Obsidian parity judge harness. | The parity campaigns it existed to run are finished, and their durable output is `markdown-spec/`, which is untouched. Its operational lessons are preserved in `docs/learnings/factory-obsidian-judge.md`. |

## Explicitly kept

Not an accident of scope — each of these was considered and retained.

- **Data-safety guards.** Everything protecting the dev/prod vault split (M3), atomic writes, path
  safety, and the `FUTO_NOTES_DATA_DIR` override.
- **Shipping guards.** The release gate and its `needs`, updater signing order (M23), the
  `release-channel` and `package-safety-policy` tests.
- **All codegen and its drift checks.** `toolbar-spec`, `title-spec`, `bridge-spec`, the sync IPC
  contract — source of truth plus a `--check` mode, which is the cheap shape.
- **Conformance goldens and the full TS↔Rust differential**, including its coverage guard, known-
  divergence closure probes, and visible suppression counts. A suppression must not silently
  outlive the divergence it excuses.
- **Targeted gate red-proofs.** The harness and fixtures remain available for any gate change; only
  their membership in routine checks was removed.
- **CI and runtime safety contracts.** Release/publishing/platform-routing assertions and the
  TypeScript script-runtime regression tests remain in the minimal unit suite.
- **`markdown-spec/`** and `tests/markdown-spec.spec.ts` — the durable editor regression net.
- **The drift registry** (`scripts/drift-check.mjs`, deny-by-default).
- **Platform discipline** (`check-platform-discipline`) and **command reachability**
  (`check-command-reachability`).
- **`check-agent-docs`** — instruction surfaces are followed literally; a stale command is a real
  dead end.
- **`check-qa-input-safety`** — the M24 guard. A QA agent once drove the installed release app
  against the user's real vault.
- **`ci-cargo-cache-freshness`** — a restored cache newer than its source silently skipped a
  rebuild and shipped a stale rlib. Cheap, and it has already fired.

## Verification note

The `.gitlab-ci.yml` edits cannot be fully proven locally; the MR pipeline itself is their
verification (M13, §7.8). Everything else is covered by `just check`, `just test-rust`, the
retained configuration/runtime tests, and the targeted gate red-proofs.
