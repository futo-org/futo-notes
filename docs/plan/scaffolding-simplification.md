# Scaffolding simplification — approved scope

Status: approved and executed (2026-08-24). Follow-up to a full inventory of the repo's standing
meta-systems. The inventory's original verdict was "keep almost everything"; the decision recorded
here goes further and removes six standing systems whose cost is paid on every commit while the
failure each guards against has not recurred.

This file is the record of **what was cut, what was kept, and the rule for bringing anything back**.
The removals landed as one commit each on `chore/remove-meta-scaffolding`.

## The re-add rule

**A removed system earns its way back only via a recurred incident.** Not a hypothetical, not a
near-miss reasoned about in review, not "it would have caught this if it had been running" — an
actual failure that reached a person. Everything below is recoverable with `git revert` (or by
lifting the file out of history), so the cost of being wrong is one command, and the cost of being
right is a permanently smaller standing surface.

Corollary: a *new* incident must argue for a new standing system rather than getting one by default.

## The six cuts

| # | Removed | Why |
|---|---|---|
| 1 | `gate-redproofs` meta-gate (`scripts/gate-redproofs.mjs`, its fixtures, the `check:arch-gate:portable` membership, the `prepush` dependency) | A gate about the gates: it re-proved an unchanged conclusion on every `just check` and every CI `test:` job, running each covered gate ~3x. The failures it catches can only be introduced by editing a gate, and are visible in that same diff. |
| 2 | `spec-gaps` generator, `docs/spec/GAPS.md`, and the hand-authored closure probes | Three layers deep (gaps → probes → dead-probe meta-check) to maintain a generated index of notes that already live in the spec files. The inline `> **Gap:**` notes stay — they are the source of truth — and `rg '> \*\*Gap' docs/spec/` lists them at zero standing cost. |
| 3 | The TS↔Rust differential's closure probes | Same mechanism as #2, same reasoning: a known divergence had to carry a minimal input asserted to *still* diverge. Suppression stays (the run must not go red on the live JS/Rust `\s`-versus-`White_Space` disagreement) and so do the coverage guard and the printed suppression counts. |
| 4 | `scripts/premerge-test-parity.test.mjs`, `scripts/typescript-script-runtime.test.mjs` | Tests about the shape of the repo's own configuration rather than about behavior. Both restate what the config already says; neither has caught a regression. |
| 5 | The CI docs-only fast path (`scripts/ci-test-scope.mjs` + its test, the fork in the mandatory `test:` job) | A classifier deciding whether to run a cheaper subset. The full path is a strict superset, so the branch bought a few minutes on documentation MRs in exchange for a permanent way for the two paths to diverge (which they already did once). The `test:` job now always runs full. |
| 6 | `factory/` — the Obsidian parity judge harness | ~The largest standing system in the repo: a daemon, a CDP driver, a vault-registry dance, a visual-diff oracle, its own skill, and a DEV hook in the Svelte editor — all to compare our editor against Obsidian scenario-by-scenario. The parity campaigns it existed to run are finished, and their durable output is `markdown-spec/`, which is untouched. Its hard-won operational lessons are preserved in `docs/learnings/factory-obsidian-judge.md`. |

## Explicitly kept

Not an accident of scope — each of these was considered and retained.

- **Data-safety guards.** Everything protecting the dev/prod vault split (M3), atomic writes, path
  safety, and the `FUTO_NOTES_DATA_DIR` override.
- **Shipping guards.** The release gate and its `needs`, updater signing order (M23), the
  `release-channel` and `package-safety-policy` tests.
- **All codegen and its drift checks.** `toolbar-spec`, `title-spec`, `bridge-spec`, the sync IPC
  contract — source of truth plus a `--check` mode, which is the cheap shape.
- **Conformance goldens and the TS↔Rust differential** (minus the closure probes above), including
  its coverage guard and visible suppression counts.
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

The `.gitlab-ci.yml` edits (cuts 2 and 5) cannot be fully proven locally; the MR pipeline itself is
their verification (M13, §7.8). Everything else is covered by `just check`, `just test-rust`, and
the targeted gates, each recorded in its commit's `Verified:` line.
