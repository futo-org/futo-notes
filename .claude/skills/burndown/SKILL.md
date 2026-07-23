---
name: burndown
description: Reduce one recorded debt-ledger entry per run and ship it as a small reviewable MR. Use when the user says "burndown", "burn down some debt", "pay down debt", "run the debt sweep", or on a schedule. Targets come only from the checked-in ledgers (debt-ratchet counts, unlocked drift-registry entries, the AGENTS.md drift watchlist) — never from vibes. Also supports a read-only ranking mode ("burndown report") that proposes the next target without changing anything.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Burndown

One run = **one ledger entry** reduced, shipped as **one small MR**. Never a sweep, never a
refactor tour. The point is a steady one-way ratchet: `scripts/debt-ratchet.mjs` blocks new debt;
this skill is the mechanism that drives the existing counts toward zero.

## Modes

- **`report`** (also when invoked as `/burndown report` or from a scheduled run): read-only.
  Rank the current targets, estimate each one's blast radius, and print the recommended next
  target with the file list it would touch. Change nothing.
- **default**: execute exactly one target end-to-end (fix → verify → MR).

## Target selection (deterministic — walk this list in order, take the first actionable hit)

1. **`scripts/debt-ratchet.json` counts > 0**, smallest count first (smallest = most likely to
   reach zero in one reviewable MR — retiring a count entirely is worth more than shaving a big
   one). Recompute-first: run `node scripts/debt-ratchet.mjs` to see the live numbers; the
   recompute logic in that script tells you where each counted instance lives.
   - `invokeCallsOutsideShims` / `tauriImportsOutsideShims`: move the call behind the owning shim
     (`src/lib/platform/`, `syncServiceE2ee.ts`, or `localNoteStore.ts`) and shrink the allowlist.
   - `specGapsCount`: closing a spec gap is feature work, NOT burndown — skip this count unless
     the gap note itself says the behavior already shipped (then it's a spec edit: follow
     `/spec-sync`).
   - `unlockedDriftRegistryEntries`: handled by rule 2 below.
2. **`scripts/drift-registry.json` entries with `lockStatus: "unlocked"`, then `"partial"`** —
   either consolidate the duplicate copies down to one owner, or add the missing lock (a
   conformance fixture, a generated spec, or a cross-language test that reads a shared fixture,
   like `validate-server-url`'s), then upgrade `lockStatus` in the same commit.
3. **The "not locked — real drift risk" list in AGENTS.md's drift watchlist** for anything not
   already covered by rule 2.

A `--target <name>` argument (a ratchet count key or drift-registry concept) overrides the walk.

## Hard limits

- **Never touch** anything on AGENTS.md's stop-and-ask list: `keys/`, hash/crypto functions,
  the dev bundle-id / `fake-notes` notes-root guards, push-first sync, `release:gate.needs`,
  the dep-guard. If the walk lands on one of these (e.g. `notes-root-triplet` — its copies ARE
  a CRITICAL guard), locking it via a shared fixture + tests is allowed, but consolidating or
  weakening any copy is not; when in doubt, report instead of editing.
- **Diff cap ~300 changed lines** (excluding regenerated files and lockfiles). If the fix
  outgrows the cap mid-work, shrink the scope to a self-contained slice or abandon the edit and
  emit a report explaining what it would take.
- **Existing structure only.** If the target turns out to need a behavior change, a protocol
  change, or new module boundaries, stop and report — that's an issue or a planned MR, not
  burndown.
- This skill makes repository modifications: complete the modifying-agent reading required by
  AGENTS.md (`docs/architecture/codebase-organization.md` + the nested `AGENTS.md` of every layer
  touched) before editing.

## Execution

1. Pick the target (above). State which ledger entry it is and why it won the walk.
2. Branch from up-to-date `main`: `chore/burndown-<slug>`.
3. Make the fix. Update the ledger in the SAME commit — decrement the ratchet count, or upgrade
   the drift-registry `lockStatus` (both gates fail otherwise, by design).
4. Verify: `node scripts/debt-ratchet.mjs` + `just check-drift` + the testing chain AGENTS.md
   prescribes for the touched layer (at minimum `just build` for TS, `just test-rust` for model
   rules, the owning crate's tests for other Rust). A drift-registry lock added without a test
   that would actually fail on divergence is not a lock.
5. Commit as `chore(<scope>): ...` or `refactor(<scope>): ...` with a body naming the ledger
   entry ("burns down `invokeCallsOutsideShims` 2→0") and a verification line.
6. Push and open a non-draft MR. The MR body: which ledger entry, before→after ledger state,
   verification commands + results. Small enough to review in minutes — that's the contract.

## Scheduled use

A recurring job should run `report` mode only and post the ranked pick for a human to approve;
the mutating mode is for an interactive session that can respond to review.
