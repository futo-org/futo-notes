---
name: burndown
description: Reduce one recorded debt-ledger entry per run and ship it as a small reviewable MR. Use when the user says "burndown", "burn down some debt", "pay down debt", "run the debt sweep", or on a schedule. Targets come only from checked-in drift entries, allowlists, or spec gaps — never from vibes. Also supports a read-only ranking mode ("burndown report") that proposes the next target without changing anything.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Burndown

One run = **one ledger entry** reduced, shipped as **one small MR**. Never a sweep, never a
refactor tour. Explicit ledgers keep selection objective; their owning gates reject stale entries.

## Modes

- **`report`** (also when invoked as `/burndown report` or from a scheduled run): read-only.
  Rank the current targets, estimate each one's blast radius, and print the recommended next
  target with the file list it would touch. Change nothing.
- **default**: execute exactly one target end-to-end (fix → verify → MR).

## Target selection (deterministic — walk this list in order, take the first actionable hit)

1. **`scripts/drift-registry.json` entries with `lockStatus: "unlocked"`, then `"partial"`** —
   either consolidate the duplicate copies down to one owner, or add the missing lock (a
   reviewed conformance fixture, a generated spec, or a cross-language differential test,
   like `validate-server-url`'s), then upgrade `lockStatus` in the same commit.
   Before considering an entry, read its `description` and `note` metadata. Skip entries whose
   metadata says the duplication is deliberately accepted, prose-only, or must not be unified or
   locked. Those entries document an intentional exception; they are not actionable debt.
2. **`scripts/platform-discipline-allowlist.json` and `scripts/command-reachability-allowlist.json`
   entries** — each allowlist is itself a ratchet aimed at zero (its `_comment` says so). Burning
   one down means moving the direct `@tauri-apps` access behind the owning shim
   (`src/lib/platform/`, `syncServiceE2ee.ts`, or `localNoteStore.ts`), or deleting a command that
   has no caller, then removing the entry in the same commit — the gates fail on a stale entry, so
   the ledger update is not optional.
3. **Inline Gap entries indexed by `docs/spec/GAPS.md`** — only when the gap names a
   local, behavior-preserving fix that fits the diff cap. Close the inline source note, run
   `just spec-gaps`, and commit the regenerated index in the same change.

A `--target <name>` argument (a drift-registry concept, an allowlist entry's path, or a spec-gap
anchor) overrides the walk,
but not the eligibility rules above. Reject `--target notes-root-triplet` with a read-only report;
it is an intentional M3 exception, not an actionable target.

## Hard limits

- **Never touch** anything on AGENTS.md's stop-and-ask list: `keys/`, hash/crypto functions,
  the dev bundle-id / `fake-notes` notes-root guards, push-first sync, `release:gate.needs`,
  the dep-guard. `notes-root-triplet` is a deliberately accepted, prose-only M3 duplication:
  never select it automatically or by `--target`, and never consolidate, lock, or weaken its
  copies. Return a read-only report explaining the rejection.
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
3. Make the fix. Update the owning ledger in the SAME commit — upgrade the drift-registry
   `lockStatus`, remove the allowlist entry, or close the inline spec gap.
4. Verify: `just check-drift` + `just spec-gaps-check` + the testing chain AGENTS.md
   prescribes for the touched layer (at minimum `just build` for TS, `just test-rust` for model
   rules, the owning crate's tests for other Rust). A drift-registry lock added without a test
   that would actually fail on divergence is not a lock.
5. Commit as `chore(<scope>): ...` or `refactor(<scope>): ...` with a body naming the ledger
   entry ("locks `sort-tiebreaker-modified-id`" or "removes `<path>` from the platform
   allowlist") and a verification line.
6. Push and open a non-draft MR. The MR body: which ledger entry, before→after ledger state,
   verification commands + results. Small enough to review in minutes — that's the contract.

## Scheduled use

A recurring job should run `report` mode only and post the ranked pick for a human to approve;
the mutating mode is for an interactive session that can respond to review.
